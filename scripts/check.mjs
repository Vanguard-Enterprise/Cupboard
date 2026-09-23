import { execFileSync } from "node:child_process";
import { createProcesses } from "./processes.mjs";

const processes = createProcesses();
const project = `cupboard-check-${process.pid}`;
const compose = ["compose", "--project-name", project, "--profile", "test"];
let ownedDatabase = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => processes.stop());
}

try {
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
  if (!databaseUrl) {
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
  await processes.run("cargo", ["test", "--locked", "--all-targets"], {
    ...process.env,
    CUPBOARD_TEST_DATABASE_URL: databaseUrl,
  });
  for (const script of ["format:check", "lint", "typecheck", "test", "build"]) {
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
