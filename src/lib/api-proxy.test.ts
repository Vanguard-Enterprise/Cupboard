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

it("forwards only bounded server-check paths through the authenticated boundary", async () => {
  const fetcher = vi.fn(async () => Response.json({ rconStatus: "connected" }));
  vi.stubGlobal("fetch", fetcher);
  const path = "servers/12345678-1234-1234-1234-123456789abc/check";
  expect((await proxyApi(request(), path)).status).toBe(200);
  expect(fetcher.mock.calls).toHaveLength(1);
  for (const invalid of [
    "servers/../auth/me/check",
    `${path}?secret=value`,
    "servers/arbitrary/check",
    "servers/12345678-1234-1234-1234-123456789abc/delete",
  ]) {
    expect((await proxyApi(request(), invalid)).status).toBe(404);
  }
  expect(
    (await proxyApi(request("https://foreign.example"), path)).status,
  ).toBe(403);
  expect(fetcher.mock.calls).toHaveLength(1);
});

it("forwards dashboard health reads without caching or leaking unrelated cookies", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ organizationId: "org", servers: [] }),
  );
  vi.stubGlobal("fetch", fetcher);
  const response = await proxyApi(
    new Request("http://localhost:5173/app-api/servers/health", {
      headers: { cookie: "cupboard_session=opaque; unrelated=private" },
    }),
    "servers/health",
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const call = vi.mocked(fetch).mock.calls[0];
  expect(call[0]).toBe("http://127.0.0.1:8080/app-api/servers/health");
  expect((call[1]?.headers as Headers).get("cookie")).toBe(
    "cupboard_session=opaque",
  );
});

describe("private file transport", () => {
  function upload(
    bytes = new Uint8Array([0, 255, 1]),
    origin = "http://localhost:5173",
  ) {
    return new Request("http://localhost:5173/app-api/files", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/octet-stream",
        "x-cupboard-request": "1",
        "x-cupboard-filename": "caf%C3%A9.txt",
        "x-cupboard-organization": "org",
        authorization: "must-not-forward",
      },
      body: bytes,
    });
  }
  it("forwards binary files and tenant context without extra credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "file" }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect((await proxyApi(upload(), "files")).status).toBe(200);
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(new Uint8Array(options.body as ArrayBuffer)).toEqual(
      new Uint8Array([0, 255, 1]),
    );
    const headers = new Headers(options.headers);
    expect(headers.get("x-cupboard-filename")).toBe("caf%C3%A9.txt");
    expect(headers.get("x-cupboard-organization")).toBe("org");
    expect(headers.get("authorization")).toBeNull();
  });
  it("rejects cross-origin uploads and files over the byte limit", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await proxyApi(upload(undefined, "https://evil.example"), "files"))
        .status,
    ).toBe(403);
    expect(
      (await proxyApi(upload(new Uint8Array(10 * 1024 * 1024 + 1)), "files"))
        .status,
    ).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("streams downloads as private attachments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0, 255, 1]), {
            headers: {
              "content-disposition": "attachment; filename=download",
              "content-length": "3",
            },
          }),
      ),
    );
    const path = "files/12345678-1234-1234-1234-123456789012";
    const result = await proxyApi(
      new Request(`http://localhost:5173/app-api/${path}`),
      path,
    );
    expect(result.headers.get("content-type")).toBe("application/octet-stream");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 1]),
    );
  });
});
