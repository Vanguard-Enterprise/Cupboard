import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { createDevServerConfig } from "./dev.mjs";
import { readWorkspace, workspaceIdentity } from "./workspace.mjs";

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    ...options,
  }).trim();
}

export function worktreeBranch(issue, type, description) {
  if (
    !/^CUP-[1-9]\d*$/i.test(issue ?? "") ||
    !/^(feat|fix|refactor|docs|test|perf|chore)$/.test(type ?? "") ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(description ?? "")
  )
    throw new Error(
      "Usage: npm run worktree -- CUP-34 chore development-workflow [base-ref]. Use a lowercase description with hyphens.",
    );
  return `${type}/${issue.toLowerCase()}-${description}`;
}

function createWorktree(args) {
  const [issue, type, description, base = "origin/main"] = args;
  if (args.length > 4 || base.startsWith("-"))
    throw new Error(
      "Supply an issue, type, description, and optional base ref.",
    );
  const branch = worktreeBranch(issue, type, description);
  capture("git", ["rev-parse", "--verify", `${base}^{commit}`]);
  const common = resolve(capture("git", ["rev-parse", "--git-common-dir"]));
  const destination = join(
    dirname(common),
    ".worktrees",
    branch.replace("/", "-"),
  );
  execFileSync("git", ["worktree", "add", "-b", branch, destination, base], {
    stdio: "inherit",
  });
  console.log(
    `\nWorktree: ${destination}\nBranch: ${branch}\nBase: ${base}\n\nIn that directory, run npm ci, then npm run doctor and npm run dev.`,
  );
}

function doctor() {
  let failed = false;
  for (const [label, command, args] of [
    ["Node", process.execPath, ["--version"]],
    ["Git", "git", ["--version"]],
    ["Rust toolchain", "rustup", ["show", "active-toolchain"]],
    ["Docker daemon", "docker", ["info", "--format", "{{.ServerVersion}}"]],
    ["Compose", "docker", ["compose", "version", "--short"]],
    ["GitHub access", "gh", ["api", "user", "--jq", ".login"]],
  ]) {
    try {
      console.log(`${label}: ${capture(command, args)}`);
    } catch {
      console.log(`${label}: unavailable; check installation or access`);
      failed = true;
    }
  }
  const dependencies = existsSync("node_modules/next/package.json");
  console.log(
    `Web dependencies: ${dependencies ? "installed" : "missing; run npm ci"}`,
  );
  if (!dependencies) failed = true;
  const workspace = readWorkspace();
  console.log(`Workspace: ${workspaceIdentity()}`);
  console.log(
    `Database: ${process.env.DATABASE_URL ? "external DATABASE_URL; isolation is your responsibility" : "worktree-owned Compose volume"}`,
  );
  if (workspace)
    console.log(
      `Saved ports: web ${workspace.webPort}, API ${workspace.apiPort}`,
    );
  else console.log("Ports: selected and saved on first npm run dev");
  const lock = join(".dev-stack", "dev.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch (error) {
      alive = error.code === "EPERM";
    }
    console.log(
      `Dev lock: ${alive ? `process ${pid} is running` : "stale; remove .dev-stack/dev.lock before restarting"}`,
    );
    if (!alive) failed = true;
  }
  let status;
  try {
    status = capture("netbird", ["status", "--json"]);
  } catch {}
  const config = createDevServerConfig(
    networkInterfaces(),
    String(workspace?.webPort ?? "5173"),
    status,
  );
  console.log(
    config.netbirdUrl
      ? workspace
        ? `NetBird URL: ${config.netbirdUrl}`
        : `NetBird host: ${new URL(config.netbirdUrl).hostname}; port selected on first dev startup`
      : "NetBird: unavailable; connect NetBird before remote browser verification",
  );
  if (!config.netbirdUrl) failed = true;
  process.exitCode = failed ? 1 : 0;
}

function review(pr) {
  if (!/^\d+$/.test(pr ?? ""))
    throw new Error("Usage: npm run review -- <PR number>");
  const info = JSON.parse(
    capture("gh", [
      "pr",
      "view",
      pr,
      "--json",
      "number,url,title,headRefOid,state,isDraft,reviewDecision,statusCheckRollup,reviews,comments",
    ]),
  );
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+$/.exec(
    info.url,
  );
  if (!match) throw new Error("Could not identify the PR repository.");
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line comments(first:100){nodes{id body url author{login}} pageInfo{hasNextPage}}}}}}}`;
  const threads = [];
  let cursor;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${match[1]}`,
      "-f",
      `name=${match[2]}`,
      "-F",
      `number=${pr}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const result = JSON.parse(capture("gh", args));
    if (result.errors)
      throw new Error("GitHub could not retrieve review threads.");
    const page = result.data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
  } while (cursor);
  console.log(JSON.stringify({ ...info, reviewThreads: threads }, null, 2));
  console.log(
    "\nRead-only snapshot. Check the head commit, pending jobs, expected automated reviewers, and every thread before declaring the PR ready. Threads with more comment pages need further inspection.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "worktree") createWorktree(args);
    else if (command === "doctor") doctor();
    else if (command === "review") review(args[0]);
    else if (command === "stop-storage")
      execFileSync(
        "docker",
        ["compose", "--project-name", workspaceIdentity(), "stop", "storage"],
        { stdio: "inherit" },
      );
    else if (command === "stop-db")
      execFileSync(
        "docker",
        ["compose", "--project-name", workspaceIdentity(), "stop", "postgres"],
        { stdio: "inherit" },
      );
    else throw new Error("Choose worktree, doctor, or review.");
  } catch (error) {
    // CLI errors can include environment values; do not print subprocess stderr.
    console.error(
      error.status !== undefined
        ? "Command failed. Check the ref, tool installation, or service access."
        : error.message,
    );
    process.exitCode = 1;
  }
}
