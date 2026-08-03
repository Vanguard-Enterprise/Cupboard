"use client";

import { useActionState } from "react";
import { assignTicketAction, setTicketStatusAction } from "@/lib/actions";
import { TICKET_STATUSES } from "../shared";

// Status and assignment controls. Client component so API refusals (e.g. the 409 for a
// status change colliding with a sibling open appeal) render inline via useActionState.
export function TicketControls({
  ticketId,
  status,
  assigneeUserId,
  currentUserId,
}: {
  ticketId: string;
  status: string;
  assigneeUserId: string | null;
  currentUserId: string;
}) {
  const [statusState, statusAction, statusPending] = useActionState(setTicketStatusAction, {});
  const [assignState, assignAction, assignPending] = useActionState(assignTicketAction, {});

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-6">
        <form action={statusAction} className="flex items-center gap-1">
          <input type="hidden" name="ticket_id" value={ticketId} />
          <span className="me-1 text-xs text-neutral-500">Status</span>
          {TICKET_STATUSES.map((s) => (
            <button
              key={s}
              name="status"
              value={s}
              disabled={statusPending || s === status}
              className={`rounded px-2 py-0.5 text-xs ${
                s === status
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
              }`}
            >
              {s}
            </button>
          ))}
        </form>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-neutral-500">
            {assigneeUserId
              ? assigneeUserId === currentUserId
                ? "Assigned to you"
                : `Assigned to ${assigneeUserId.slice(0, 8)}`
              : "Unassigned"}
          </span>
          <form action={assignAction}>
            <input type="hidden" name="ticket_id" value={ticketId} />
            {assigneeUserId ? (
              <button disabled={assignPending} className="text-red-400 hover:text-red-300 disabled:opacity-50">
                Unassign
              </button>
            ) : (
              <>
                <input type="hidden" name="assignee_user_id" value={currentUserId} />
                <button
                  disabled={assignPending}
                  className="text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                >
                  Assign to me
                </button>
              </>
            )}
          </form>
        </div>
      </div>
      {statusState.error && <p className="text-sm text-red-400">{statusState.error}</p>}
      {assignState.error && <p className="text-sm text-red-400">{assignState.error}</p>}
    </div>
  );
}
