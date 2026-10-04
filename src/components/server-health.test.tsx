// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ServerHealth, type HealthServer } from "./server-health";
import type { Identity } from "@/lib/api-client";
const identity: Identity = {
  user: { id: "user", name: "Operator", email: "operator@example.com" },
  organization: { id: "org", name: "Rust community" },
  organizations: [],
  membershipId: "member",
  permissions: ["servers.view", "servers.manage"],
};
function server(overrides: Partial<HealthServer> = {}): HealthServer {
  return {
    id: "one",
    name: "Main Rust",
    checkedAt: Date.now(),
    rconStatus: "connected",
    a2sStatus: "connected",
    players: 0,
    playersAt: Date.now(),
    playersSource: "rcon",
    ...overrides,
  };
}
function response(servers: HealthServer[], organizationId = "org") {
  return Response.json({ organizationId, servers });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("loads saved health, shows zero players, and refreshes with the keyboard", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response([server()]))
    .mockResolvedValueOnce(response([server({ players: 12 })]));
  const user = userEvent.setup();
  render(<ServerHealth identity={identity} />);
  expect(screen.getByRole("status").textContent).toContain(
    "Loading server health",
  );
  expect(await screen.findByText("Healthy")).not.toBeNull();
  expect(screen.getByText("0")).not.toBeNull();
  screen.getByRole("button", { name: "Refresh health" }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText("12")).not.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([
  [
    "Awaiting first check",
    {
      checkedAt: null,
      players: null,
      playersAt: null,
      rconStatus: null,
      a2sStatus: null,
    },
  ],
  [
    "Unavailable",
    {
      players: null,
      playersAt: null,
      rconStatus: "timeout",
      a2sStatus: "unreachable",
    },
  ],
  ["Degraded", { rconStatus: "authentication_failed", playersSource: "a2s" }],
  ["Stale", { checkedAt: 1, playersAt: 1 }],
] as const)(
  "shows %s without implying fresh healthy data",
  async (state, values) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response([server(values)]));
    render(<ServerHealth identity={identity} />);
    expect(await screen.findByText(state)).not.toBeNull();
    expect(screen.queryByText("Healthy")).toBeNull();
  },
);
it("preserves the last count after failed probes and a failed refresh", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      response([
        server({ players: 42, rconStatus: "timeout", a2sStatus: "timeout" }),
      ]),
    )
    .mockRejectedValueOnce(new Error("Network unavailable"));
  const user = userEvent.setup();
  render(<ServerHealth identity={identity} />);
  expect(await screen.findByText("Last known players")).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh health" }));
  expect(await screen.findByRole("alert")).not.toBeNull();
  expect(screen.getByText("42")).not.toBeNull();
  expect(screen.getByText("Stale")).not.toBeNull();
});
it("clears saved readings when access is revoked", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response([server()]))
    .mockResolvedValueOnce(Response.json({}, { status: 403 }));
  const user = userEvent.setup();
  render(<ServerHealth identity={identity} />);
  await screen.findByText("Main Rust");
  await user.click(screen.getByRole("button", { name: "Refresh health" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Main Rust")).toBeNull();
});
it("rejects a response for another active tenant", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    response([server({ name: "Other tenant secret" })], "other"),
  );
  render(<ServerHealth identity={identity} />);
  await screen.findByRole("alert");
  expect(screen.queryByText("Other tenant secret")).toBeNull();
});
it("discards previous tenant state and ignores its late response", async () => {
  let finish!: (r: Response) => void;
  vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(response([], "other"));
  const view = render(<ServerHealth identity={identity} />);
  view.rerender(
    <ServerHealth
      identity={{ ...identity, organization: { id: "other", name: "Other" } }}
    />,
  );
  await screen.findByText("No servers yet");
  await act(async () => finish(response([server({ name: "Old tenant" })])));
  expect(screen.queryByText("Old tenant")).toBeNull();
});
it("does not request health without viewing permission", () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  render(<ServerHealth identity={{ ...identity, permissions: [] }} />);
  expect(screen.getByText(/need server viewing permission/)).not.toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("ages readings even while the next request is pending", async () => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(response([server()]))
    .mockImplementation(() => new Promise(() => {}));
  render(<ServerHealth identity={identity} />);
  await act(async () => {});
  expect(screen.getByText("Healthy")).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(91_000);
  });
  expect(screen.getByText("Stale")).not.toBeNull();
  expect(screen.getByText("Last known players")).not.toBeNull();
});
