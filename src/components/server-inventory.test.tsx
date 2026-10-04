// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  const button = await screen.findByRole("button", {
    name: "Test connection for Main Rust",
  });
  expect(screen.getByText("Not checked yet.")).not.toBeNull();
  button.focus();
  await user.keyboard("{Enter}");
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen.getByText("Testing RCON and A2S connections..."),
  ).not.toBeNull();
  await user.click(button);
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
  expect((button as HTMLButtonElement).disabled).toBe(false);
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
  await user.click(
    await screen.findByRole("button", {
      name: "Test connection for Main Rust",
    }),
  );
  expect(
    await screen.findByText(/The previous result is shown/),
  ).not.toBeNull();
  expect(screen.getAllByText("Connected")).toHaveLength(2);
  await user.click(
    screen.getByRole("button", { name: "Test connection for Main Rust" }),
  );
  expect(await screen.findByText(/Authentication failed/)).not.toBeNull();
  expect(screen.queryByText(/The previous result is shown/)).toBeNull();
});
