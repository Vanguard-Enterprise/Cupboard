// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerInventory } from "./server-inventory";
import type { Identity } from "@/lib/api-client";
afterEach(() => cleanup());
const identity: Identity = {
  user: { id: "operator", name: "Operator", email: "operator@example.com" },
  organization: { id: "org", name: "Rust community" },
  organizations: [],
  membershipId: "member",
  permissions: ["servers.view", "servers.manage"],
};
const server = {
  id: "server",
  name: "Main Rust",
  rconHost: "rust.example.com",
  rconPort: 28016,
  a2sHost: "rust.example.com",
  a2sPort: 28017,
};
async function checkAction(user: ReturnType<typeof userEvent.setup>) {
  const existing = screen.queryByRole("menuitem", {
    name: "Test connection for Main Rust",
  });
  if (existing) return existing;
  await user.click(
    await screen.findByRole("button", { name: "Actions for Main Rust" }),
  );
  return screen.findByRole("menuitem", {
    name: "Test connection for Main Rust",
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
});
it("adds a server, clears its secret, and shows persisted addresses", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json(server))
    .mockResolvedValueOnce(Response.json([server]));
  const user = userEvent.setup();
  render(<ServerInventory identity={identity} />);
  expect(await screen.findByText("No servers yet")).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Add server" }));
  await user.type(screen.getByLabelText("Server name"), "Main Rust");
  await user.type(screen.getByLabelText("RCON host"), "rust.example.com");
  await user.type(screen.getByLabelText("A2S host"), "rust.example.com");
  await user.type(screen.getByLabelText("RCON password"), "sensitive-value");
  await user.click(
    screen.getAllByRole("button", { name: "Add server" }).at(-1)!,
  );
  expect(
    await screen.findByRole("heading", { name: "Main Rust" }),
  ).not.toBeNull();
  expect(screen.queryByDisplayValue("sensitive-value")).toBeNull();
  expect(fetch.mock.calls[1][1]?.body).toContain('"rconPort":28016');
  await user.click(screen.getByRole("button", { name: "Add server" }));
  expect(
    (screen.getByLabelText("RCON password") as HTMLInputElement).value,
  ).toBe("");
});
it("keeps edits and focuses the first invalid field", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json(
        {
          error: "Check the highlighted fields.",
          fields: { name: "Enter a name." },
        },
        { status: 422 },
      ),
    );
  const user = userEvent.setup();
  render(<ServerInventory identity={identity} />);
  await screen.findByText("No servers yet");
  await user.click(screen.getByRole("button", { name: "Add server" }));
  await user.type(screen.getByLabelText("RCON password"), "kept-secret");
  await user.click(
    screen.getAllByRole("button", { name: "Add server" }).at(-1)!,
  );
  expect(await screen.findByText("Enter a name.")).not.toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("Server name"));
  expect(
    (screen.getByLabelText("RCON password") as HTMLInputElement).value,
  ).toBe("kept-secret");
});
it("hides mutation controls from viewers", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([server]));
  render(
    <ServerInventory
      identity={{ ...identity, permissions: ["servers.view"] }}
    />,
  );
  await screen.findByText("Main Rust");
  expect(screen.queryByRole("button", { name: "Add server" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Test connection/ })).toBeNull();
});
it("does not load inventory without viewing permission", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  render(<ServerInventory identity={{ ...identity, permissions: [] }} />);
  await waitFor(() =>
    expect(
      screen.getByText(/You need server viewing permission/),
    ).not.toBeNull(),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("displays IPv6 endpoints with brackets and preserves hostname formatting", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json([
      server,
      {
        ...server,
        id: "ipv6",
        name: "IPv6 Rust",
        rconHost: "2001:db8::1",
        a2sHost: "2001:db8::2",
      },
    ]),
  );
  render(<ServerInventory identity={identity} />);
  expect(await screen.findByText("[2001:db8::1]:28016")).not.toBeNull();
  expect(screen.getByText("[2001:db8::2]:28017")).not.toBeNull();
  expect(screen.getByText("rust.example.com:28016")).not.toBeNull();
  expect(screen.getByText("rust.example.com:28017")).not.toBeNull();
});

it("retains the last successful load time after refresh failure and clears stale state on retry", async () => {
  const loadedAt = Date.parse("2026-10-03T12:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(loadedAt);
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([server]))
    .mockResolvedValueOnce(
      Response.json({ ...server, id: "new", name: "Another Rust" }),
    )
    .mockResolvedValueOnce(
      Response.json({ error: "Refresh failed." }, { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json([server]));
  const user = userEvent.setup();
  const { container } = render(<ServerInventory identity={identity} />);
  await screen.findByText("Main Rust");
  clock.mockReturnValue(loadedAt + 60000);
  await user.click(screen.getByRole("button", { name: "Add server" }));
  await user.type(screen.getByLabelText("Server name"), "Another Rust");
  await user.type(screen.getByLabelText("RCON host"), "rust.example.com");
  await user.type(screen.getByLabelText("A2S host"), "rust.example.com");
  await user.type(screen.getByLabelText("RCON password"), "new-secret");
  await user.click(
    screen.getAllByRole("button", { name: "Add server" }).at(-1)!,
  );
  await screen.findByText(/The server list may be out of date/);
  expect(screen.getByText("Main Rust")).not.toBeNull();
  expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-10-03T12:00:00.000Z",
  );
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(screen.queryByText(/The server list may be out of date/)).toBeNull(),
  );
});

