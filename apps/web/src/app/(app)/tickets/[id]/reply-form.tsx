"use client";

import { useActionState } from "react";
import { createTicketMessageAction } from "@/lib/actions";

// Staff reply form. The internal checkbox posts a staff-only note (never shown to the
// player); a client component so it can surface inline errors and pending state.
export function ReplyForm({ ticketId }: { ticketId: string }) {
  const [state, action, pending] = useActionState(createTicketMessageAction, {});
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-col gap-2">
        <input type="hidden" name="ticket_id" value={ticketId} />
        <textarea
          name="body"
          required
          rows={3}
          placeholder="Write a reply"
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send reply"}
          </button>
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input type="checkbox" name="internal" className="accent-indigo-600" />
            Internal note (staff only)
          </label>
        </div>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
