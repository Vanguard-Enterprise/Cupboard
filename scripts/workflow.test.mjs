import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it("quick checks skip Docker, Rust database tests, and production builds", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cupboard-quick-"));
  const calls = join(cwd, "calls");
  try {
    await mkdir(join(cwd, "bin"));
    const record =
      "require('fs').appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2))+'\\n');";
    await writeFile(join(cwd, "bin/cargo"), `#!/usr/bin/env node\n${record}`, {
      mode: 0o755,
    });
    await writeFile(
      join(cwd, "bin/docker"),
      "#!/usr/bin/env node\nprocess.exit(99)",
      { mode: 0o755 },
    );
    await writeFile(join(cwd, "npm.cjs"), record);
    await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./check.mjs", import.meta.url)), "--quick"],
      {
        cwd,
        env: {
          ...process.env,
          PATH: `${join(cwd, "bin")}:${process.env.PATH}`,
          CALLS: calls,
          npm_execpath: join(cwd, "npm.cjs"),
          DATABASE_URL: "do-not-use-development-data",
        },
        timeout: 5000,
      },
    );
    const commands = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    expect(commands).toEqual([
      ["fmt", "--all", "--check"],
      ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"],
      ["run", "format:check"],
      ["run", "lint"],
      ["run", "typecheck"],
      ["run", "test"],
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("collects multiple pages of PR feedback without writing to GitHub", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cupboard-review-"));
  const calls = join(cwd, "calls");
  try {
    await mkdir(join(cwd, "bin"));
    await writeFile(
      join(cwd, "bin/gh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(process.env.CALLS, JSON.stringify(args)+'\\n');
if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify({url:'https://github.com/owner/repo/pull/123',headRefOid:'abc',statusCheckRollup:[{status:'IN_PROGRESS'}],reviews:[],comments:[]}));
else if(args[0] === 'api' && args[1] === 'graphql') {
  const second = args.includes('cursor=next');
  console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[{id:second?'thread-2':'thread-1',isResolved:false,comments:{nodes:[],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:!second,endCursor:second?null:'next'}}}}}}));
} else process.exit(99);
`,
      { mode: 0o755 },
    );
    const result = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("./workflow.mjs", import.meta.url)),
        "review",
        "123",
      ],
      {
        cwd,
        env: {
          ...process.env,
          PATH: `${join(cwd, "bin")}:${process.env.PATH}`,
          CALLS: calls,
        },
        timeout: 5000,
      },
    );
    expect(result.stdout).toContain('"thread-1"');
    expect(result.stdout).toContain('"thread-2"');
    expect(result.stdout).toContain('"IN_PROGRESS"');
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(3);
    expect(result.stdout).toContain("Read-only snapshot");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