it("clears rejected edits and validation errors when Cancel closes the form", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json(
        {
          error: "Check the highlighted fields.",
          fields: { name: "Enter a name." },
        },
        { status: 422 },
      ),
    );
  const user = userEvent.setup();
  render(<ServerInventory identity={identity} />);
  await screen.findByText("No servers yet");
  await user.click(screen.getByRole("button", { name: "Add server" }));
  await user.type(screen.getByLabelText("RCON password"), "discarded-secret");
  await user.click(
    screen.getAllByRole("button", { name: "Add server" }).at(-1)!,
  );
  await screen.findByText("Enter a name.");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Add server" }));
  expect(screen.queryByText("Enter a name.")).toBeNull();
  expect(screen.queryByText("Check the highlighted fields.")).toBeNull();
  expect(
    screen.getByLabelText("Server name").getAttribute("aria-invalid"),
  ).toBe("false");
  expect(
    (screen.getByLabelText("RCON password") as HTMLInputElement).value,
  ).toBe("");
});

it("tests connections by keyboard, disables duplicate checks, and displays saved partial results", async () => {
  let complete!: (response: Response) => void;
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([server]))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  const user = userEvent.setup();
  render(<ServerInventory identity={identity} />);
  const button = await checkAction(user);
  expect(screen.getByText("Not checked yet.")).not.toBeNull();
  button.focus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("menu")).toBeNull();
  const pending = await checkAction(user);
  expect(pending.hasAttribute("data-disabled")).toBe(true);
  expect(
    screen.getByText("Testing RCON and A2S connections..."),
  ).not.toBeNull();
  await user.click(pending);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toBe("/app-api/servers/server/check");
  expect(fetch.mock.calls[1][1]?.method).toBe("POST");
  expect(fetch.mock.calls[1][1]?.body).toBe("{}");
  complete(
    Response.json({
      ...server,
      checkedAt: Date.parse("2026-10-04T12:00:00Z"),
      rconStatus: "connected",
      a2sStatus: "timeout",
    }),
  );
  expect(await screen.findByText("Connected")).not.toBeNull();
  expect(
    screen.getByText(/Timed out. Check that the server is running/),
  ).not.toBeNull();
  expect(pending.hasAttribute("data-disabled")).toBe(false);
});

it("keeps the last saved result after an unsuccessful check request and allows retry", async () => {
  const saved = {
    ...server,
    checkedAt: Date.parse("2026-10-04T12:00:00Z"),
    rconStatus: "connected",
    a2sStatus: "connected",
  };
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([saved]))
    .mockResolvedValueOnce(
      Response.json({ error: "Connection checks are busy." }, { status: 429 }),
    )
    .mockResolvedValueOnce(
      Response.json({ ...saved, rconStatus: "authentication_failed" }),
    );
  const user = userEvent.setup();
  render(<ServerInventory identity={identity} />);
  await user.click(await checkAction(user));
  expect(
    await screen.findByText(/The previous result is shown/),
  ).not.toBeNull();
  expect(screen.getAllByText("Connected")).toHaveLength(2);
  await user.click(await checkAction(user));
  expect(await screen.findByText(/Authentication failed/)).not.toBeNull();
  expect(screen.queryByText(/The previous result is shown/)).toBeNull();
});

