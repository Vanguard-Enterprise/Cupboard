"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MoreHorizontalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { apiRequest, type Identity } from "@/lib/api-client";
import { DiscordGuildIcon } from "@/components/discord-guild-icon";
import { DiscordIcon } from "@/components/discord-icon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { discordPath } from "@/lib/dashboard-navigation";
import { toast } from "sonner";

export type DiscordGuild = {
  id: string;
  name: string;
  iconHash: string | null;
  bannerHash: string | null;
  homeHeaderHash: string | null;
  access: "owner" | "manager";
  memberCount: number | null;
  connectedAt: number;
};

const numbers = new Intl.NumberFormat("en-US");

const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "The request could not be completed.";

export function DiscordGuilds({
  identity,
  added,
}: {
  identity: Identity;
  added?: string;
}) {
  const organization = identity.organization?.id;
  const view = identity.permissions.includes("community.view");
  const manage = identity.permissions.includes("integrations.manage");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [removing, setRemoving] = useState<DiscordGuild | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [guilds, setGuilds] = useState<DiscordGuild[] | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const announced = useRef(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const records = await apiRequest<DiscordGuild[]>(
        "discord/guilds",
        undefined,
        organization,
      );
      if (!mounted.current) return;
      setGuilds(records);
      // Announce a guild that just came back from Discord once, then drop the
      // marker so a reload doesn't repeat it.
      if (added && !announced.current) {
        announced.current = true;
        const guild = records.find((record) => record.id === added);
        if (guild)
          toast.success(`Added ${guild.name}.`, { position: "top-right" });
        window.history.replaceState(null, "", discordPath);
      }
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    }
  }, [organization, added]);

  async function add() {
    if (adding) return;
    setAdding(true);
    setAddError("");
    try {
      const { url } = await apiRequest<{ url: string }>(
        "discord/install/start",
        {},
        organization,
      );
      // Leaving the page while Discord's URL loads cancels the install.
      if (mounted.current) window.location.assign(url);
    } catch (cause) {
      if (mounted.current) {
        setAddError(message(cause));
        setAdding(false);
      }
    }
  }

  async function remove() {
    if (!removing || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError("");
    try {
      const records = await apiRequest<DiscordGuild[]>(
        `discord/guilds/${removing.id}/remove`,
        {},
        organization,
      );
      if (!mounted.current) return;
      setGuilds(records);
      toast.success(`Removed ${removing.name}.`, { position: "top-right" });
      setRemoving(null);
    } catch (cause) {
      if (mounted.current) setRemoveError(message(cause));
    } finally {
      if (mounted.current) setRemoveBusy(false);
    }
  }

  const addButton = manage && (
    <Button aria-disabled={adding} onClick={() => void add()}>
      <PlusIcon aria-hidden="true" />
      {adding ? "Opening Discord..." : "Add guild"}
    </Button>
  );

  useEffect(() => {
    mounted.current = true;
    const initial = setTimeout(() => {
      if (view) void load();
    }, 0);
    return () => {
      mounted.current = false;
      clearTimeout(initial);
    };
  }, [view, load]);

  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Discord</h1>
        {view && guilds && guilds.length > 0 && addButton}
      </div>
      {addError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t open Discord. {addError}
        </p>
      )}
      {!view ? (
        <p className="text-sm text-muted-foreground">
          You need community viewing permission to see Discord guilds in this
          organization.
        </p>
      ) : !guilds && error ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-muted-foreground">
            Couldn’t load Discord guilds. {error}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : !guilds ? (
        <div role="status" aria-label="Loading Discord guilds">
          <GuildGridSkeleton />
        </div>
      ) : guilds.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-12 text-center">
          <DiscordIcon className="mx-auto mb-4 size-8 text-muted-foreground" />
          <h2 className="font-semibold">No guilds yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {manage
              ? "Add the Cupboard bot to a Discord server you own or manage, and the server appears here. The bot asks for no permissions."
              : "Ask someone who manages integrations to add a Discord server."}
          </p>
          {manage && <div className="mt-6">{addButton}</div>}
        </div>
      ) : (
        <ul
          aria-label="Discord guilds"
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4"
        >
          {guilds.map((guild) => (
            <li
              key={guild.id}
              className="relative aspect-square min-w-0 overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-input"
            >
              <GuildBanner guild={guild} />
              {manage && (
                <div className="absolute right-2 top-2 z-10">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="bg-background/70 backdrop-blur-sm hover:bg-background/90"
                        aria-label={`${guild.name} actions`}
                      >
                        <MoreHorizontalIcon aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          setRemoveError("");
                          setRemoving(guild);
                        }}
                      >
                        <Trash2Icon aria-hidden="true" />
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
              <Link
                href={`${discordPath}/${guild.id}`}
                className="relative grid h-full grid-rows-[1fr_auto_1fr] justify-items-center rounded-xl px-4 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {/* The logo sits at the tile's exact center, with the
                        name and member count below it. */}
                <DiscordGuildIcon
                  guild={guild}
                  className="row-start-2 size-20"
                />
                <div className="row-start-3 w-full min-w-0 pt-3">
                  <h2 className="truncate text-base font-medium">
                    {guild.name}
                  </h2>
                  <p className="mt-0.5 text-sm tabular-nums text-muted-foreground">
                    {guild.memberCount === null
                      ? "Members unknown"
                      : `${numbers.format(guild.memberCount)} ${guild.memberCount === 1 ? "member" : "members"}`}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !removeBusy) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <ul className="list-disc space-y-1 pl-5 text-left">
                <li>The Cupboard bot leaves the guild.</li>
                <li>
                  The guild disappears from Cupboard, including for any other
                  organization that added it.
                </li>
                <li>
                  Messages, roles, and members in Discord stay as they are.
                </li>
                <li>You can add the guild again at any time.</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && (
            <p role="alert" className="text-sm text-destructive">
              {removeError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              aria-disabled={removeBusy}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {removeBusy ? "Removing guild..." : "Remove guild"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// The top half of a tile: the guild's banner, else its Server Guide header,
// else Cupboard's own artwork, fading into the tile.
function GuildBanner({ guild }: { guild: DiscordGuild }) {
  const discord = guild.bannerHash
    ? `https://cdn.discordapp.com/banners/${guild.id}/${guild.bannerHash}.png?size=480`
    : guild.homeHeaderHash
      ? `https://cdn.discordapp.com/home-headers/${guild.id}/${guild.homeHeaderHash}.png?size=480`
      : undefined;
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 h-1/2 overflow-hidden bg-surface-elevated"
    >
      {discord ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={discord} alt="" className="size-full object-cover" />
      ) : (
        <Image
          src="/images/cupboard-coastal-operations.webp"
          alt=""
          fill
          sizes="(min-width: 1280px) 20vw, (min-width: 640px) 33vw, 50vw"
          className="object-cover"
        />
      )}
      <div className="absolute inset-0 bg-linear-to-b from-transparent to-card" />
    </div>
  );
}

function GuildGridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4">
      {[0, 1, 2].map((index) => (
        <Skeleton
          key={index}
          className="aspect-square rounded-xl motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
