import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { execFileSync } from "node:child_process";
import { createProcesses } from "./processes.mjs";

const quick = process.argv.includes("--quick");
const processes = createProcesses();
const project = `cupboard-check-${randomUUID()}`;
const runnerContainer = process.env.CUPBOARD_CHECK_CONTAINER;
const network = `${project}_default`;
let attachedRunner = false;
const compose = ["compose", "--project-name", project, "--profile", "test"];
let ownedDatabase = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => processes.stop());
}

try {
  await processes.run("python3", [
    "-B",
    "-m",
    "unittest",
    "discover",
    "-s",
    "tests",
    "-p",
    "test_agent.py",
  ]);
  await processes.run("cargo", ["fmt", "--all", "--check"]);
  await processes.run("cargo", [
    "clippy",
    "--locked",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]);
  let databaseUrl = process.env.CUPBOARD_TEST_DATABASE_URL;
  if (!quick && !databaseUrl) {
    ownedDatabase = true;
    const env = { ...process.env, CUPBOARD_TEST_DB_PORT: "0" };
    await processes.run(
      "docker",
      [
        ...compose,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "60",
        "postgres-test",
      ],
      env,
    );
    if (runnerContainer) {
      // Containerized self-hosted runners share Docker's socket, not its loopback.
      execFileSync("docker", ["network", "connect", network, runnerContainer]);
      attachedRunner = true;
      const container = execFileSync(
        "docker",
        [...compose, "ps", "--quiet", "postgres-test"],
        { encoding: "utf8", env },
      ).trim();
      const inspect = JSON.parse(
        execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
      );
      const host = inspect[0].NetworkSettings.Networks[network].IPAddress;
      if (isIP(host) !== 4)
        throw new Error("Could not discover test PostgreSQL address");
      databaseUrl = `postgres://cupboard:cupboard-test-only@${host}:5432/cupboard_test`;
    } else {
      const address = execFileSync(
        "docker",
        [...compose, "port", "postgres-test", "5432"],
        { encoding: "utf8", env },
      ).trim();
      const port = address.split(":").at(-1);
      if (!/^\d+$/.test(port))
        throw new Error("Could not discover test PostgreSQL port");
      databaseUrl = `postgres://cupboard:cupboard-test-only@127.0.0.1:${port}/cupboard_test`;
    }
  }
  if (!quick)
    await processes.run("cargo", ["test", "--locked", "--all-targets"], {
      ...process.env,
      CUPBOARD_TEST_DATABASE_URL: databaseUrl,
    });
  for (const script of [
    "format:check",
    "lint",
    "typecheck",
    "test",
    ...(quick ? [] : ["build"]),
  ]) {
    await processes.run(process.execPath, [
      process.env.npm_execpath,
      "run",
      script,
    ]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  processes.stop();
  if (attachedRunner) {
    try {
      execFileSync(
        "docker",
        ["network", "disconnect", network, runnerContainer],
        { timeout: 10000 },
      );
    } catch {
      console.error("Could not detach the runner from the test network.");
      process.exitCode = 1;
    }
  }
  if (ownedDatabase) {
    try {
      execFileSync("docker", [...compose, "down", "--volumes"], {
        stdio: "inherit",
        timeout: 30000,
      });
    } catch {
      console.error(
        `Could not remove test database. Run docker compose --project-name ${project} --profile test down --volumes`,
      );
      process.exitCode = 1;
    }
  }
}
