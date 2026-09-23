import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyApi } from "./api-proxy";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const request = (
  origin = "http://localhost:5173",
  headers: Record<string, string> = {},
) =>
  new Request("http://localhost:5173/app-api/auth/login", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-cupboard-request": "1",
      ...headers,
    },
    body: JSON.stringify({
      email: "user@example.com",
      password: "private-password",
    }),
  });
describe("same-origin API boundary", () => {
  it.each([422, 200])(
    "normalizes non-JSON upstream responses with status %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("Failed to deserialize private details", { status }),
        ),
      );
      const response = await proxyApi(request(), "auth/signup");
      expect(response.status).toBe(status === 200 ? 502 : status);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(typeof body.error).toBe("string");
      expect(body.error).not.toContain("private details");
    },
  );
  it("rejects cross-origin and malformed-origin requests without contacting Rust", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await proxyApi(request("https://evil.example"), "auth/login")).status,
    ).toBe(403);
    expect((await proxyApi(request("null"), "auth/login")).status).toBe(403);
    expect(
      (
        await proxyApi(
          request("http://localhost:5173", { "x-cupboard-request": "" }),
          "auth/login",
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("forwards only the session cookie and preserves HttpOnly Set-Cookie", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          headers: {
            "set-cookie":
              "cupboard_session=opaque; HttpOnly; Secure; SameSite=Lax; Path=/",
          },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const response = await proxyApi(
      request(undefined, {
        cookie: "unrelated=private; cupboard_session=opaque",
      }),
      "auth/login",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("http://127.0.0.1:8080/app-api/auth/login");
    expect((call[1]?.headers as Headers).get("cookie")).toBe(
      "cupboard_session=opaque",
    );
    expect(call[1]?.redirect).toBe("error");
  });
  it("does not expose connection failures or relay unsupported API paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("postgres://secret:private@host/db");
      }),
    );
    const response = await proxyApi(request(), "auth/login");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
    expect((await proxyApi(request(), "../admin")).status).toBe(404);
  });
  it("rejects oversized streamed bodies before forwarding", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const oversized = new Request("http://localhost:5173/app-api/team", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        "x-cupboard-request": "1",
        "content-type": "application/json",
      },
      body: "x".repeat(65537),
    });
    expect((await proxyApi(oversized, "team")).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
