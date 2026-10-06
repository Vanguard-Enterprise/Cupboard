import { afterEach, expect, it, vi } from "vitest";
import { proxyNode } from "./node-proxy";
afterEach(() => vi.unstubAllGlobals());
const token = "a".repeat(64);
function request(body = "{}", authorization = `Bearer ${token}`) {
  return new Request("https://cupboard.example/node-api/heartbeat", {
    method: "POST",
    headers: {
      authorization,
      cookie: "cupboard_session=private",
      "content-type": "application/json",
    },
    body,
  });
}
it("forwards only machine authorization and refuses redirects", async () => {
  const fetcher = vi.fn(async () => Response.json({ accepted: true }));
  vi.stubGlobal("fetch", fetcher);
  const result = await proxyNode(request(), "heartbeat");
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  const options = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(options[1].headers).toEqual({
    authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
  expect(options[1].redirect).toBe("error");
});
it("rejects browser-only authentication, unknown endpoints, and oversized reports", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect((await proxyNode(request("{}", ""), "heartbeat")).status).toBe(401);
  expect((await proxyNode(request(), "machines")).status).toBe(404);
  expect((await proxyNode(request("x".repeat(8193)), "heartbeat")).status).toBe(
    413,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it("hides upstream failures and preserves credential rejection", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response("private secret", { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({ error: "Credential rejected" }, { status: 401 }),
      ),
  );
  const failed = await proxyNode(request(), "heartbeat");
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private secret");
  expect((await proxyNode(request(), "heartbeat")).status).toBe(401);
});
