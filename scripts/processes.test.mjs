import { describe, expect, it } from "vitest";
import { createProcesses } from "./processes.mjs";

describe("development and check process supervision", () => {
  it("propagates failure so callers can stop the remaining processes", async () => {
    const processes = createProcesses();
    await expect(
      processes.run(process.execPath, ["-e", "process.exit(7)"]),
    ).rejects.toThrow("stopped with 7");
    processes.stop();
    await expect(
      processes.run(process.execPath, ["-e", "process.exit(0)"]),
    ).rejects.toThrow("Stopped");
  });

  it("stops a running child without waiting for its work to finish", async () => {
    const processes = createProcesses();
    const running = processes.run(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const result = expect(running).rejects.toThrow("stopped with");
    processes.stop();
    await result;
  });
});
