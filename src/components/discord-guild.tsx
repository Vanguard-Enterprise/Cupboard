"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  HashIcon,
  ImageIcon,
  LockIcon,
  MegaphoneIcon,
  MessagesSquareIcon,
  MicIcon,
  SearchIcon,
  Volume2Icon,
  type LucideIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import { apiRequest, type Identity } from "@/lib/api-client";
import { discordPath } from "@/lib/dashboard-navigation";
import { timeAgo } from "@/lib/status-page";
import { DiscordGuildIcon } from "@/components/discord-guild-icon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Role = {
  id: string;
  name: string;
  color: number;
  position: number;
  hoist: boolean;
  managed: boolean;
  mentionable: boolean;
  everyone: boolean;
  /** Null when Discord didn't share the member list. */
  memberCount: number | null;
};
type Channel = {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  private: boolean;
};
type Member = {
  id: string;
  username: string;
  displayName: string;
  avatarHash: string | null;
  bot: boolean;
  joinedAt: string | null;
  roleIds: string[];
};
export type GuildOverview = {
  guild: {
    id: string;
    name: string;
    description: string | null;
    iconHash: string | null;
    bannerHash: string | null;
    homeHeaderHash: string | null;
    memberCount: number | null;
    onlineCount: number | null;
    boostTier: number;
    boostCount: number;
    verificationLevel: number;
    locale: string | null;
    features: string[];
    createdAt: number | null;
    connectedAt: number;
  };
  channels: Channel[];
  roles: Role[];
  members: { items: Member[]; available: boolean; complete: boolean };
  /** When Cupboard read this from Discord, in milliseconds. */
  fetchedAt: number;
  /** Discord couldn't refresh the guild, so this is an older saved reading. */
  stale: boolean;
  emojis: { id: string; name: string; animated: boolean | null }[];
  stickers: { id: string; name: string }[];
  events: {
    id: string;
    name: string;
    startsAt: string | null;
    status: number;
    userCount: number | null;
  }[];
  threads: { id: string; name: string; messageCount: number | null }[];
};

const numbers = new Intl.NumberFormat("en-US");
const dates = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
// Event starts carry the time and zone, so operators know when to attend.
const times = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const days = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const cdn = "https://cdn.discordapp.com";
const membersHidden =
  "Discord didn’t share this guild’s member list, so member and role counts aren’t available.";

const verification = ["None", "Low", "Medium", "High", "Highest"];
const channelIcons: Record<number, LucideIcon> = {
  0: HashIcon,
  2: Volume2Icon,
  5: MegaphoneIcon,
  13: MicIcon,
  15: MessagesSquareIcon,
  16: ImageIcon,
};
const channelKinds: Record<number, string> = {
  0: "Text",
  2: "Voice",
  5: "Announcement",
  13: "Stage",
  15: "Forum",
  16: "Media",
};

const growthConfig = {
  members: { label: "Members", color: "var(--chart-1)" },
} satisfies ChartConfig;
const roleConfig = {
  members: { label: "Members", color: "var(--chart-1)" },
} satisfies ChartConfig;

const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "The request could not be completed.";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

function roleColor(color: number) {
  return color ? `#${color.toString(16).padStart(6, "0")}` : undefined;
}

// Discord feature flags such as GUILD_ONBOARDING, as sentence case.
function featureName(feature: string) {
  const words = feature.toLowerCase().replaceAll("_", " ");
  return words[0]!.toUpperCase() + words.slice(1);
}

