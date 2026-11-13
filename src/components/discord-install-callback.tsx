"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiRequest, type Identity } from "@/lib/api-client";
import { discordPath } from "@/lib/dashboard-navigation";
import { Button } from "@/components/ui/button";
import { useGuardedNavigation } from "@/components/ui/unsaved-changes";

type Callback = {
  code?: string;
  state?: string;
  guildId?: string;
  error?: string;
};

// Discord returns here after the operator adds the bot. The install state is
// single use, so the request runs once even when React mounts twice.
export function DiscordInstallCallback({
  identity,
  code,
  state,
  guildId,
  error,
}: Callback & { identity: Identity }) {
  const { push } = useGuardedNavigation();
  const started = useRef(false);
  const initial =
    error === "access_denied"
      ? "The bot wasn’t added because the installation was cancelled in Discord."
      : error || !code || !state
        ? "Discord didn’t return a complete installation. Add the guild again."
        : "";
  const [failure, setFailure] = useState("");
  const organization = identity.organization?.id;

  useEffect(() => {
    if (started.current || initial) return;
    started.current = true;
    apiRequest<{ id: string }>(
      "discord/install",
      { code, state, ...(guildId ? { guildId } : {}) },
      organization,
    )
      .then((guild) =>
        push(`${discordPath}?added=${encodeURIComponent(guild.id)}`),
      )
      .catch((cause) =>
        setFailure(
          cause instanceof Error
            ? cause.message
            : "The request could not be completed.",
        ),
      );
  }, [initial, code, state, guildId, organization, push]);

  const shown = initial || failure;
  return (
    <section className="mx-auto w-full max-w-7xl space-y-4 p-4 md:p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Discord</h1>
      {shown ? (
        <>
          <p role="alert" className="text-sm text-muted-foreground">
            Couldn’t add the guild. {shown}
          </p>
          <Button variant="outline" asChild>
            <Link href={discordPath}>Back to Discord</Link>
          </Button>
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Adding the guild...
        </p>
      )}
    </section>
  );
}
