#!/usr/bin/env python3
"""Cupboard Linux health agent. Requires Python 3.10+ and outbound HTTPS."""
import argparse
import getpass
import json
import ipaddress
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.2.0"
DEFAULT_CONFIG = Path.home() / ".config/cupboard-agent/credential.json"


class AgentError(Exception):
    pass


class Unauthorized(AgentError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AgentError("Redirect refused. Use the final HTTPS address for Cupboard.")


def validate_url(value):
    url = urllib.parse.urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.path not in ("", "/") or url.query or url.fragment):
        raise AgentError("Use a Cupboard HTTPS origin, such as https://cupboard.example.com.")
    return value.rstrip("/")


def request(url, path, token, body):
    validate_url(url)
    if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{64}", token):
        raise AgentError("Invalid credential format. Enroll the agent again.")
    req = urllib.request.Request(
        url + "/node-api/" + path,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        # Default TLS validation remains enabled; redirects never receive credentials.
        with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
            raw = response.read(8193)
            if len(raw) > 8192:
                raise AgentError("Cupboard returned an invalid response.")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise AgentError("Cupboard returned an invalid response.")
            return result
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise Unauthorized("Credential rejected. Create a new enrollment token and enroll again.") from None
        raise AgentError("Cupboard rejected the report. Check the server and agent version.") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise AgentError("Cannot reach Cupboard securely. Check HTTPS and network access.") from None


def save_config(path, config):
    path = Path(path).expanduser()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = path.parent.stat()
    if parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
        raise AgentError("The credential directory must be owned by this user and not writable by others.")
    name = None
    try:
        fd, name = tempfile.mkstemp(dir=path.parent, prefix=".credential-")
        with os.fdopen(fd, "w") as handle:
            json.dump(config, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def read_config(path):
    fd = os.open(Path(path).expanduser(), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise AgentError("Credential file must be owned by this user with permissions 0600.")
        config = json.load(handle)
    validate_url(config["url"])
    return config


class CountryLookup:
    def __init__(self):
        self.next_lookup = 0
        self.value = None

    def get(self):
        now = time.monotonic()
        if now < self.next_lookup:
            return self.value
        self.next_lookup = now + 3600
        self.value = None
        try:
            # No Cupboard credential, hostname, or machine metadata leaves this host.
            req = urllib.request.Request("https://ipwho.is/?fields=success,ip,country_code")
            with urllib.request.build_opener(NoRedirect).open(req, timeout=3) as response:
                raw = response.read(4097)
                if len(raw) > 4096:
                    return None
                result = json.loads(raw)
            if not isinstance(result, dict) or result.get("success") is not True:
                return None
            address = ipaddress.ip_address(result.get("ip", ""))
            country = result.get("country_code", "")
            if (address.is_global and not address.is_multicast
                    and isinstance(country, str) and re.fullmatch(r"[A-Z]{2}", country)):
                self.value = {"publicIp": str(address), "countryCode": country}
        except (AgentError, urllib.error.URLError, OSError, ValueError, TypeError):
            pass
        return self.value


def cpu_times():
    values = [int(value) for value in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
    # Guest time is already included in user/nice; do not count it twice.
    return sum(values), values[3] + values[4]


def cpu_usage():
    total_before, idle_before = cpu_times()
    time.sleep(0.2)
    total_after, idle_after = cpu_times()
    elapsed = total_after - total_before
    if elapsed <= 0:
        return None
    return round(max(0, min(100, 100 * (1 - (idle_after - idle_before) / elapsed))), 1)



class NetworkRates:
    """Average traffic across non-loopback interfaces between reports."""
    def __init__(self):
        self.previous = None

    def sample(self):
        counters = {}
        for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
            name, values = line.split(":", 1)
            if name.strip() != "lo":
                fields = values.split()
                counters[name.strip()] = (int(fields[0]), int(fields[8]))
        now = time.monotonic()
        previous, self.previous = self.previous, (now, counters)
        empty = {"networkReceiveBytesPerSecond": None, "networkSendBytesPerSecond": None}
        if previous is None or now <= previous[0] or counters.keys() != previous[1].keys():
            return empty
        deltas = [tuple(value[i] - previous[1][name][i] for i in range(2))
                  for name, value in counters.items()]
        if any(value < 0 for delta in deltas for value in delta):
            return empty
        elapsed = now - previous[0]
        return dict(zip(empty, (round(sum(d[i] for d in deltas) / elapsed, 1) for i in range(2))))

def health():
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        memory[key] = int(value.strip().split()[0]) * 1024
    disk = shutil.disk_usage("/")
    return {
        "hostname": platform.node()[:200],
        "os": (platform.system() + " " + platform.release())[:200],
        "agentVersion": VERSION,
        "cpuCount": os.cpu_count() or 1,
        "loadOne": os.getloadavg()[0],
        "cpuUsagePercent": cpu_usage(),
        "memoryTotalBytes": memory["MemTotal"],
        "memoryAvailableBytes": min(memory["MemAvailable"], memory["MemTotal"]),
        "diskTotalBytes": disk.total,
        "diskAvailableBytes": disk.free,
        "uptimeSeconds": int(float(Path("/proc/uptime").read_text().split()[0])),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    commands = parser.add_subparsers(dest="command", required=True)
    enroll = commands.add_parser("enroll", help="Exchange a single-use enrollment token")
    enroll.add_argument("--url", required=True)
    commands.add_parser("run", help="Report health every 30 seconds")
    commands.add_parser("once", help="Send one health report")
    args = parser.parse_args()
    try:
        if platform.system() != "Linux":
            raise AgentError("This agent supports Linux machines.")
        if args.command == "enroll":
            url = validate_url(args.url)
            # Prompt instead of argv or environment to keep tokens out of history/process listings.
            token = getpass.getpass("Enrollment token: ").strip()
            result = request(url, "enroll", token, {})
            credential = result.get("credential", "")
            if not re.fullmatch(r"[0-9a-f]{64}", credential):
                raise AgentError("Cupboard returned an invalid credential. Enroll again.")
            save_config(args.config, {"url": url, "credential": credential})
            print("Agent enrolled. Credential saved with private file permissions.")
            return 0
        config = read_config(args.config)
        country = CountryLookup()
        network = NetworkRates()
        while True:
            try:
                report = health()
                report.update(network.sample())
                report["geolocation"] = country.get()
                request(config["url"], "heartbeat", config["credential"], report)
                if args.command == "once":
                    print("Health report accepted.")
                    return 0
            except Unauthorized:
                raise
            except (AgentError, OSError, ValueError, KeyError):
                if args.command == "once":
                    raise AgentError("Health report failed. Check HTTPS, network access, and Linux health files.") from None
                print("Health report failed. Retrying in 30 seconds.", flush=True)
            time.sleep(30)
    except Unauthorized as error:
        print(str(error), flush=True)
        return 2
    except AgentError as error:
        print(str(error), flush=True)
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        print("Agent setup failed. Check the private credential file and Linux health files.", flush=True)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
