// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiscordGuilds, type DiscordGuild } from "./discord-guilds";
import type { Identity } from "@/lib/api-client";

const { success } = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success } }));

const identity: Identity = {
  user: { id: "operator", name: "Operator", email: "operator@example.com" },
  organization: { id: "org", name: "Rust community" },
  organizations: [],
  membershipId: "member",
  permissions: ["community.view"],
};
const guilds: DiscordGuild[] = [
  {
    id: "110000000000000001",
    name: "Northstar Rust",
    iconHash: null,
    bannerHash: null,
    homeHeaderHash: null,
    access: "owner",
    memberCount: 4812,
    connectedAt: Date.UTC(2026, 10, 1),
  },
  {
    id: "110000000000000004",
    name: "Frontier Partners",
    iconHash: null,
    bannerHash: null,
    homeHeaderHash: null,
    access: "manager",
    memberCount: null,
    connectedAt: Date.UTC(2026, 10, 2),
  },
];
beforeEach(() => vi.restoreAllMocks());
afterEach(() => cleanup());

it("lists the organization's guilds", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json(guilds));
  render(<DiscordGuilds identity={identity} />);
  const list = await screen.findByRole("list", { name: "Discord guilds" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText("4,812 members")).toBeTruthy();
  expect(within(list).getByText("Members unknown")).toBeTruthy();
  const [path, init] = fetcher.mock.calls[0]!;
  expect(path).toBe("/app-api/discord/guilds");
  expect(
    (init?.headers as Record<string, string>)["X-Cupboard-Organization"],
  ).toBe("org");

  expect(screen.queryByText("Owner")).toBeNull();
  expect(screen.queryByLabelText("Search guilds")).toBeNull();
});

it("shows an empty state when no guilds are linked", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
  render(<DiscordGuilds identity={identity} />);
  expect(await screen.findByText("No guilds yet")).toBeTruthy();
});

it("does not request guilds without community viewing permission", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  render(
    <DiscordGuilds identity={{ ...identity, permissions: ["servers.view"] }} />,
  );
  expect(
    screen.getByText(/You need community viewing permission/),
  ).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(fetcher).not.toHaveBeenCalled();
});

it("reports a failed load and retries", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ error: "Try again shortly." }, { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json(guilds));
  const user = userEvent.setup();
  render(<DiscordGuilds identity={identity} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Try again shortly.",
  );
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByRole("list", { name: "Discord guilds" }),
  ).toBeTruthy();
});

const manager: Identity = {
  ...identity,
  permissions: ["community.view", "integrations.manage"],
};

it("hides add and remove from operators who cannot manage integrations", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(guilds));
  render(<DiscordGuilds identity={identity} />);
  await screen.findByRole("list", { name: "Discord guilds" });
  expect(screen.queryByRole("button", { name: "Add guild" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Northstar Rust actions" }),
  ).toBeNull();
});

it("sends a managing operator to Discord to add the bot", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json({ url: "https://discord.com/oauth2/authorize?x=1" }),
    );
  const user = userEvent.setup();
  render(<DiscordGuilds identity={manager} />);
  await user.click(await screen.findByRole("button", { name: "Add guild" }));
  expect(fetcher.mock.calls[1]![0]).toBe("/app-api/discord/install/start");
  expect(fetcher.mock.calls[1]![1]?.method).toBe("POST");
  expect(assign).toHaveBeenCalledWith(
    "https://discord.com/oauth2/authorize?x=1",
  );
  vi.unstubAllGlobals();
});

it("explains when Discord installs are unavailable", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json(
        { error: "Discord isn't set up for this Cupboard environment." },
        { status: 503 },
      ),
    );
  const user = userEvent.setup();
  render(<DiscordGuilds identity={manager} />);
  await user.click(await screen.findByRole("button", { name: "Add guild" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Discord isn't set up for this Cupboard environment.",
  );
});

it("announces an added guild once and removes a guild after confirmation", async () => {
  success.mockReset();
  const replace = vi.spyOn(window.history, "replaceState");
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(guilds))
    .mockResolvedValueOnce(Response.json([guilds[1]]));
  const user = userEvent.setup();
  render(<DiscordGuilds identity={manager} added={guilds[0]!.id} />);
  await screen.findByRole("list", { name: "Discord guilds" });
  expect(success).toHaveBeenCalledTimes(1);
  expect(success).toHaveBeenCalledWith("Added Northstar Rust.", {
    position: "top-right",
  });
  expect(replace).toHaveBeenCalledWith(
    null,
    "",
    "/dashboard/community/discord",
  );
  await user.click(
    screen.getByRole("button", { name: "Northstar Rust actions" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(
    within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toContain("The Cupboard bot leaves the guild.");
  await user.click(await screen.findByRole("button", { name: "Remove guild" }));
  await vi.waitFor(() =>
    expect(success).toHaveBeenLastCalledWith("Removed Northstar Rust.", {
      position: "top-right",
    }),
  );
  expect(fetcher.mock.calls[1]![0]).toBe(
    `/app-api/discord/guilds/${guilds[0]!.id}/remove`,
  );
  expect(
    within(screen.getByRole("list", { name: "Discord guilds" })).getAllByRole(
      "listitem",
    ),
  ).toHaveLength(1);
});

it("backs each tile with the banner, then the Server Guide header, then Cupboard art", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json([
      {
        ...guilds[0]!,
        bannerHash: "a".repeat(32),
        homeHeaderHash: "b".repeat(32),
      },
      { ...guilds[1]!, homeHeaderHash: "c".repeat(32) },
      { ...guilds[1]!, id: "110000000000000009", name: "Plain guild" },
    ]),
  );
  render(<DiscordGuilds identity={identity} />);
  const items = within(
    await screen.findByRole("list", { name: "Discord guilds" }),
  ).getAllByRole("listitem");
  const background = (item: HTMLElement) =>
    item.querySelector('[aria-hidden="true"] img')!.getAttribute("src")!;
  expect(background(items[0]!)).toBe(
    `https://cdn.discordapp.com/banners/${guilds[0]!.id}/${"a".repeat(32)}.png?size=480`,
  );
  expect(background(items[1]!)).toBe(
    `https://cdn.discordapp.com/home-headers/${guilds[1]!.id}/${"c".repeat(32)}.png?size=480`,
  );
  expect(background(items[2]!)).toContain("cupboard-coastal-operations");
});
