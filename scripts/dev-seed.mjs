import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  databasePort,
  readWorkspace,
  workspaceIdentity,
} from "./workspace.mjs";

export function assertSeedEnvironment(env) {
  if (
    env.NODE_ENV === "production" ||
    env.DATABASE_URL ||
    env.CUPBOARD_TEST_DATABASE_URL
  )
    throw new Error(
      "Dev seeding refuses production and external database overrides.",
    );
}
export function ownedDatabase(inspect, project, cwd) {
  const labels = inspect.Config?.Labels ?? {};
  if (
    !inspect.State?.Running ||
    labels["com.docker.compose.project"] !== project ||
    labels["com.docker.compose.service"] !== "postgres" ||
    labels["com.docker.compose.project.working_dir"] !== cwd
  )
    throw new Error(
      "Dev seeding requires this worktree's running Compose PostgreSQL.",
    );
  const bindings = inspect.NetworkSettings?.Ports?.["5432/tcp"];
  if (bindings?.length !== 1 || bindings[0].HostIp !== "127.0.0.1")
    throw new Error("Dev seeding requires loopback-only PostgreSQL.");
  return databasePort(`127.0.0.1:${bindings[0].HostPort}`);
}
export function validateAccount(account, project) {
  if (
    account.version !== 1 ||
    account.workspace !== project ||
    !/^[a-f0-9-]{36}$/.test(account.accountId ?? "") ||
    !/^[a-f0-9-]{36}$/.test(account.organizationId ?? "") ||
    account.email !== `dev-${account.accountId}@example.test` ||
    typeof account.password !== "string" ||
    account.password.length < 16 ||
    account.password.length > 128
  )
    throw new Error(
      "Invalid dev account file or different worktree; no data changed.",
    );
  return account;
}
/**
 * Example servers listen on 10000-19999: below Linux's ephemeral ports
 * (32768 and up) and the dev stack's web (20000+) and API (40000+) ports.
 */
export const EXAMPLE_PORTS = [10000, 19999];
const inExampleRange = (port) =>
  Number.isInteger(port) &&
  port >= EXAMPLE_PORTS[0] &&
  port <= EXAMPLE_PORTS[1];
/** Distinct random ports, one RCON and one query port per server. */
function examplePorts(count) {
  const ports = new Set();
  const span = EXAMPLE_PORTS[1] - EXAMPLE_PORTS[0] + 1;
  while (ports.size < count)
    ports.add(EXAMPLE_PORTS[0] + (randomBytes(2).readUInt16BE() % span));
  return [...ports];
}
/** Gives a saved fleet new ports when any lie outside the example range. */
export function withExamplePorts(fleet) {
  if (
    fleet.servers.every(
      (s) => inExampleRange(s.rconPort) && inExampleRange(s.a2sPort),
    )
  )
    return fleet;
  const ports = examplePorts(fleet.servers.length * 2);
  return {
    ...fleet,
    servers: fleet.servers.map((server, i) => ({
      ...server,
      rconPort: ports[i * 2],
      a2sPort: ports[i * 2 + 1],
    })),
  };
}
/**
 * Example game servers and machines, saved once per worktree so their ids,
 * ports, and credentials stay stable across seeds. `scripts/dev-fleet.mjs`
 * plays them; behaviors are in its SERVER_BEHAVIORS and MACHINE_BEHAVIORS.
 */
