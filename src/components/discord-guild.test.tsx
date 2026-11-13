// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiscordGuild, type GuildOverview } from "./discord-guild";
import type { Identity } from "@/lib/api-client";

const identity: Identity = {
  user: { id: "operator", name: "Operator", email: "operator@example.com" },
  organization: { id: "org", name: "Rust community" },
  organizations: [],
  membershipId: "member",
  permissions: ["community.view"],
};
const guildId = "130000000000000001";
const overview: GuildOverview = {
  guild: {
    id: guildId,
    name: "Northstar Rust",
    description: "Wipes every Thursday.",
    iconHash: null,
    bannerHash: null,
    homeHeaderHash: null,
    memberCount: 2,
    onlineCount: 1,
    boostTier: 1,
    boostCount: 3,
    verificationLevel: 2,
    locale: "en-US",
    features: ["COMMUNITY"],
    createdAt: Date.UTC(2025, 0, 1),
    connectedAt: Date.UTC(2026, 10, 1),
  },
  channels: [
    {
      id: "c1",
      name: "Info",
      type: 4,
      parentId: null,
      position: 0,
      topic: null,
      nsfw: false,
      private: false,
    },
    {
      id: "c2",
      name: "rules",
      type: 0,
      parentId: "c1",
      position: 0,
      topic: "Read first",
      nsfw: false,
      private: false,
    },
    {
      id: "c3",
      name: "staff",
      type: 0,
      parentId: null,
      position: 1,
      topic: null,
      nsfw: false,
      private: true,
    },
  ],
  roles: [
    {
      id: guildId,
      name: "@everyone",
      color: 0,
      position: 0,
      hoist: false,
      managed: false,
      mentionable: false,
      everyone: true,
      memberCount: 2,
    },
    {
      id: "r1",
      name: "Admins",
      color: 0xff0000,
      position: 1,
      hoist: true,
      managed: false,
      mentionable: true,
      everyone: false,
      memberCount: 1,
    },
  ],
  members: {
    available: true,
    complete: true,
    items: [
      {
        id: "u1",
        username: "ada",
        displayName: "Ada",
        avatarHash: null,
        bot: false,
        joinedAt: "2026-01-01T00:00:00Z",
        roleIds: ["r1"],
      },
      {
        id: "u2",
        username: "cupboard",
        displayName: "Cupboard",
        avatarHash: null,
        bot: true,
        joinedAt: "2026-02-01T00:00:00Z",
        roleIds: [],
      },
    ],
  },
  emojis: [],
  stickers: [],
  events: [
    {
      id: "e1",
      name: "Force wipe",
      startsAt: "2027-03-05T18:30:00Z",
      status: 1,
      userCount: 12,
    },
  ],
  threads: [{ id: "t1", name: "Wipe day", messageCount: 7 }],
  fetchedAt: Date.now() - 3 * 60_000,
  stale: false,
};
beforeEach(() => vi.restoreAllMocks());
afterEach(() => cleanup());

it("shows the guild's details, channels, roles, and members", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json(overview));
  const user = userEvent.setup();
  render(<DiscordGuild identity={identity} guildId={guildId} />);
  expect(
    await screen.findByRole("heading", { name: "Northstar Rust" }),
  ).toBeTruthy();
  expect(fetcher.mock.calls[0]![0]).toBe(`/app-api/discord/guilds/${guildId}`);
  expect(screen.getByText("Level 1, 3 boosts")).toBeTruthy();
  expect(screen.getByText("Updated 3 minutes ago")).toBeTruthy();

  await user.click(screen.getByRole("tab", { name: "Channels" }));
  expect(screen.getByText("Read first")).toBeTruthy();
  expect(screen.getByText("staff").parentElement!.textContent).toContain(
    "Private",
  );

  await user.click(screen.getByRole("tab", { name: "Roles" }));
  const admins = screen.getByRole("row", { name: /Admins/ });
  expect(within(admins).getAllByRole("cell")[1]!.textContent).toBe("1");

  await user.click(screen.getByRole("tab", { name: "Members" }));
  expect(screen.getByText("@cupboard, bot")).toBeTruthy();
  await user.type(screen.getByLabelText("Search members"), "ada");
  expect(screen.queryByText("@cupboard, bot")).toBeNull();

  await user.click(screen.getByRole("tab", { name: "Emojis and events" }));
  expect(screen.getByText("Wipe day")).toBeTruthy();
  // Event starts show the time, not only the day.
  expect(
    screen.getByText("Force wipe").nextElementSibling!.textContent,
  ).toMatch(/\d{1,2}:30\s[AP]M .+, 12 interested$/);
});

it("shows member counts as unknown when Discord withholds the member list", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      ...overview,
      roles: overview.roles.map((role) => ({ ...role, memberCount: null })),
      members: { items: [], available: false, complete: false },
    }),
  );
  const user = userEvent.setup();
  render(<DiscordGuild identity={identity} guildId={guildId} />);
  await screen.findByRole("heading", { name: "Northstar Rust" });
  expect(
    screen.getAllByText(/didn’t share this guild’s member list/),
  ).toHaveLength(2);

  await user.click(screen.getByRole("tab", { name: "Roles" }));
  const admins = screen.getByRole("row", { name: /Admins/ });
  expect(within(admins).getAllByRole("cell")[1]!.textContent).toBe("Unknown");

  await user.click(screen.getByRole("tab", { name: "Members" }));
  expect(screen.queryByLabelText("Search members")).toBeNull();
  expect(
    screen.getByText(/didn’t share this guild’s member list/),
  ).toBeTruthy();
});

it("flags saved readings and partial role counts", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      ...overview,
      fetchedAt: Date.now() - 2 * 86_400_000,
      stale: true,
      members: { ...overview.members, complete: false },
    }),
  );
  const user = userEvent.setup();
  render(<DiscordGuild identity={identity} guildId={guildId} />);
  expect(
    await screen.findByText(
      "Discord didn’t respond, so this is from 2 days ago.",
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "Roles" }));
  expect(
    screen.getByText("Role counts are based on the first 1,000 members."),
  ).toBeTruthy();
});

it("explains when the bot is no longer in the guild", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { error: "The Cupboard bot is no longer in this guild." },
      { status: 409 },
    ),
  );
  render(<DiscordGuild identity={identity} guildId={guildId} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "no longer in this guild",
  );
  expect(screen.getByRole("link", { name: "Back to Discord" })).toBeTruthy();
});
