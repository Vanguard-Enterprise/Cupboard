import { execFileSync, spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";

export function findNetBirdAddress(interfaces, statusJson) {
  if (statusJson) {
    try {
      const netbirdIp = JSON.parse(statusJson).netbirdIp;

      if (typeof netbirdIp === "string" && netbirdIp.length > 0) {
        return netbirdIp.split("/", 1)[0];
      }
    } catch {
      // Fall back to NetBird's standard interface names.
    }
  }

  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => ({ name, address: address.address })),
  );

  return candidates.find(({ name }) => /^(?:wt\d+|netbird\d*)$/i.test(name))
    ?.address;
}

export function createDevServerConfig(interfaces, port = "5173", statusJson) {
  const netbirdAddress = findNetBirdAddress(interfaces, statusJson);

  return {
    hostname: "0.0.0.0",
    port,
    localUrl: `http://localhost:${port}`,
    netbirdUrl: netbirdAddress ? `http://${netbirdAddress}:${port}` : undefined,
  };
}

export function createNextDevArgs({ hostname, port }) {
  return [
    "./node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    hostname,
    "--port",
    port,
  ];
}

function start() {
  let netbirdStatus;

  try {
    netbirdStatus = execFileSync("netbird", ["status", "--json"], {
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    // NetBird may be unavailable; interface detection remains as a fallback.
  }

  const config = createDevServerConfig(
    networkInterfaces(),
    process.env.CUPBOARD_PORT ?? "5173",
    netbirdStatus,
  );

  console.log("\nCupboard development server");
  console.log(`  Local:   ${config.localUrl}`);
  console.log(
    config.netbirdUrl
      ? `  NetBird: ${config.netbirdUrl}`
      : "  NetBird: unavailable; no active NetBird interface was found",
  );
  console.log(
    "\nNext.js hot reloading is enabled on all network interfaces.\n",
  );

  const next = spawn(process.execPath, createNextDevArgs(config), {
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => next.kill(signal));
  }

  next.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start();
}
