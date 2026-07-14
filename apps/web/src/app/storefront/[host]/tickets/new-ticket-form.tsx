"use client";

import { useActionState, useState } from "react";
import { createPlayerTicketAction } from "@/lib/player-actions";
import type { ActiveBan } from "@/lib/tickets";

// Open-ticket form. Picking "ban appeal" reveals a picker over the player's active bans
// (fetched server-side and passed in; null = the lookup failed, distinct from "no
// bans"); the themed --sf-* styling matches account/.
export function NewTicketForm({ bans }: { bans: ActiveBan[] | null }) {
  const [state, action, pending] = useActionState(createPlayerTicketAction, {});
  const [type, setType] = useState<"general" | "ban_appeal">("general");

  const field =
    "rounded-lg border border-[var(--sf-border)] bg-transparent px-3 py-2 text-sm text-[var(--sf-fg)]";

  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-muted)]">
        Type
        <select
          name="type"
          value={type}
          onChange={(e) => setType(e.target.value === "ban_appeal" ? "ban_appeal" : "general")}
          className={field}
        >
          <option value="general">General</option>
          <option value="ban_appeal">Ban appeal</option>
        </select>
      </label>

      {type === "ban_appeal" &&
        (bans === null ? (
          <p className="text-sm text-[var(--sf-muted)]">
            The ban list is unavailable right now; try again later.
          </p>
        ) : bans.length === 0 ? (
          <p className="text-sm text-[var(--sf-muted)]">
            No active bans were found for your account.
          </p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs text-[var(--sf-muted)]">Which ban are you appealing?</legend>
            {bans.map((ban) => (
              <label
                key={ban.id}
                className="flex items-start gap-2 rounded-lg border border-[var(--sf-border)] px-3 py-2 text-sm"
              >
                <input type="radio" name="ban_id" value={ban.id} required className="mt-1" />
                <span className="min-w-0">
                  <span className="font-mono text-xs">{ban.subject_value ?? ban.subject_type}</span>
                  <span className="block text-xs text-[var(--sf-muted)]">
                    {ban.reason ?? "No reason given"}
                    {ban.expires_at
                      ? ` (expires ${new Date(ban.expires_at).toLocaleDateString()})`
                      : " (permanent)"}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}

      <label className="flex flex-col gap-1 text-xs text-[var(--sf-muted)]">
        Subject
        <input name="subject" required maxLength={200} className={field} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-muted)]">
        Category (optional)
        <input name="category" maxLength={100} className={field} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--sf-muted)]">
        Message
        <textarea name="body" required rows={4} className={field} />
      </label>

      <button
        type="submit"
        disabled={pending || (type === "ban_appeal" && (bans === null || bans.length === 0))}
        className="rounded-lg bg-[var(--sf-primary)] px-4 py-2.5 text-sm font-medium text-[var(--sf-on-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Opening…" : "Open ticket"}
      </button>
      {state.error && <p className="text-sm text-red-500">{state.error}</p>}
    </form>
  );
}
