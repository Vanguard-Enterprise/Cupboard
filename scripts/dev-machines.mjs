import { execFileSync, spawn } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  assertSeedEnvironment,
  ownedDatabase,
  validateAccount,
} from "./dev-seed.mjs";
import { readWorkspace, workspaceIdentity } from "./workspace.mjs";

export function privateAccount(path, project) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077)
      throw new Error("Development credentials must be private.");
    const account = validateAccount(
      JSON.parse(readFileSync(fd, "utf8")),
      project,
    );
    if (
      !/^[a-f0-9-]{36}$/.test(account.devMachine?.id ?? "") ||
      !/^[a-f0-9]{64}$/.test(account.devMachine?.credential ?? "")
    )
      throw new Error("Run dev:seed to enroll the development machine.");
    return account;
  } finally {
    closeSync(fd);
  }
}
export function targets() {
  const paths = execFileSync("git", ["worktree", "list", "--porcelain"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice(9));
  const result = [];
  for (const cwd of paths) {
    try {
      const workspace = readWorkspace(cwd);
      if (!workspace) continue;
      const project = workspaceIdentity(cwd);
      const account = privateAccount(
        join(cwd, ".dev-stack/dev-account.json"),
        project,
      );
      const container = execFileSync(
        "docker",
        ["compose", "--project-name", project, "ps", "--quiet", "postgres"],
        {
          cwd,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      const [inspect] = JSON.parse(
        execFileSync("docker", ["inspect", container], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      ownedDatabase(inspect, project, cwd);
      result.push({
        project,
        url: `http://127.0.0.1:${workspace.apiPort}`,
        credential: account.devMachine.credential,
      });
    } catch {
      /* Only prepared, owned, running development environments receive reports. */
    }
  }
  return result;
}
export async function publish(report, destinations, send = fetch) {
  if (
    JSON.stringify(report).length > 8192 ||
    report.hostname !== "use1-wings-01"
  )
    throw new Error("Unexpected development collector report.");
  return Promise.all(
    destinations.map(async (target) => {
      const url = new URL(target.url);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Development reports must stay on loopback.");
      try {
        const response = await send(`${target.url}/node-api/heartbeat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${target.credential}`,
          },
          body: JSON.stringify(report),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        return { project: target.project, accepted: response.ok };
      } catch {
        return { project: target.project, accepted: false };
      }
    }),
  );
}
const ssh = [
  "-o",
  "BatchMode=yes",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=2",
  "-i",
  join(process.env.HOME, ".ssh/id_ed25519"),
  "frank@10.1.70.10",
];
function installCollector() {
  for (const [source, filename] of [
    ["public/agent/cupboard-agent.py", "cupboard-agent.py"],
    ["scripts/dev-machine-collector.py", "dev-machine-collector.py"],
  ]) {
    execFileSync(
      "ssh",
      [
        ...ssh,
        `umask 077; mkdir -p ~/.local/lib/cupboard-dev-agent; cat > ~/.local/lib/cupboard-dev-agent/${filename}.new && mv ~/.local/lib/cupboard-dev-agent/${filename}.new ~/.local/lib/cupboard-dev-agent/${filename}`,
      ],
      {
        input: readFileSync(source),
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 15000,
      },
    );
  }
}
async function run() {
  assertSeedEnvironment(process.env);
  const common = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  const lock = join(common, "cupboard-dev-machine.lock");
  let stopping = false;
  let child;
  let ownsLock = false;
  const stop = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    while (!stopping && !ownsLock) {
      try {
        writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
        ownsLock = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const pid = Number(readFileSync(lock, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error("Invalid development reporter lock.");
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") {
            unlinkSync(lock);
            continue;
          }
          throw error;
        }
        if (process.argv.includes("--once")) {
          console.log("Development reporter already running.");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    while (!stopping) {
      try {
        installCollector();
        child = spawn(
          "ssh",
          [
            ...ssh,
            "python3 -u ~/.local/lib/cupboard-dev-agent/dev-machine-collector.py",
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        const lines = createInterface({ input: child.stdout });
        for await (const line of lines) {
          try {
            if (line.length > 8192) throw new Error("Report too large.");
            const outcomes = await publish(JSON.parse(line), targets());
            console.log(
              `Wings telemetry: ${outcomes.filter((value) => value.accepted).length}/${outcomes.length} development environments updated.`,
            );
            if (process.argv.includes("--once")) {
              stop();
              break;
            }
          } catch {
            console.error(
              "Wings telemetry report rejected; credentials remain private.",
            );
          }
          if (stopping) break;
        }
        child.kill("SIGTERM");
      } catch {
        console.error("Development Wings collector unavailable; retrying.");
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  } finally {
    child?.kill("SIGTERM");
    if (ownsLock) unlinkSync(lock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run().catch(() => {
    console.error("Development machine reporter failed.");
    process.exitCode = 1;
  });
