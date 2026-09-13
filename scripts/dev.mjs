import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";

export function createDevServerConfig(interfaces, port = "5173") {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => ({ name, address: address.address })),
  );

  const netbird =
    candidates.find(({ name }) => /^(wt|wg|netbird)/i.test(name)) ??
    candidates.find(({ address }) => address.startsWith("100."));

  return {
    hostname: "0.0.0.0",
    port,
    localUrl: `http://localhost:${port}`,
    netbirdUrl: netbird ? `http://${netbird.address}:${port}` : undefined,
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
  const config = createDevServerConfig(
    networkInterfaces(),
    process.env.CUPBOARD_PORT ?? "5173",
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
