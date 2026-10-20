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
  if (!account.devMachine) {
    account.devMachine = {
      id: randomUUID(),
      credential: randomBytes(32).toString("hex"),
    };
    writeFileSync(path, JSON.stringify(account, null, 2) + "\n", {
      mode: 0o600,
    });
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
