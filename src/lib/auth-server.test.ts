import { afterEach, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { getIdentity } from "./auth-server";
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it("reads the current worktree cookie for server-rendered identity", async () => {
  vi.stubEnv("CUPBOARD_SESSION_COOKIE_NAME", "cupboard_session_workspace_a");
  const get = vi.fn((name: string) =>
    name === "cupboard_session_workspace_a"
      ? { value: "own-token" }
      : { value: "foreign-token" },
  );
  vi.mocked(cookies).mockResolvedValue({ get } as unknown as Awaited<
    ReturnType<typeof cookies>
  >);
  const identity = { user: { id: "own-user" } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(identity)),
  );
  expect(await getIdentity()).toEqual(identity);
  expect(get).toHaveBeenCalledWith("cupboard_session_workspace_a");
  expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({
    cookie: "cupboard_session=own-token",
  });
});
it("does not use another app's cookie when the scoped cookie is absent", async () => {
  vi.stubEnv("CUPBOARD_SESSION_COOKIE_NAME", "cupboard_session_workspace_a");
  const get = vi.fn((name: string) =>
    name === "cupboard_session" ? { value: "foreign-token" } : undefined,
  );
  vi.mocked(cookies).mockResolvedValue({ get } as unknown as Awaited<
    ReturnType<typeof cookies>
  >);
  vi.stubGlobal("fetch", vi.fn());
  expect(await getIdentity()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("retains the default cookie name outside scoped development", async () => {
  vi.stubEnv("CUPBOARD_SESSION_COOKIE_NAME", undefined);
  const get = vi.fn(() => ({ value: "production-token" }));
  vi.mocked(cookies).mockResolvedValue({ get } as unknown as Awaited<
    ReturnType<typeof cookies>
  >);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ user: { id: "user" } })),
  );
  await getIdentity();
  expect(get).toHaveBeenCalledWith("cupboard_session");
});