export function DiscordGuild({
  identity,
  guildId,
}: {
  identity: Identity;
  guildId: string;
}) {
  const organization = identity.organization?.id;
  const [data, setData] = useState<GuildOverview | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setError("");
    try {
      const overview = await apiRequest<GuildOverview>(
        `discord/guilds/${guildId}`,
        undefined,
        organization,
      );
      if (mounted.current) setData(overview);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    }
  }, [guildId, organization]);

  useEffect(() => {
    mounted.current = true;
    const initial = setTimeout(() => void load(), 0);
    return () => {
      mounted.current = false;
      clearTimeout(initial);
    };
  }, [load]);

  if (!identity.permissions.includes("community.view"))
    return (
      <section className="mx-auto w-full max-w-7xl p-4 md:p-6">
        <p className="text-sm text-muted-foreground">
          You need community viewing permission to see Discord guilds in this
          organization.
        </p>
      </section>
    );

  if (!data)
    return (
      <section className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
        {error ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-muted-foreground">
              Couldn’t load this guild. {error}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Try again
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link href={discordPath}>Back to Discord</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div role="status" aria-label="Loading guild" className="space-y-6">
            <Skeleton className="h-56 rounded-xl motion-reduce:animate-none" />
            <Skeleton className="h-10 w-96 max-w-full motion-reduce:animate-none" />
            <Skeleton className="h-72 rounded-xl motion-reduce:animate-none" />
          </div>
        )}
      </section>
    );

  const { guild } = data;
  const roles = [...data.roles].sort((a, b) => b.position - a.position);
  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
      <GuildHeader overview={data} />
      <Tabs defaultValue="overview" className="gap-6">
        <div className="no-scrollbar -mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="channels">Channels</TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="more">Emojis and events</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview">
          <Overview overview={data} roles={roles} />
        </TabsContent>
        <TabsContent value="channels">
          <Channels channels={data.channels} />
        </TabsContent>
        <TabsContent value="roles">
          <Roles roles={roles} members={data.members} />
        </TabsContent>
        <TabsContent value="members">
          <Members
            members={data.members}
            roles={roles}
            total={guild.memberCount}
          />
        </TabsContent>
        <TabsContent value="more">
          <Extras overview={data} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function GuildHeader({ overview }: { overview: GuildOverview }) {
  const { guild } = overview;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  const age = timeAgo(overview.fetchedAt, now);
  const background = guild.bannerHash
    ? `${cdn}/banners/${guild.id}/${guild.bannerHash}.png?size=1024`
    : guild.homeHeaderHash
      ? `${cdn}/home-headers/${guild.id}/${guild.homeHeaderHash}.png?size=1024`
      : undefined;
  const stats = [
    ["Members", guild.memberCount],
    ["Online now", guild.onlineCount],
    ["Channels", overview.channels.filter((c) => c.type !== 4).length],
    ["Roles", overview.roles.filter((r) => !r.everyone).length],
  ] as const;
  return (
    <header className="overflow-hidden rounded-xl border border-border bg-card">
      <div
        aria-hidden="true"
        className="relative h-32 bg-surface-elevated md:h-44"
      >
        {background ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={background} alt="" className="size-full object-cover" />
        ) : (
          <Image
            src="/images/cupboard-coastal-operations.webp"
            alt=""
            fill
            sizes="(min-width: 1280px) 1240px, 100vw"
            className="object-cover"
          />
        )}
        <div className="absolute inset-0 bg-linear-to-b from-transparent to-card" />
      </div>
      <div className="relative flex flex-col gap-5 px-5 pb-5 md:flex-row md:items-end md:justify-between md:px-6">
        <div className="-mt-10 flex min-w-0 items-end gap-4">
          <DiscordGuildIcon
            guild={guild}
            className="size-20 ring-4 ring-card"
          />
          <div className="min-w-0 pb-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {guild.name}
            </h1>
            {guild.description && (
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {guild.description}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              <time dateTime={new Date(overview.fetchedAt).toISOString()}>
                {overview.stale
                  ? `Discord didn’t respond, so this is from ${age}.`
                  : `Updated ${age}`}
              </time>
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          {stats.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {value === null ? "Unknown" : numbers.format(value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </header>
  );
}

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Overview({
  overview,
  roles,
}: {
  overview: GuildOverview;
  roles: Role[];
}) {
  const { guild, members } = overview;
  // Cumulative member count on each day someone who is still here joined.
  const joins = members.items
    .map((member) => member.joinedAt)
    .filter((joined): joined is string => Boolean(joined))
    .sort();
  const growth: { day: string; members: number }[] = [];
  joins.forEach((joined, index) => {
    const day = days.format(new Date(joined));
    if (growth.at(-1)?.day === day) growth.at(-1)!.members = index + 1;
    else growth.push({ day, members: index + 1 });
  });
  const roleBars = roles
    .filter((role) => !role.everyone)
    .map((role) => ({ name: role.name, members: role.memberCount ?? 0 }))
    .sort((a, b) => b.members - a.members);
  const sample = members.complete
    ? undefined
    : "Based on the first 1,000 members.";
  const hidden = (
    <p className="text-sm text-muted-foreground">{membersHidden}</p>
  );
  const details = [
    ["Created", guild.createdAt ? dates.format(guild.createdAt) : "Unknown"],
    ["Added to Cupboard", dates.format(guild.connectedAt)],
    ["Verification level", verification[guild.verificationLevel] ?? "Unknown"],
    [
      "Boosts",
      `Level ${guild.boostTier}, ${numbers.format(guild.boostCount)} ${guild.boostCount === 1 ? "boost" : "boosts"}`,
    ],
    ["Language", guild.locale ?? "Unknown"],
    [
      "Features",
      guild.features.length
        ? guild.features.map(featureName).sort().join(", ")
        : "None",
    ],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="Member growth"
        note={
          members.available
            ? (sample ?? "Current members by the day they joined.")
            : undefined
        }
      >
        {!members.available ? (
          hidden
        ) : growth.length > 1 ? (
          <ChartContainer
            config={growthConfig}
            className="h-56 w-full [&_.recharts-cartesian-grid_line]:opacity-50"
            initialDimension={{ width: 560, height: 224 }}
            role="img"
            aria-label={`Member growth to ${numbers.format(joins.length)} members`}
          >
            <AreaChart
              accessibilityLayer
              data={growth}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                minTickGap={48}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={40}
                allowDecimals={false}
              />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent indicator="line" />}
              />
              <Area
                dataKey="members"
                type="stepAfter"
                fill="var(--color-members)"
                fillOpacity={0.08}
                stroke="var(--color-members)"
                strokeWidth={2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not enough join history to chart yet.
          </p>
        )}
      </Panel>
      <Panel
        title="Members by role"
        note={members.available ? sample : undefined}
      >
        {!members.available ? (
          hidden
        ) : roleBars.length ? (
          <ChartContainer
            config={roleConfig}
            className="w-full"
            style={{ height: Math.max(120, roleBars.length * 36) }}
            initialDimension={{ width: 560, height: 224 }}
            role="img"
            aria-label="Members in each role"
          >
            <BarChart
              accessibilityLayer
              data={roleBars}
              layout="vertical"
              margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
            >
              <XAxis type="number" hide allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="name"
                tickLine={false}
                axisLine={false}
                width={128}
              />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent hideIndicator />}
              />
              <Bar
                dataKey="members"
                fill="var(--color-members)"
                radius={[0, 4, 4, 0]}
                barSize={18}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        ) : (
          <p className="text-sm text-muted-foreground">No roles yet.</p>
        )}
      </Panel>
      <div className="min-w-0 lg:col-span-2">
        <Panel title="Server details">
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {details.map(([label, value]) => (
              <div
                key={label}
                className={
                  label === "Features" ? "sm:col-span-2 lg:col-span-3" : ""
                }
              >
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </div>
  );
}

function Channels({ channels }: { channels: Channel[] }) {
  const byPosition = (a: Channel, b: Channel) => a.position - b.position;
  const categories = channels.filter((c) => c.type === 4).sort(byPosition);
  const children = (parentId: string | null) =>
    channels
      .filter((c) => c.type !== 4 && c.parentId === parentId)
      .sort(byPosition);
  const groups = [
    { id: null, name: "No category", private: false },
    ...categories,
  ]
    .map((category) => ({ category, items: children(category.id) }))
    .filter((group) => group.items.length || group.category.id);
  if (!channels.length)
    return <p className="text-sm text-muted-foreground">No channels.</p>;
  return (
    <div className="space-y-4">
      {groups.map(({ category, items }) => (
        <div
          key={category.id ?? "none"}
          className="rounded-xl border border-border bg-card"
        >
          <h2 className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-semibold">
            {category.name}
            {category.private && <PrivateMark />}
          </h2>
          {items.length ? (
            <ul className="divide-y divide-border">
              {items.map((channel) => {
                const Icon = channelIcons[channel.type] ?? HashIcon;
                return (
                  <li
                    key={channel.id}
                    className="flex min-w-0 items-center gap-3 px-5 py-3"
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="sr-only">
                      {channelKinds[channel.type] ?? "Other"} channel
                    </span>
                    <span className="shrink-0 text-sm font-medium">
                      {channel.name}
                    </span>
                    {channel.private && <PrivateMark />}
                    {channel.topic && (
                      <span className="truncate text-sm text-muted-foreground">
                        {channel.topic}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-5 py-3 text-sm text-muted-foreground">
              No channels in this category.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function PrivateMark() {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
      <LockIcon aria-hidden="true" className="size-3.5" />
      Private
    </span>
  );
}

function RoleDot({ role }: { role: Pick<Role, "color"> }) {
  const color = roleColor(role.color);
  return (
    <span
      aria-hidden="true"
      className="size-3 shrink-0 rounded-full border border-input"
      style={color ? { backgroundColor: color, borderColor: color } : undefined}
    />
  );
}

function Roles({
  roles,
  members,
}: {
  roles: Role[];
  members: GuildOverview["members"];
}) {
  const yes = (value: boolean) => (value ? "Yes" : "No");
  return (
    <div className="space-y-4">
      {members.available && !members.complete && (
        <p className="text-sm text-muted-foreground">
          Role counts are based on the first 1,000 members.
        </p>
      )}
      <div className="rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Role</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead>Shown separately</TableHead>
              <TableHead>Mentionable</TableHead>
              <TableHead className="pr-5">Managed by an app</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.id}>
                <TableCell className="pl-5">
                  <span className="flex items-center gap-2 font-medium">
                    <RoleDot role={role} />
                    {role.name}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {role.memberCount === null ? (
                    <span className="text-muted-foreground">Unknown</span>
                  ) : (
                    numbers.format(role.memberCount)
                  )}
                </TableCell>
                <TableCell>{yes(role.hoist)}</TableCell>
                <TableCell>{yes(role.mentionable)}</TableCell>
                <TableCell className="pr-5">{yes(role.managed)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function Members({
  members,
  roles,
  total,
}: {
  members: GuildOverview["members"];
  roles: Role[];
  total: number | null;
}) {
  const [query, setQuery] = useState("");
  const names = new Map(roles.map((role) => [role.id, role]));
  if (!members.available)
    return (
      <p className="rounded-xl border border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        {membersHidden}
      </p>
    );
  const search = query.trim().toLowerCase();
  const visible = members.items
    .filter(
      (member) =>
        !search ||
        member.displayName.toLowerCase().includes(search) ||
        member.username.toLowerCase().includes(search),
    )
    .sort((a, b) => (a.joinedAt ?? "").localeCompare(b.joinedAt ?? ""));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full md:w-72">
          <SearchIcon className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label="Search members"
            placeholder="Search members..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {!members.complete && total !== null && (
          <p className="text-sm text-muted-foreground">
            Showing the first {numbers.format(members.items.length)} of{" "}
            {numbers.format(total)} members.
          </p>
        )}
      </div>
      <div className="rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Member</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="pr-5">Roles</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((member) => {
              const memberRoles = member.roleIds
                .map((id) => names.get(id))
                .filter((role): role is Role => Boolean(role))
                .sort((a, b) => b.position - a.position);
              return (
                <TableRow key={member.id}>
                  <TableCell className="pl-5">
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar size="sm">
                        <AvatarImage
                          src={
                            member.avatarHash
                              ? `${cdn}/avatars/${member.id}/${member.avatarHash}.png?size=64`
                              : undefined
                          }
                          alt=""
                        />
                        <AvatarFallback>
                          {initials(member.displayName)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {member.displayName}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          @{member.username}
                          {member.bot && ", bot"}
                        </span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {member.joinedAt
                      ? dates.format(new Date(member.joinedAt))
                      : "Unknown"}
                  </TableCell>
                  <TableCell className="pr-5">
                    {memberRoles.length ? (
                      <span className="flex flex-wrap gap-x-3 gap-y-1">
                        {memberRoles.map((role) => (
                          <span
                            key={role.id}
                            className="flex items-center gap-1.5 text-sm"
                          >
                            <RoleDot role={role} />
                            {role.name}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {visible.length === 0 && (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            No members match your search.
          </p>
        )}
      </div>
    </div>
  );
}

function Extras({ overview }: { overview: GuildOverview }) {
  const none = (what: string) => (
    <p className="text-sm text-muted-foreground">No {what}.</p>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Emojis">
        {overview.emojis.length ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-3">
            {overview.emojis.map((emoji) => (
              <li key={emoji.id} className="flex flex-col items-center gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${cdn}/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}?size=48`}
                  alt=""
                  className="size-8"
                />
                <span className="w-full truncate text-center text-xs text-muted-foreground">
                  :{emoji.name}:
                </span>
              </li>
            ))}
          </ul>
        ) : (
          none("custom emojis")
        )}
      </Panel>
      <Panel title="Stickers">
        {overview.stickers.length ? (
          <ul className="space-y-1 text-sm">
            {overview.stickers.map((sticker) => (
              <li key={sticker.id}>{sticker.name}</li>
            ))}
          </ul>
        ) : (
          none("stickers")
        )}
      </Panel>
      <Panel title="Scheduled events">
        {overview.events.length ? (
          <ul className="divide-y divide-border">
            {overview.events.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:justify-between sm:gap-4"
              >
                <span className="min-w-0 font-medium break-words">
                  {event.name}
                </span>
                <span className="text-muted-foreground tabular-nums sm:shrink-0">
                  {event.startsAt ? times.format(new Date(event.startsAt)) : ""}
                  {event.userCount !== null &&
                    `, ${numbers.format(event.userCount)} interested`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          none("scheduled events")
        )}
      </Panel>
      <Panel title="Active threads">
        {overview.threads.length ? (
          <ul className="divide-y divide-border">
            {overview.threads.map((thread) => (
              <li
                key={thread.id}
                className="flex justify-between gap-4 py-2 text-sm"
              >
                <span className="truncate font-medium">{thread.name}</span>
                {thread.messageCount !== null && (
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {numbers.format(thread.messageCount)} messages
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          none("active threads")
        )}
      </Panel>
    </div>
  );
}
