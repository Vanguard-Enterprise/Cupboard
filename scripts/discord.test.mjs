import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  redirectUri,
  relayPort,
  relayTarget,
  startDiscordRelay,
} from "./discord.mjs";

const hosts = ["100.64.0.1"];
const state = `21712.${"a".repeat(64)}`;
const callback = (query) => `/discord/callback?${query}`;

describe("Discord development relay", () => {
  it("returns installs to the worktree named in the state", () => {
    expect(redirectUri("100.64.0.1")).toBe(
      "http://100.64.0.1:21700/discord/callback",
    );
    expect(
      relayTarget(
        callback(`code=abc&state=${state}&guild_id=1`),
        "100.64.0.1:21700",
        hosts,
      ),
    ).toBe(
      `http://100.64.0.1:21712/dashboard/community/discord/callback?code=abc&state=${state}&guild_id=1`,
    );
    expect(
      relayTarget(
        callback(`error=access_denied&state=${state}`),
        "100.64.0.1:21700",
        hosts,
      ),
    ).toContain("error=access_denied");
  });

  it("refuses other hosts, paths, ports, and malformed states", () => {
    for (const [url, host] of [
      [callback(`state=${state}`), "evil.example:21700"],
      [`/elsewhere?state=${state}`, "100.64.0.1:21700"],
      [callback("state=21712.short"), "100.64.0.1:21700"],
      [callback(`state=80.${"a".repeat(64)}`), "100.64.0.1:21700"],
      [callback(`state=${relayPort}.${"a".repeat(64)}`), "100.64.0.1:21700"],
      [callback(`state=99999.${"a".repeat(64)}`), "100.64.0.1:21700"],
      [callback(`state=${state}`), undefined],
    ])
      expect(relayTarget(url, host, hosts)).toBeUndefined();
  });
});

describe("relay ownership", () => {
  const stops = [];
  afterEach(() => stops.splice(0).forEach((stop) => stop()));

  it("serves redirects and lets a second worktree wait for the port", async () => {
    const probe = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => probe.once("listening", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    stops.push(startDiscordRelay(["127.0.0.1"], { port, retryMs: 50 }));
    stops.push(startDiscordRelay(["127.0.0.1"], { port, retryMs: 50 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const response = await fetch(
      `http://127.0.0.1:${port}${callback(`code=abc&state=${state}`)}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `http://127.0.0.1:21712/dashboard/community/discord/callback?code=abc&state=${state}`,
    );
    const refused = await fetch(`http://127.0.0.1:${port}/other`, {
      redirect: "manual",
    });
    expect(refused.status).toBe(404);
  });
});
