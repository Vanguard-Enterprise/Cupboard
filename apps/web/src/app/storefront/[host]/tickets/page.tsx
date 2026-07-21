// Storefront player tickets page. The layout has verified the host and wrapped this in
// the theme Shell (--sf-* variables). Requires a player session; unauthenticated visitors
// are sent to login. Lists the player's own tickets and opens new ones (general or ban
// appeal, the latter picking from the player's active bans).
import { redirect } from "next/navigation";
import { getPlayer } from "@/lib/player";
import { fetchPlayerActiveBans, fetchPlayerTickets } from "@/lib/tickets";
import { NewTicketForm } from "./new-ticket-form";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

export default async function PlayerTicketsPage() {
  const player = await getPlayer();
  if (!player) redirect("/login");

  const [tickets, bans] = await Promise.all([fetchPlayerTickets(), fetchPlayerActiveBans()]);

  return (
    <div className="mx-auto max-w-md py-12">
      <h1 className="text-2xl font-bold tracking-tight">Support tickets</h1>

      <section className="mt-6">
        {tickets.length === 0 ? (
          <p className="text-sm text-[var(--sf-muted)]">No tickets yet.</p>
        ) : (
          <ul className="space-y-3">
            {tickets.map((t) => (
              <li key={t.id}>
                <a
                  href={`/tickets/${t.id}`}
                  className="block rounded-xl border border-[var(--sf-border)] bg-[var(--sf-card)] p-4 transition-colors hover:border-[var(--sf-primary)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="min-w-0 break-words font-medium leading-snug">{t.subject}</h2>
                    <span className="shrink-0 rounded-full border border-[var(--sf-primary)]/40 px-2 py-0.5 text-xs text-[var(--sf-primary)]">
                      {t.status}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-[var(--sf-muted)]">
                    {t.type === "ban_appeal" ? "Ban appeal" : "General"} · updated{" "}
                    {formatDate(t.last_message_at ?? t.updated_at)}
                  </p>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8 rounded-2xl border border-[var(--sf-border)] bg-[var(--sf-card)] p-8">
        <h2 className="text-lg font-semibold tracking-tight">Open a ticket</h2>
        <div className="mt-4">
          <NewTicketForm bans={bans} />
        </div>
      </section>
    </div>
  );
}
