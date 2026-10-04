import { describe, expect, it } from "vitest";
import {
  createDevServerConfig,
  developmentSessionCookieName,
  createNextDevArgs,
  findNetBirdAddress,
} from "./dev.mjs";

const address = (value) => ({
  address: value,
  family: "IPv4",
  internal: false,
  netmask: "255.255.255.0",
  cidr: `${value}/24`,
  mac: "00:00:00:00:00:00",
});

describe("development server configuration", () => {
  it("binds Next.js to every interface on the default port", () => {
    const config = createDevServerConfig({});

    expect(config).toMatchObject({
      hostname: "0.0.0.0",
      port: "5173",
      localUrl: "http://localhost:5173",
      netbirdUrl: undefined,
      allowedDevOrigins: [],
    });
    expect(createNextDevArgs(config)).toEqual([
      "./node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "0.0.0.0",
      "--port",
      "5173",
    ]);
  });

  it("prints the named NetBird interface URL with a custom port", () => {
    const config = createDevServerConfig(
      {
        eth0: [address("100.64.0.2")],
        wt0: [address("100.107.41.153")],
      },
      "6000",
    );

    expect(config.netbirdUrl).toBe("http://100.107.41.153:6000");
    expect(config.allowedDevOrigins).toEqual(["100.107.41.153"]);
  });

  it("prefers the address reported by the NetBird daemon", () => {
    const config = createDevServerConfig(
      { wt0: [address("100.80.0.3")] },
      "5173",
      JSON.stringify({ netbirdIp: "100.107.41.153/16" }),
    );

    expect(config.netbirdUrl).toBe("http://100.107.41.153:5173");
  });

  it("does not label unrelated WireGuard or 100.x interfaces as NetBird", () => {
    const interfaces = {
      wg0: [address("100.64.0.1")],
      eth0: [address("100.107.41.153")],
    };

    expect(findNetBirdAddress(interfaces)).toBeUndefined();
  });
});

it("stops the web server and exits nonzero when the API fails", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "cupboard-dev-exit-"));
  const pidFile = join(dir, "web-pid");
  let webPid;
  try {
    await mkdir(join(dir, "bin"));
    await mkdir(join(dir, "target/debug"), { recursive: true });
    await mkdir(join(dir, "node_modules/next/dist/bin"), { recursive: true });
    for (const [file, body] of [
      ["bin/cargo", "process.exit(0)"],
      ["bin/netbird", "process.exit(1)"],
      ["target/debug/cupboard", "setTimeout(() => process.exit(1), 100)"],
    ])
      await writeFile(join(dir, file), `#!/usr/bin/env node\n${body}\n`, {
        mode: 0o755,
      });
    await writeFile(
      join(dir, "node_modules/next/dist/bin/next"),
      "require('fs').writeFileSync(process.env.WEB_PID, String(process.pid)); setInterval(() => {}, 1000)",
    );
    const run = promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./dev.mjs", import.meta.url))],
      {
        cwd: dir,
        env: {
          ...process.env,
          DATABASE_URL: "unused-test-database",
          CUPBOARD_S3_BUCKET: "unused-test-bucket",
          WEB_PID: pidFile,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        },
        timeout: 4000,
      },
    );
    await expect(run).rejects.toMatchObject({ code: 1, killed: false });
    webPid = Number(await readFile(pidFile, "utf8"));
    await expect
      .poll(() => {
        try {
          process.kill(webPid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    if (!webPid)
      webPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (webPid) {
      try {
        process.kill(webPid, "SIGKILL");
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(
  ["SIGINT", "SIGTERM"].flatMap((signal) =>
    ["database", "storage", "build", "serve"].map((phase) => ({
      signal,
      phase,
    })),
  ),
)("shuts down cleanly on $signal during $phase", async ({ signal, phase }) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "cupboard-dev-stop-"));
  const pidFiles = ["database", "storage", "build", "serve", "web"].map(
    (name) => join(dir, `${name}-pid`),
  );
  const wait = "setInterval(() => {}, 1000)";
  const record = (name) =>
    `require('fs').writeFileSync(require('path').join(process.env.TEST_PID_DIR, '${name}-pid'), String(process.pid));`;
  let run;
  try {
    await mkdir(join(dir, "bin"));
    await mkdir(join(dir, "target/debug"), { recursive: true });
    await mkdir(join(dir, "node_modules/next/dist/bin"), { recursive: true });
    for (const [file, body] of [
      ["bin/netbird", "process.exit(1)"],
      [
        "bin/docker",
        record(phase === "storage" ? "storage" : "database") +
          "process.on('SIGTERM', () => process.exit(0));" +
          wait,
      ],
      [
        "bin/cargo",
        phase === "build" ? record("build") + wait : "process.exit(0)",
      ],
      ["target/debug/cupboard", record("serve") + wait],
      ["node_modules/next/dist/bin/next", record("web") + wait],
    ])
      await writeFile(join(dir, file), `#!/usr/bin/env node\n${body}\n`, {
        mode: 0o755,
      });
    run = promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./dev.mjs", import.meta.url))],
      {
        cwd: dir,
        env: {
          ...process.env,
          DATABASE_URL: phase === "database" ? "" : "unused-test-database",
          CUPBOARD_S3_BUCKET: phase === "storage" ? "" : "unused-test-bucket",
          TEST_PID_DIR: dir,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        },
        timeout: 4000,
      },
    );
    // Attach immediately so an unexpected early failure is handled during polling.
    const outcome = run.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await expect
      .poll(async () =>
        Number(
          await readFile(join(dir, `${phase}-pid`), "utf8").catch(() => "0"),
        ),
      )
      .toBeGreaterThan(0);
    if (phase !== "database" && phase !== "storage")
      await expect
        .poll(async () =>
          Number(await readFile(join(dir, "web-pid"), "utf8").catch(() => "0")),
        )
        .toBeGreaterThan(0);
    run.child.kill(signal);
    const result = await outcome;
    expect(result.error).toBeUndefined();
    expect(result.value.stderr).toBe("");
    for (const path of pidFiles) {
      const pid = Number(await readFile(path, "utf8").catch(() => "0"));
      if (!pid) continue;
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    }
    if (phase !== "serve")
      expect(
        await readFile(join(dir, "serve-pid"), "utf8").catch(() => ""),
      ).toBe("");
  } finally {
    run?.child.kill("SIGKILL");
    for (const path of pidFiles) {
      const pid = Number(await readFile(path, "utf8").catch(() => "0"));
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses stable, distinct session cookie names for development worktrees", () => {
  const first = developmentSessionCookieName("cupboard-dev-1234abcd");
  expect(first).toBe("cupboard_session_cupboard_dev_1234abcd");
  expect(developmentSessionCookieName("cupboard-dev-1234abcd")).toBe(first);
  expect(developmentSessionCookieName("cupboard-dev-abcd1234")).not.toBe(first);
});
