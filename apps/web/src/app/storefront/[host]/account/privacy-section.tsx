// "Privacy and your data" section of the account page: self-serve export and erasure
// (PLATFORM-GLOBAL scope: the data subject's own right covers the whole network, unlike
// the tenant-scoped operator surface). Server component; the buttons post plain server
// actions and outcomes ride back as ?privacy= flags on the page.
import {
  confirmPlayerErasureAction,
  startPlayerDataEraseAction,
  startPlayerDataExportAction,
} from "@/lib/player-actions";
import {
  fetchPlayerPrivacyJobs,
  playerDownloadAvailable,
  type PlayerPrivacyCounts,
  type PlayerPrivacyJob,
} from "@/lib/player-privacy";

/** Plain-language names for the row counts a dry-run reports, keyed by
 * `service.table`: the same table name can mean different things per service
 * (auth's player_sessions are website sign-ins, identity's are game-server play
 * sessions). Anything unmapped falls back to the bare table name with underscores
 * spaced out. */
const TABLE_LABELS: Record<string, string> = {
  "identity.player_identifiers": "linked game identifiers",
  "identity.identity_signals": "connection signals",
  "identity.player_sessions": "play sessions",
  "identity.chat_messages": "chat messages",
  "identity.player_reports": "reports",
  "identity.name_history": "name history entries",
  "identity.player_notes": "staff notes",
  "identity.player_flags": "flags",
  "identity.bans":
    "ban records (identifying details removed; the ban itself stays enforced)",
  "auth.player_accounts": "account profile",
  "auth.player_identities": "linked sign-ins (Steam, Discord)",
  "auth.player_sessions": "sign-in sessions",
  "auth.player_login_codes": "sign-in codes",
  "auth.player_link_codes": "account link codes",
  "auth.player_link_states": "account link requests",
  "tenant.tickets": "support tickets",
  "tenant.ticket_messages": "support ticket messages",
  "tenant.checkout_sessions": "checkout records",
  "tenant.entitlements": "purchase links",
};

const SERVICE_LABELS: Record<string, string> = {
  identity: "Game server records",
  auth: "Account and sign-in",
  tenant: "Store and support",
};

function friendlyTable(service: string, table: string): string {
  return TABLE_LABELS[`${service}.${table}`] ?? table.replace(/_/g, " ");
}

/** The dry-run counts as short per-service lists ("chat messages: 214"). */
function EraseSummary({ counts }: { counts: PlayerPrivacyCounts }) {
  const groups = Object.entries(counts)
    .map(([service, tables]) => ({
      service,
      rows: Object.entries(tables ?? {}).filter(([, n]) => n > 0),
    }))
    .filter((g) => g.rows.length > 0);
  if (groups.length === 0) {
    return (
      <p className="text-xs text-[var(--sf-muted)]">
        We found nothing left to delete, but confirming will still finish the request.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div key={g.service}>
          <p className="text-xs font-semibold text-[var(--sf-fg)]/80">
            {SERVICE_LABELS[g.service] ?? g.service}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-[var(--sf-muted)]">
            {g.rows.map(([table, n]) => (
              <li key={table}>
                {friendlyTable(g.service, table)}: {n}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function jobTitle(job: PlayerPrivacyJob): string {
  return job.kind === "export" ? "Data export" : "Data deletion";
}

/** Format an ISO timestamp as a short calendar date; raw string if unparseable. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

function JobBody({ job }: { job: PlayerPrivacyJob }) {
  if (job.status === "queued" || job.status === "running") {
    return (
      <p className="mt-2 text-xs text-[var(--sf-muted)]">
        {job.kind === "export"
          ? "Preparing your export. Check back here in a little while."
          : "Working out exactly what we hold about you. Check back here in a little while."}
      </p>
    );
  }
  if (job.status === "failed") {
    return (
      <p className="mt-2 text-xs text-red-500">
        Something went wrong{job.error ? `: ${job.error}` : ""}. Try again, or open a
        support ticket.
      </p>
    );
  }
  if (job.status === "awaiting_confirm" && job.kind === "erase") {
    return (
      <div className="mt-3 space-y-3">
        <p className="text-xs text-[var(--sf-fg)]/80">
          Here is what will be deleted or anonymized, everywhere on the network:
        </p>
        <EraseSummary counts={job.dry_run_counts ?? {}} />
        <p className="text-xs font-medium text-red-500">
          This cannot be undone. Any bans remain enforced (we keep an anonymous
          fingerprint so a ban cannot be dodged by deleting an account), and purchases
          stay on record as proof of purchase. Everything else about you is removed.
        </p>
        <form action={confirmPlayerErasureAction}>
          <input type="hidden" name="job_id" value={job.id} />
          <button
            type="submit"
            className="rounded-lg border border-red-500/60 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10"
          >
            Confirm deletion
          </button>
        </form>
      </div>
    );
  }
  if (job.status === "completed" && job.kind === "export") {
    if (!playerDownloadAvailable(job)) {
      return (
        <p className="mt-2 text-xs text-[var(--sf-muted)]">
          This export was already downloaded or has expired. Start a new one if you need
          another copy.
        </p>
      );
    }
    return (
      <div className="mt-2">
        <a
          href={`/account/privacy/${job.id}/download`}
          className="text-xs font-medium text-[var(--sf-primary)] hover:underline"
        >
          Download your data (.json.gz)
        </a>
        <p className="mt-1 text-xs text-[var(--sf-muted)]">
          One-time link: it disappears after the first download.
        </p>
      </div>
    );
  }
  if (job.status === "completed" && job.kind === "erase") {
    return (
      <p className="mt-2 text-xs text-[var(--sf-muted)]">
        Deletion complete. Your account data is gone; this session will end on its
        own within about 15 minutes.
      </p>
    );
  }
  return null;
}

export async function PrivacySection() {
  const jobs = await fetchPlayerPrivacyJobs();

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold tracking-tight">Privacy and your data</h2>
      <p className="mt-3 text-sm text-[var(--sf-muted)]">
        Get a copy of everything we hold about you, or ask us to delete it.{" "}
        <a href="/privacy" className="text-[var(--sf-primary)] hover:underline">
          Read what we collect and how long we keep it
        </a>
        .
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <form action={startPlayerDataExportAction}>
          <button
            type="submit"
            className="rounded-lg border border-[var(--sf-border)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--sf-primary)] hover:text-[var(--sf-primary)]"
          >
            Download my data
          </button>
        </form>
        <form action={startPlayerDataEraseAction}>
          <button
            type="submit"
            className="rounded-lg border border-red-500/60 px-4 py-2 text-sm font-medium text-red-500 transition-colors hover:bg-red-500/10"
          >
            Delete my data
          </button>
        </form>
      </div>
      <p className="mt-2 text-xs text-[var(--sf-muted)]">
        Deletion shows you a summary first and asks you to confirm; nothing is removed
        until you do.
      </p>

      {jobs.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {jobs.map((job) => (
            <li
              key={job.id}
              className="rounded-xl border border-[var(--sf-border)] bg-[var(--sf-card)] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="min-w-0 text-sm font-medium leading-snug">{jobTitle(job)}</h3>
                <span className="shrink-0 rounded-full border border-[var(--sf-primary)]/40 px-2 py-0.5 text-xs text-[var(--sf-primary)]">
                  {job.status.replace(/_/g, " ")}
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--sf-muted)]">
                Requested {formatDate(job.created_at)}
              </p>
              <JobBody job={job} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
