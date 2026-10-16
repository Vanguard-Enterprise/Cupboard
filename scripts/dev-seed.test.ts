import { describe, expect, it } from "vitest";
import {
  assertSeedEnvironment,
  ownedDatabase,
  validateAccount,
} from "./dev-seed.mjs";
describe("development seed boundary", () => {
  it("rejects production and external database overrides", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { DATABASE_URL: "postgres://elsewhere" },
      { CUPBOARD_TEST_DATABASE_URL: "postgres://test" },
    ])
      expect(() => assertSeedEnvironment(env)).toThrow();
    expect(() => assertSeedEnvironment({})).not.toThrow();
  });
  it("requires the current worktree's running loopback-only Compose database", () => {
    const inspect = {
      State: { Running: true },
      Config: {
        Labels: {
          "com.docker.compose.project": "cupboard-dev-test",
          "com.docker.compose.service": "postgres",
          "com.docker.compose.project.working_dir": "/worktree",
        },
      },
      NetworkSettings: {
        Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] },
      },
    };
    expect(ownedDatabase(inspect, "cupboard-dev-test", "/worktree")).toBe(
      55432,
    );
    expect(() => ownedDatabase(inspect, "other", "/worktree")).toThrow();
    expect(() =>
      ownedDatabase(inspect, "cupboard-dev-test", "/other"),
    ).toThrow();
    inspect.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0";
    expect(() =>
      ownedDatabase(inspect, "cupboard-dev-test", "/worktree"),
    ).toThrow();
  });
  it("does not reuse another worktree's account", () => {
    expect(() =>
      validateAccount({ version: 1, workspace: "other" }, "current"),
    ).toThrow();
  });
});
