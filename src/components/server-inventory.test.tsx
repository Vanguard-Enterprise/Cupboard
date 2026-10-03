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
