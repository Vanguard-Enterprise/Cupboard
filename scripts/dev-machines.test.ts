import { describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateAccount, publish } from "./dev-machines.mjs";

describe("shared development machine telemetry", () => {
  it("uses separate credentials per destination and publishes only on loopback", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const report = { hostname: "use1-wings-01", cpuCount: 4 };
    const destinations = [
      {
        project: "one",
        url: "http://127.0.0.1:48601",
        credential: "a".repeat(64),
      },
      {
        project: "two",
        url: "http://127.0.0.1:48602",
        credential: "b".repeat(64),
      },
    ];
    expect(await publish(report, destinations, send)).toEqual([
      { project: "one", accepted: true },
      { project: "two", accepted: true },
    ]);
    expect(send.mock.calls[0][1].headers.Authorization).toBe(
      `Bearer ${"a".repeat(64)}`,
    );
    expect(send.mock.calls[1][1].headers.Authorization).toBe(
      `Bearer ${"b".repeat(64)}`,
    );
    expect(send.mock.calls[0][1].body).not.toContain("credential");
    for (const url of [
      "http://evil.example",
      "http://127.0.0.1/path",
      "http://user:password@127.0.0.1",
      "http://127.0.0.1/?token=secret",
    ]) {
      await expect(
        publish(report, [{ ...destinations[0], url }], send),
      ).rejects.toThrow();
    }
    await expect(
      publish({ hostname: "another-node" }, destinations, send),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("rejects shared, foreign, or symlinked credential files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cupboard-dev-machine-"));
    try {
      const id = "cc87f4c0-19a4-4a46-ae38-9bd0b5d6eaca";
      const account = {
        version: 1,
        workspace: "project",
        accountId: id,
        organizationId: id,
        email: `dev-${id}@example.test`,
        password: "private-fixture-password",
        devMachine: { id, credential: "a".repeat(64) },
      };
      const path = join(dir, "account.json");
      writeFileSync(path, JSON.stringify(account), { mode: 0o600 });
      expect(privateAccount(path, "project").devMachine.id).toBe(id);
      expect(() => privateAccount(path, "another-project")).toThrow();
      chmodSync(path, 0o644);
      expect(() => privateAccount(path, "project")).toThrow();
      chmodSync(path, 0o600);
      const link = join(dir, "link");
      symlinkSync(path, link);
      expect(() => privateAccount(link, "project")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
