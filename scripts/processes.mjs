import { spawn } from "node:child_process";

// Both development and checks must stop their children when interrupted.
export function createProcesses() {
  const children = new Set();
  const processGroups = process.platform !== "win32";
  let stopping = false;
  function kill(child, signal) {
    if (!child.pid) return;
    try {
      if (processGroups) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  function stop() {
    stopping = true;
    for (const child of children) {
      kill(child, "SIGTERM");
    }
    const timer = setTimeout(() => {
      for (const child of children) kill(child, "SIGKILL");
    }, 5000);
    timer.unref();
  }
  function run(command, args, env = process.env) {
    if (stopping) return Promise.reject(new Error("Stopped"));
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: "inherit",
        env,
        detached: processGroups,
      });
      children.add(child);
      child.on("error", () => {
        children.delete(child);
        reject(new Error(`Could not start ${command}`));
      });
      child.on("exit", (code, signal) => {
        children.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`${command} stopped with ${signal ?? code}`));
      });
    });
  }
  return { run, stop };
}
