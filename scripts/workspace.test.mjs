import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import {
  acquireDevLock,
  databasePort,
  prepareWorkspace,
  readWorkspace,
  workspaceIdentity,
} from "./workspace.mjs";
import { worktreeBranch } from "./workflow.mjs";

const directories = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "cupboard-workspace-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("worktree isolation", () => {
  it("keeps separate persistent database projects and stable ports without writing secrets", async () => {
    const first = directory();
    const second = directory();
    const a = await prepareWorkspace(first, {
      DATABASE_URL: "secret-database-url",
    });
    const b = await prepareWorkspace(second, {});
    expect(a.project).not.toBe(b.project);
    expect(await prepareWorkspace(first, {})).toEqual(a);
    expect(readWorkspace(first)).toEqual(a);
    expect(
      readFileSync(join(first, ".dev-stack/workspace.json"), "utf8"),
    ).not.toContain("secret");
    expect(workspaceIdentity(first)).toBe(a.project);
  });

  it("rejects occupied saved ports without silently changing the URL", async () => {
    const path = directory();
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = server.address().port;
    mkdirSync(join(path, ".dev-stack"));
    writeFileSync(
      join(path, ".dev-stack/workspace.json"),
      JSON.stringify({ webPort: port, apiPort: 41000 }),
    );
    try {
      await expect(prepareWorkspace(path, {})).rejects.toThrow(
        `Port ${port} is already in use`,
      );
      expect(readWorkspace(path).webPort).toBe(port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("blocks duplicate startup, releases its lock, and does not remove someone else's lock", () => {
    const path = directory();
    const release = acquireDevLock(path);
    expect(() => acquireDevLock(path)).toThrow("already has a dev lock");
    expect(readFileSync(join(path, ".dev-stack/dev.lock"), "utf8")).toBe(
      String(process.pid),
    );
    release();
    acquireDevLock(path)();
  });

  it("rejects invalid configuration and database addresses", async () => {
    await expect(
      prepareWorkspace(directory(), { CUPBOARD_API_BIND: "127.0.0.1:8080" }),
    ).rejects.toThrow("0.0.0.0");
    await expect(
      prepareWorkspace(directory(), { CUPBOARD_PORT: "0" }),
    ).rejects.toThrow("Development ports");
    expect(databasePort("127.0.0.1:55432\n")).toBe(55432);
    expect(() => databasePort("0.0.0.0:55432")).toThrow("PostgreSQL port");
  });
});

it("creates a real issue-named worktree and leaves the source working tree untouched", () => {
  const source = directory();
  execFileSync("git", ["init", "--initial-branch=main", source]);
  writeFileSync(join(source, "file"), "original");
  execFileSync("git", ["add", "file"], { cwd: source });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: source },
  );
  writeFileSync(join(source, "file"), "uncommitted");
  execFileSync(
    process.execPath,
    [
      new URL("./workflow.mjs", import.meta.url).pathname,
      "worktree",
      "CUP-34",
      "chore",
      "workflow",
      "main",
    ],
    { cwd: source },
  );
  const target = join(source, ".worktrees/chore-cup-34-workflow");
  expect(readFileSync(join(target, "file"), "utf8")).toBe("original");
  expect(readFileSync(join(source, "file"), "utf8")).toBe("uncommitted");
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: target,
      encoding: "utf8",
    }).trim(),
  ).toBe("chore/cup-34-workflow");
  expect(() => worktreeBranch("CUP-34", "codex", "workflow")).toThrow("Usage");
  expect(() => worktreeBranch("CUP-34", "chore", "../bad")).toThrow("Usage");
});
