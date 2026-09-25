import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createProcesses } from "./processes.mjs";

// Content polling also catches atomic editor saves and newly added directories.
async function fingerprint(paths) {
  const hash = createHash("sha256");
  async function visit(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.isSymbolicLink()) continue;
        await visit(join(path, entry.name));
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (error.code !== "ENOTDIR") throw error;
      try {
        hash.update(path).update(await readFile(path));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  for (const path of paths) await visit(path);
  return hash.digest("hex");
}

export function startRustDev({
  env = process.env,
  paths = [
    "backend",
    "Cargo.toml",
    "Cargo.lock",
    "build.rs",
    "rust-toolchain.toml",
    ".cargo",
  ],
  build = ["cargo", "build", "--locked"],
  serve = ["./target/debug/cupboard"],
  interval = 300,
} = {}) {
  let stopping = false;
  let processes;
  let server;
  let restarting = false;
  let serverError;
  const abort = new AbortController();
  function stop() {
    stopping = true;
    abort.abort();
    processes?.stop();
  }
  const done = (async () => {
    let previous;
    try {
      while (!stopping) {
        const current = await fingerprint(paths);
        if (current !== previous) {
          previous = current;
          restarting = true;
          processes?.stop();
          await server;
          restarting = false;
          if (stopping) break;
          processes = createProcesses();
          console.log("Rust: rebuilding API...");
          try {
            await processes.run(build[0], build.slice(1), env);
            if (stopping) break;
            // Do not run a build superseded by edits made during compilation.
            if ((await fingerprint(paths)) !== current) continue;
            console.log("Rust: starting API; watching for changes.");
            function exited(error) {
              if (stopping || restarting) return;
              serverError =
                error ?? new Error("Rust API exited unexpectedly with code 0");
              abort.abort();
            }
            server = processes
              .run(serve[0], serve.slice(1), env)
              .then(() => exited(), exited);
          } catch (error) {
            if (!stopping)
              console.error(
                `Rust: ${error.message}. Waiting for an edit to retry.`,
              );
          }
        }
        await setTimeout(interval, undefined, { signal: abort.signal });
      }
    } catch (error) {
      if (!stopping) throw serverError ?? error;
    } finally {
      stop();
      await server;
    }
  })();
  return { stop, done };
}
