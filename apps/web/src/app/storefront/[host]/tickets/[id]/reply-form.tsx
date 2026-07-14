"use client";

import { useActionState } from "react";
import { replyPlayerTicketAction } from "@/lib/player-actions";

// Player reply form; the action redirects back to the thread on success so it re-renders
// fresh, so only pending and error states render here.
export function PlayerReplyForm({ ticketId }: { ticketId: string }) {
  const [state, action, pending] = useActionState(replyPlayerTicketAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <textarea
        name="body"
        required
        rows={3}
        placeholder="Write a reply"
        className="rounded-lg border border-[var(--sf-border)] bg-transparent px-3 py-2 text-sm text-[var(--sf-fg)]"
      />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-[var(--sf-primary)] px-4 py-2.5 text-sm font-medium text-[var(--sf-on-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send reply"}
      </button>
      {state.error && <p className="text-sm text-red-500">{state.error}</p>}
    </form>
  );
}
