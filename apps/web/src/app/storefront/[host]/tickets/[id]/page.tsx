// Storefront ticket thread. Requires a player session; the API scopes reads to the
// player's own tickets and never returns internal staff notes. Themed via the layout's
// Shell (--sf-* variables) like account/.
import { redirect } from "next/navigation";
import { getPlayer } from "@/lib/player";
import { fetchPlayerTicket, type PlayerTicketMessage } from "@/lib/tickets";
import { PlayerReplyForm } from "./reply-form";

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export default async function PlayerTicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const player = await getPlayer();
  if (!player) redirect("/login");

  const { id } = await params;
  const detail = await fetchPlayerTicket(id);
  if (!detail) {
    return (
      <div className="mx-auto max-w-md py-12">
        <p className="text-sm text-[var(--sf-muted)]">
          Ticket not found.{" "}
          <a href="/tickets" className="text-[var(--sf-primary)] hover:underline">
            Back to tickets
          </a>
        </p>
      </div>
    );
  }
  const { ticket, messages } = detail;
  const closed = ticket.status === "closed";

  return (
    <div className="mx-auto max-w-md py-12">
      <a href="/tickets" className="text-sm text-[var(--sf-primary)] hover:underline">
        ← Tickets
      </a>
      <div className="mt-3 flex items-start justify-between gap-3">
        <h1 className="min-w-0 break-words text-2xl font-bold tracking-tight">
          {ticket.subject}
        </h1>
        <span className="mt-1 shrink-0 rounded-full border border-[var(--sf-primary)]/40 px-2 py-0.5 text-xs text-[var(--sf-primary)]">
          {ticket.status}
        </span>
      </div>
      <p className="mt-1 text-xs text-[var(--sf-muted)]">
        {ticket.type === "ban_appeal" ? "Ban appeal" : "General"} · opened{" "}
        {formatDateTime(ticket.created_at)}
      </p>

      <div className="mt-6 space-y-3">
        {messages.map((m) => (
          <MessageCard key={m.id} message={m} />
        ))}
      </div>

      <div className="mt-8">
        {closed ? (
          <p className="text-sm text-[var(--sf-muted)]">
            This ticket is closed. Open a new one if you need more help.
          </p>
        ) : (
          <PlayerReplyForm ticketId={ticket.id} />
        )}
      </div>
    </div>
  );
}

function MessageCard({ message }: { message: PlayerTicketMessage }) {
  // Defense in depth: the API excludes internal staff notes from the player surface;
  // never render one even if a regression lets it through.
  if (message.internal) return null;
  if (message.author_kind === "system") {
    return (
      <p className="px-1 text-xs text-[var(--sf-muted)]">
        {message.body} · {formatDateTime(message.created_at)}
      </p>
    );
  }
  const staff = message.author_kind === "staff";
  return (
    <div
      className={`rounded-xl border p-4 ${
        staff ? "border-[var(--sf-primary)]/40" : "border-[var(--sf-border)] bg-[var(--sf-card)]"
      }`}
    >
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--sf-muted)]">
        {/* The wire author_display is an internal tag (staff-xxxx / the steam id); the
            player's own thread reads better with friendly labels. */}
        <span className={staff ? "text-[var(--sf-primary)]" : undefined}>
          {staff ? "Staff" : "You"}
        </span>
        <span>{formatDateTime(message.created_at)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{message.body}</p>
    </div>
  );
}