export function exampleFleet() {
  const ports = examplePorts(8);
  const server = (name, behavior, maxPlayers) => ({
    id: randomUUID(),
    name,
    behavior,
    maxPlayers,
    rconPort: ports.pop(),
    a2sPort: ports.pop(),
  });
  const machine = (name, behavior, address, provider, tags) => ({
    id: randomUUID(),
    credential: randomBytes(32).toString("hex"),
    name,
    behavior,
    address,
    provider,
    tags,
  });
  return {
    rconPassword: randomBytes(16).toString("hex"),
    servers: [
      server("Rust EU Main", "busy", 150),
      server("Rust US Vanilla", "steady", 100),
      server("Rust EU Modded", "rcon-rejects", 100),
      server("Rust AU Weekly", "offline", 100),
    ],
    machines: [
      machine("eu-game-01", "steady", "203.0.113.21", "Hetzner", [
        "wings",
        "game-server",
      ]),
      machine("us-game-01", "busy", "203.0.113.42", "OVHcloud", [
        "wings",
        "game-server",
      ]),
      machine("db-01", "database", "198.51.100.10", "Hetzner", ["database"]),
      machine("backup-01", "silent", "198.51.100.20", "Hetzner", ["backups"]),
    ],
  };
}
export function seedWorkspace(cwd = process.cwd()) {
  assertSeedEnvironment(process.env);
  const workspace = readWorkspace(cwd);
  if (!workspace)
    throw new Error("Run npm run dev first to prepare this worktree.");
  const project = workspaceIdentity(cwd);
  const container = execFileSync(
    "docker",
    ["compose", "--project-name", project, "ps", "--quiet", "postgres"],
    { cwd, encoding: "utf8" },
  ).trim();
  if (!container)
    throw new Error("Run npm run dev first to start the managed database.");
  const [inspect] = JSON.parse(
    execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
  );
  const port = ownedDatabase(inspect, project, cwd);
  const path = join(cwd, ".dev-stack/dev-account.json");
  let account;
  try {
    account = validateAccount(JSON.parse(readFileSync(path, "utf8")), project);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const accountId = randomUUID();
    account = {
      version: 1,
      workspace: project,
      accountId,
      organizationId: randomUUID(),
      email: `dev-${accountId}@example.test`,
      password: randomBytes(24).toString("base64url"),
      organizationName: "Northstar Games",
      seedVersion: 1,
    };
    writeFileSync(path, JSON.stringify(account, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  const fleet = account.exampleFleet
    ? withExamplePorts(account.exampleFleet)
    : exampleFleet();
  if (!account.devMachine || fleet !== account.exampleFleet) {
    account.devMachine ??= {
      id: randomUUID(),
      credential: randomBytes(32).toString("hex"),
    };
    account.exampleFleet = fleet;
    writeFileSync(path, JSON.stringify(account, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  // Example servers store their RCON password as the API does, sealed with
  // the key `npm run dev` gives the API: its override, or this worktree's
  // key file, created here the same way when dev has not run yet.
  let secretKey = process.env.CUPBOARD_SECRET_KEY;
  if (!secretKey) {
    const keyPath = join(cwd, ".dev-stack/secret-key");
    try {
      secretKey = readFileSync(keyPath, "utf8").trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      secretKey = randomBytes(32).toString("hex");
      writeFileSync(keyPath, secretKey, { mode: 0o600, flag: "wx" });
    }
  }
  chmodSync(path, 0o600);
  const result = spawnSync(
    "cargo",
    ["run", "--locked", "--example", "dev_seed", "--", path],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CUPBOARD_DEV_SEED_WORKSPACE: project,
        CUPBOARD_SECRET_KEY: secretKey,
        DATABASE_URL: `postgres://cupboard:cupboard-local-only@127.0.0.1:${port}/cupboard`,
      },
    },
  );
  if (result.status !== 0)
    throw new Error("Dev seeding failed; review the fixed error above.");
  console.log(`Development organization ready. Login details: ${path}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.includes("--all")) {
      const paths = execFileSync("git", ["worktree", "list", "--porcelain"], {
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9));
      for (const cwd of paths) {
        if (!readWorkspace(cwd)) continue;
        const container = execFileSync(
          "docker",
          [
            "compose",
            "--project-name",
            workspaceIdentity(cwd),
            "ps",
            "--quiet",
            "postgres",
          ],
          { cwd, encoding: "utf8" },
        ).trim();
        if (!container) {
          execFileSync(
            "docker",
            [
              "compose",
              "--project-name",
              workspaceIdentity(cwd),
              "up",
              "--detach",
              "--wait",
              "--wait-timeout",
              "90",
              "postgres",
            ],
            {
              cwd,
              stdio: "inherit",
              env: { ...process.env, CUPBOARD_DB_PORT: "0" },
            },
          );
        }
        seedWorkspace(cwd);
      }
    } else seedWorkspace();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