it("shows Pelican readings in the machines-style inventory and opens monitoring from the server name", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    /\/(?:resources|observation)$/.test(String(input))
      ? Response.json({
          state: "running",
          resources: {
            cpu_absolute: 14.5,
            memory_bytes: 1048576,
            disk_bytes: 2097152,
            network_rx_bytes: 100,
            network_tx_bytes: 50,
            uptime: 1000,
          },
        })
      : Response.json([{ ...server, panelServerUuid: "panel-server" }]),
  );
  const user = userEvent.setup();
  render(<ServerInventory identity={identity} />);
  expect(await screen.findByText("14.5%")).not.toBeNull();
  expect(screen.getByRole("columnheader", { name: "CPU" })).not.toBeNull();
  await user.type(
    screen.getByRole("textbox", { name: "Search servers" }),
    "missing",
  );
  expect(screen.getByText("No servers match your search.")).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  await user.click(screen.getByRole("button", { name: "Main Rust" }));
  expect(await screen.findByRole("tab", { name: "Console" })).not.toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back to servers" }));
  expect(screen.getByRole("table", { name: "Game servers" })).not.toBeNull();
});
it("retains stale resources on refresh failure and clears the error after recovery", async () => {
  let refresh: (() => void) | undefined;
  const originalInterval = globalThis.setInterval.bind(globalThis);
  const interval = vi
    .spyOn(window, "setInterval")
    .mockImplementation((callback, delay) => {
      if (delay === 30_000) refresh = callback as () => void;
      const handle = originalInterval(() => {}, 30_000);
      window.clearInterval(handle);
      return handle;
    });
  let fail = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!/\/(?:resources|observation)$/.test(String(input)))
      return Response.json([{ ...server, panelServerUuid: "panel" }]);
    if (fail) throw new Error("Panel temporarily unavailable");
    return Response.json({
      state: "running",
      resources: {
        cpu_absolute: 14.5,
        memory_bytes: 1048576,
        disk_bytes: 2097152,
        network_rx_bytes: 100,
        network_tx_bytes: 50,
      },
    });
  });
  render(<ServerInventory identity={identity} />);
  await screen.findByText("14.5%");
  fail = true;
  await act(async () => refresh?.());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Panel temporarily unavailable",
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Stale resources · Last observed",
  );
  expect(screen.getByText("14.5%")).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "Main Rust: Stale" }),
  ).not.toBeNull();
  fail = false;
  await act(async () => refresh?.());
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(
    screen.getByRole("button", { name: "Main Rust: Running" }),
  ).not.toBeNull();
  interval.mockRestore();
});
it("refreshes later servers while an earlier panel request is slow with at most three background requests", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  let observedLater = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (!/\/(?:resources|observation)$/.test(path))
      return Response.json(
        Array.from({ length: 6 }, (_, index) => ({
          ...server,
          id: `server-${index}`,
          name: `Rust ${index}`,
          panelServerUuid: `panel-${index}`,
        })),
      );
    active++;
    peak = Math.max(peak, active);
    if (path.includes("server-0/")) await slow;
    else if (path.includes("server-5/")) observedLater = true;
    active--;
    return Response.json({
      state: "running",
      resources: {
        cpu_absolute: path.includes("server-0/") ? 11 : 22,
        memory_bytes: 1024,
        disk_bytes: 1024,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
      },
    });
  });
  render(<ServerInventory identity={identity} />);
  try {
    await waitFor(() => expect(observedLater).toBe(true));
    expect(screen.queryByText("11.0%")).toBeNull();
    expect(screen.getAllByText("22.0%").length).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(3);
  } finally {
    await act(async () => release());
  }
  expect(await screen.findByText("11.0%")).not.toBeNull();
});
it("keeps an in-flight resource pass when server metadata updates with unchanged panel IDs", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const imported = { ...server, panelServerUuid: "panel" };
  let resourceRequests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/check"))
      return Response.json({
        ...imported,
        checkedAt: Date.now(),
        rconStatus: "connected",
        a2sStatus: "connected",
      });
    if (!/\/(?:resources|observation)$/.test(path))
      return Response.json([imported]);
    resourceRequests++;
    await slow;
    return Response.json({
      state: "running",
      resources: {
        cpu_absolute: 14.5,
        memory_bytes: 1024,
        disk_bytes: 1024,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
      },
    });
  });
  const user = userEvent.setup();
  render(<ServerInventory identity={identity} />);
  await waitFor(() => expect(resourceRequests).toBe(1));
  try {
    await user.click(await checkAction(user));
    await screen.findByText(/Last checked/);
  } finally {
    await act(async () => release());
  }
  expect(await screen.findByText("14.5%")).not.toBeNull();
  expect(resourceRequests).toBe(1);
});
it("reserves a panel slot for foreground monitoring while background requests are pending", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let requests = 0;
  let observations = 0;
  let foreground = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!/\/(?:resources|observation)$/.test(String(input)))
      return Response.json(
        Array.from({ length: 5 }, (_, index) => ({
          ...server,
          id: `server-${index}`,
          name: `Rust ${index}`,
          panelServerUuid: `panel-${index}`,
        })),
      );
    requests++;
    if (String(input).endsWith("/observation")) observations++;
    else foreground++;
    active++;
    if (active > 4)
      return Response.json(
        { error: "Panel operations are busy." },
        { status: 429 },
      );
    await pending;
    active--;
    return Response.json({
      state: "running",
      resources: {
        cpu_absolute: 14.5,
        memory_bytes: 1024,
        disk_bytes: 1024,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
        uptime: 1000,
      },
    });
  });
  const user = userEvent.setup();
  render(<ServerInventory identity={identity} />);
  try {
    await waitFor(() => expect(requests).toBe(3));
    expect(active).toBe(3);
    expect(observations).toBe(3);
    expect(foreground).toBe(0);
    await user.click(screen.getByRole("button", { name: "Rust 0" }));
    await waitFor(() => expect(requests).toBe(4));
    expect(active).toBe(4);
    expect(observations).toBe(3);
    expect(foreground).toBe(1);
    expect(screen.queryByText("Panel operations are busy.")).toBeNull();
  } finally {
    await act(async () => release());
  }
  expect(await screen.findByText("14.5%")).not.toBeNull();
});
