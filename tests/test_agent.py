import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("agent", Path(__file__).parents[1] / "public/agent/cupboard-agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    def test_country_lookup_is_cached_and_never_sends_credentials(self):
        with patch.object(agent.urllib.request, "build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.read.return_value = b'{"success":true,"ip":"8.8.8.8","country_code":"US"}'
            lookup = agent.CountryLookup()
            self.assertEqual(lookup.get(), {"publicIp":"8.8.8.8", "countryCode":"US"})
            self.assertEqual(lookup.get()["countryCode"], "US")
            opener.return_value.open.assert_called_once()
            req = opener.return_value.open.call_args.args[0]
            self.assertTrue(req.full_url.startswith("https://ipwho.is/"))
            self.assertIsNone(req.get_header("Authorization"))
            self.assertIsNone(req.data)

    def test_failed_country_lookup_does_not_block_reporting(self):
        with patch.object(agent.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = TimeoutError()
            self.assertIsNone(agent.CountryLookup().get())
        for payload in [b'{"success":false}', b'{"success":true,"ip":"10.0.0.1","country_code":"US"}', b'[]', b'x' * 4097]:
            with patch.object(agent.urllib.request, "build_opener") as opener:
                opener.return_value.open.return_value.__enter__.return_value.read.return_value = payload
                self.assertIsNone(agent.CountryLookup().get())

    def test_network_rates_handle_first_report_resets_and_interface_changes(self):
        def counters(rx, tx, name="eth0"):
            return "header\nheader\n lo: 9999 0 0 0 0 0 0 0 9999\n " + name + ": " + str(rx) + " 0 0 0 0 0 0 0 " + str(tx)
        with patch.object(agent.Path, "read_text", side_effect=[
            counters(100,200), counters(3100,6200), counters(0,0), counters(300,600,"eth1")
        ]), patch.object(agent.time, "monotonic", side_effect=[0,30,60,90]):
            rates = agent.NetworkRates()
            self.assertIsNone(rates.sample()["networkReceiveBytesPerSecond"])
            self.assertEqual(rates.sample(), {"networkReceiveBytesPerSecond":100.0,"networkSendBytesPerSecond":200.0})
            self.assertIsNone(rates.sample()["networkReceiveBytesPerSecond"])
            self.assertIsNone(rates.sample()["networkSendBytesPerSecond"])

    def test_cpu_usage_uses_counter_delta(self):
        with patch.object(agent, "cpu_times", side_effect=[(100, 40), (200, 115)]), patch.object(agent.time, "sleep"):
            self.assertEqual(agent.cpu_usage(), 25.0)

    def test_requires_https_without_embedded_credentials_or_redirects(self):
        for url in ["http://host", "https://user:secret@host", "https://host/path", "https://host/?token=secret", "https://host/#secret"]:
            with self.assertRaises(agent.AgentError):
                agent.validate_url(url)
        self.assertEqual(agent.validate_url("https://cupboard.example.com/"), "https://cupboard.example.com")
        with self.assertRaises(agent.AgentError):
            agent.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.example")

    def test_credentials_are_private_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private/credential.json"
            config = {"url": "https://cupboard.example.com", "credential": "a" * 64}
            agent.save_config(path, config)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(agent.read_config(path), config)
            path.chmod(0o644)
            with self.assertRaises(agent.AgentError):
                agent.read_config(path)
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                agent.read_config(link)

    def test_health_reports_real_host_values_without_environment_secrets(self):
        with patch.dict(os.environ, {"PRIVATE_SECRET": "never-report-this"}):
            report = agent.health()
        self.assertGreater(report["memoryTotalBytes"], 0)
        self.assertLessEqual(report["memoryAvailableBytes"], report["memoryTotalBytes"])
        self.assertGreater(report["diskTotalBytes"], 0)
        self.assertGreater(report["cpuCount"], 0)
        self.assertNotIn("never-report-this", json.dumps(report))

    def test_authentication_failure_stops_reports_without_exposing_credential(self):
        error = agent.urllib.error.HTTPError("https://host", 401, "secret", {}, None)
        with patch.object(agent.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaises(agent.Unauthorized) as caught:
                agent.request("https://host", "heartbeat", "a" * 64, {})
        self.assertNotIn("a" * 64, str(caught.exception))
        self.assertNotIn("secret", str(caught.exception))

    def test_request_uses_bearer_and_does_not_follow_redirects(self):
        with patch.object(agent.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value.__enter__.return_value.read.return_value = b'{"accepted": true}'
            self.assertEqual(agent.request("https://host", "heartbeat", "b" * 64, {"uptimeSeconds": 3}), {"accepted": True})
            opener.assert_called_once_with(agent.NoRedirect)
            req = opener.return_value.open.call_args.args[0]
            self.assertEqual(req.get_header("Authorization"), "Bearer " + "b" * 64)
            self.assertNotIn("b" * 64, req.full_url)
            self.assertEqual(json.loads(req.data), {"uptimeSeconds": 3})


if __name__ == "__main__":
    unittest.main()
