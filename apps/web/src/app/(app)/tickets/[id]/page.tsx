import Link from "next/link";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { STATUS_STYLES, TYPE_STYLES, typeLabel, type Ticket } from "../shared";
import { ReplyForm } from "./reply-form";
import { TicketControls } from "./ticket-controls";

// Snapshot stored at open time (decision C: subject, reason, status at open); rendered
// defensively since the exact stored fields ride a JSON column.
type BanSnapshot = {
  subject_type?: string | null;
  subject_value?: string | null;
  reason?: string | null;
  status?: string | null;
};

type Message = {
  id: string;
  author_kind: string;
  author_id: string | null;
  author_display: string;
  body: string;
  internal: boolean;
  origin: string;
  created_at: string;
};

// The detail ticket is the full row (tenant `Ticket` struct): unlike list summaries it
// carries the ban snapshot but no last_message_at.
type TicketDetail = {
  ticket: Omit<Ticket, "last_message_at"> & { ban_snapshot: BanSnapshot | null };
  messages: Message[];
};

type Ban = {
  id: string;
  subject_type: string;
  subject_value: string | null;
  scope: string;
  reason: string | null;
  issued_at: string;
  expires_at: string | null;
  status: "active" | "expired" | "revoked";
};

const BAN_STATUS_STYLES: Record<Ban["status"], string> = {
  active: "bg-red-900 text-red-300",
  revoked: "bg-neutral-800 text-neutral-400",
  expired: "bg-neutral-800 text-neutral-500",
};

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.SupportRespond)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to tickets.</p>;
  }

  const res = await apiFetch(`/tickets/${id}`);
  if (res.status === 404) {
    return <p className="text-sm text-neutral-400">Ticket not found.</p>;
  }
  if (!res.ok) {
    return <p className="text-sm text-red-400">Failed to load ticket.</p>;
  }
  const detail: TicketDetail = await res.json();
  const ticket = detail.ticket;

  // Ban card read-through (decision C): the live ban row comes from the existing /bans
  // BFF route, only for operators who can view bans; the snapshot renders regardless.
  let liveBan: Ban | null = null;
  if (ticket.type === "ban_appeal" && ticket.ban_id && can(session.permissions, Permission.BansView)) {
    const bansRes = await apiFetch("/bans");
    if (bansRes.ok) {
      const bans: Ban[] = await bansRes.json();
      liveBan = bans.find((b) => b.id === ticket.ban_id) ?? null;
    }
  }

  const assigned = ticket.assignee_user_id;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link href="/tickets" className="text-sm text-indigo-400 hover:text-indigo-300">
          ← Tickets
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{ticket.subject}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-400">
          <span
            className={`rounded px-2 py-0.5 text-xs ${TYPE_STYLES[ticket.type] ?? "bg-neutral-800 text-neutral-300"}`}
          >
            {typeLabel(ticket.type)}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[ticket.status] ?? "bg-neutral-800 text-neutral-300"}`}
          >
            {ticket.status}
          </span>
          {ticket.category && <span className="text-xs text-neutral-500">{ticket.category}</span>}
          <span>opened {new Date(ticket.created_at).toLocaleString()}</span>
        </p>
      </div>

      <section>
        <TicketControls
          ticketId={ticket.id}
          status={ticket.status}
          assigneeUserId={assigned}
          currentUserId={session.user.id}
        />
      </section>

      {ticket.type === "ban_appeal" && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Appealed ban</h2>
          <div className="flex max-w-xl flex-col gap-3 rounded border border-neutral-800 px-4 py-3 text-sm">
            {ticket.ban_snapshot ? (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono">
                    {ticket.ban_snapshot.subject_type ?? "steam"}:{" "}
                    {ticket.ban_snapshot.subject_value ?? "unknown"}
                  </span>
                  {ticket.ban_snapshot.status && (
                    <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                      {ticket.ban_snapshot.status} at open
                    </span>
                  )}
                </div>
                <p className="text-neutral-400">
                  {ticket.ban_snapshot.reason ?? "No reason recorded."}
                </p>
              </div>
            ) : (
              <p className="text-neutral-500">No ban snapshot stored.</p>
            )}
            {liveBan && (
              <div className="flex flex-col gap-1 border-t border-neutral-800 pt-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500">Now</span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${BAN_STATUS_STYLES[liveBan.status]}`}
                  >
                    {liveBan.status}
                  </span>
                  <span className="text-xs text-neutral-400">
                    issued {new Date(liveBan.issued_at).toLocaleString()}
                    {liveBan.expires_at
                      ? `, expires ${new Date(liveBan.expires_at).toLocaleString()}`
                      : ", permanent"}
                  </span>
                </div>
                <p className="text-xs text-neutral-500">
                  Manage this ban from the{" "}
                  <Link href="/bans" className="text-indigo-400 hover:text-indigo-300">
                    bans page
                  </Link>
                  .
                </p>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="flex max-w-2xl flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Conversation</h2>
        {detail.messages.length === 0 ? (
          <p className="text-sm text-neutral-500">No messages yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {detail.messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </div>
        )}
        <ReplyForm ticketId={ticket.id} />
      </section>
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  if (message.author_kind === "system") {
    return (
      <p className="px-1 text-xs text-neutral-500">
        {message.body} · {new Date(message.created_at).toLocaleString()}
      </p>
    );
  }
  const staff = message.author_kind === "staff";
  const frame = message.internal
    ? "border-neutral-800 bg-neutral-900/60"
    : staff
      ? "border-indigo-900/60"
      : "border-neutral-800";
  return (
    <div className={`rounded border px-3 py-2 text-sm ${frame}`}>
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        <span className={staff ? "text-indigo-400" : "text-neutral-300"}>
          {message.author_display}
        </span>
        {message.internal && (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">internal</span>
        )}
        {message.origin !== "web" && <span>via {message.origin}</span>}
        <span className="ml-auto">{new Date(message.created_at).toLocaleString()}</span>
      </div>
      <p className={`mt-1 whitespace-pre-wrap break-words ${message.internal ? "text-neutral-400" : ""}`}>
        {message.body}
      </p>
    </div>
  );
}
