import { mkdtemp, writeFile, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startRustDev } from "./rust-dev.mjs";

it("reloads atomic saves, recovers from build errors, and stops the API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cupboard-watch-"));
  const source = join(dir, "source");
  const pidFile = join(dir, "pid");
  await writeFile(source, "valid");
  const watcher = startRustDev({
    paths: [source],
    interval: 30,
    env: {
      ...process.env,
      WATCH_SOURCE: source,
      WATCH_PID: pidFile,
      WATCH_RESULT: join(dir, "build-result"),
    },
    build: [
      process.execPath,
      "-e",
      "const value = require('fs').readFileSync(process.env.WATCH_SOURCE, 'utf8'); require('fs').writeFileSync(process.env.WATCH_RESULT, value); process.exit(value === 'invalid' ? 1 : 0)",
    ],
    serve: [
      process.execPath,
      "-e",
      "require('fs').writeFileSync(process.env.WATCH_PID, String(process.pid)); setInterval(() => {}, 1000)",
    ],
  });
  const pid = async () =>
    Number(await readFile(pidFile, "utf8").catch(() => "0"));
  const alive = (id) => {
    try {
      process.kill(id, 0);
      return true;
    } catch {
      return false;
    }
  };
  let last;
  try {
    await expect.poll(pid).toBeGreaterThan(0);
    const first = await pid();
    await writeFile(join(dir, "save"), "updated");
    await rename(join(dir, "save"), source);
    await expect.poll(pid).not.toBe(first);
    expect(alive(first)).toBe(false);
    const second = await pid();
    await writeFile(source, "invalid");
    await expect.poll(() => alive(second)).toBe(false);
    await expect
      .poll(() => readFile(join(dir, "build-result"), "utf8"))
      .toBe("invalid");
    await writeFile(source, "fixed");
    await expect.poll(pid).not.toBe(second);
    last = await pid();
    expect(alive(last)).toBe(true);
  } finally {
    watcher.stop();
    await watcher.done;
    await rm(dir, { recursive: true, force: true });
  }
  expect(alive(last)).toBe(false);
});
