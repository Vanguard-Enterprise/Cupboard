import { execFileSync } from "node:child_process";
import { startRustDev } from "./rust-dev.mjs";
import { createProcesses } from "./processes.mjs";
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
    allowedDevOrigins: netbirdAddress ? [netbirdAddress] : [],
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

async function start() {
  const processes = createProcesses();
  let rust;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      rust?.stop();
      processes.stop();
    });
  }
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
    "\nNext.js hot reloading and automatic Rust rebuilds are enabled.\n",
  );

  try {
    if (!process.env.DATABASE_URL) {
      await processes.run("docker", [
        "compose",
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "60",
        "postgres",
      ]);
    }
    const env = {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ??
        `postgres://cupboard:cupboard-local-only@127.0.0.1:${process.env.CUPBOARD_DB_PORT ?? "55432"}/cupboard`,
      CUPBOARD_API_URL:
        process.env.CUPBOARD_API_URL ??
        `http://127.0.0.1:${(process.env.CUPBOARD_API_BIND ?? "0.0.0.0:8080").split(":").at(-1)}`,
      CUPBOARD_WEB_ORIGINS:
        process.env.CUPBOARD_WEB_ORIGINS ??
        [config.localUrl, `http://127.0.0.1:${config.port}`, config.netbirdUrl]
          .filter(Boolean)
          .join(","),
      CUPBOARD_INSECURE_COOKIES: "1",
      CUPBOARD_DEV_ORIGINS: config.allowedDevOrigins.join(","),
    };
    rust = startRustDev({ env });
    await Promise.race([
      rust.done,
      processes.run(process.execPath, createNextDevArgs(config), env),
    ]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    rust?.stop();
    processes.stop();
    // The race above reports watcher failure; still wait for its cleanup.
    await rust?.done.catch(() => {});
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start();
}
