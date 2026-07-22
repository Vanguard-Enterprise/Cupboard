"use client";

import { useActionState } from "react";
import { createPrivacyJobAction } from "@/lib/actions";

// Privacy card on the player profile, gated on players.erase by the page. Starts a
// TENANT-SCOPED export or erase job keyed on whichever identifiers the profile has; on
// success the action lands on /privacy, where erase jobs wait for dry-run confirmation.
export function PrivacyCard({
  steamId,
  discordId,
}: {
  steamId: string | null;
  discordId: string | null;
}) {
  const [state, action, pending] = useActionState(createPrivacyJobAction, {});
  const hasIdentifier = Boolean(steamId || discordId);

  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-800 p-4">
      <p className="text-sm text-neutral-400">
        Export or erase this player&apos;s data held by <strong>this org only</strong>. These
        jobs are tenant-scoped: the global identity graph and other orgs&apos; records are
        unaffected. Full network-wide deletion is the player&apos;s own right, exercised
        from their storefront account page. Erasure runs a dry-run first; you confirm it
        on the Privacy page.
      </p>
      {hasIdentifier ? (
        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="steam_id" value={steamId ?? ""} />
          <input type="hidden" name="discord_id" value={discordId ?? ""} />
          <button
            type="submit"
            name="kind"
            value="export"
            disabled={pending}
            className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {pending ? "Working…" : "Export org data"}
          </button>
          <button
            type="submit"
            name="kind"
            value="erase"
            disabled={pending}
            className="rounded bg-red-900 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-800 disabled:opacity-50"
          >
            {pending ? "Working…" : "Erase org data"}
          </button>
        </form>
      ) : (
        <p className="text-xs text-neutral-500">
          This profile has no Steam or Discord identifier to key a privacy job on.
        </p>
      )}
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
