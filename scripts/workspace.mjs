import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";

export function workspaceIdentity(cwd = process.cwd()) {
  return `cupboard-dev-${createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16)}`;
}

export function acquireDevLock(cwd = process.cwd()) {
  mkdirSync(join(cwd, ".dev-stack"), { recursive: true });
  const path = join(cwd, ".dev-stack", "dev.lock");
  try {
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      "This worktree already has a dev lock. Run npm run doctor. If its PID has exited, remove .dev-stack/dev.lock and retry.",
    );
  }
  return () => unlinkSync(path);
}

export function validPort(value) {
  if (
    !/^\d+$/.test(String(value)) ||
    Number(value) < 1024 ||
    Number(value) > 65535
  )
    throw new Error(
      "Development ports must be integers between 1024 and 65535.",
    );
  return Number(value);
}

export async function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (["EADDRINUSE", "EACCES"].includes(error.code)) resolve(false);
      else reject(error);
    });
    server.listen(port, "0.0.0.0", () => server.close(() => resolve(true)));
  });
}

export function readWorkspace(cwd = process.cwd()) {
  try {
    const saved = JSON.parse(
      readFileSync(join(cwd, ".dev-stack", "workspace.json"), "utf8"),
    );
    return {
      project: workspaceIdentity(cwd),
      webPort: validPort(saved.webPort),
      apiPort: validPort(saved.apiPort),
    };
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(
      "Invalid .dev-stack/workspace.json; correct its ports before starting development.",
    );
  }
}

export async function prepareWorkspace(cwd = process.cwd(), env = process.env) {
  const project = workspaceIdentity(cwd);
  const saved = readWorkspace(cwd);
  const seed = Number.parseInt(project.slice(-4), 16) % 12000;
  const ports = new Set();
  async function choose(requested, initial) {
    let port = validPort(requested ?? initial);
    if (requested !== undefined) {
      if (ports.has(port) || !(await portAvailable(port)))
        throw new Error(
          `Port ${port} is already in use. Stop its process or choose a different CUPBOARD_PORT / CUPBOARD_API_BIND.`,
        );
    } else {
      while (ports.has(port) || !(await portAvailable(port)))
        port = validPort(port + 1);
    }
    ports.add(port);
    return port;
  }
  if (env.CUPBOARD_API_BIND && !/^0\.0\.0\.0:\d+$/.test(env.CUPBOARD_API_BIND))
    throw new Error(
      "CUPBOARD_API_BIND must use 0.0.0.0:<port> for local development.",
    );
  const webPort = await choose(
    env.CUPBOARD_PORT ?? saved?.webPort,
    20000 + seed,
  );
  const apiPort = await choose(
    env.CUPBOARD_API_BIND?.split(":").at(-1) ?? saved?.apiPort,
    40000 + seed,
  );
  mkdirSync(join(cwd, ".dev-stack"), { recursive: true });
  writeFileSync(
    join(cwd, ".dev-stack", "workspace.json"),
    JSON.stringify({ webPort, apiPort }, null, 2) + "\n",
    { mode: 0o600 },
  );
  return { project, webPort, apiPort };
}

export function databasePort(address) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(address.trim());
  if (!match)
    throw new Error("Could not discover the worktree PostgreSQL port.");
  return validPort(match[1]);
}
