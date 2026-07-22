import { getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import {
  downloadAvailable,
  fetchPrivacyJobs,
  type PrivacyCounts,
  type PrivacyJob,
  type PrivacyJobStatus,
} from "@/lib/privacy";
import { ConfirmJob } from "./confirm-job";

// Org privacy job list (exports and erasures started from a player profile). Erase jobs
// pause in awaiting_confirm with their dry-run counts; export bundles are one-time
// downloads. Everything here is TENANT-SCOPED (decision A2): this org's records only.

const STATUS_STYLES: Record<PrivacyJobStatus, string> = {
  queued: "bg-neutral-800 text-neutral-300",
  running: "bg-indigo-950 text-indigo-300",
  awaiting_confirm: "bg-yellow-900 text-yellow-300",
  completed: "bg-green-900 text-green-300",
  failed: "bg-red-950 text-red-300",
};

const STATUS_LABELS: Record<PrivacyJobStatus, string> = {
  queued: "queued",
  running: "running",
  awaiting_confirm: "awaiting confirm",
  completed: "completed",
  failed: "failed",
};

// ?flag= breadcrumbs from the profile-card actions and the download route.
type Banner = { tone: "success" | "neutral"; message: string };
const BANNERS: Record<string, Banner> = {
  export_started: { tone: "success", message: "Export job started for this org's records." },
  erase_started: {
    tone: "success",
    message:
      "Erase job started. It runs a dry-run first; confirm it below once the counts appear.",
  },
  download_gone: {
    tone: "neutral",
    message:
      "That bundle is no longer available: export downloads are one-time and expire, so it was already taken or has lapsed. Start a new export if you still need it.",
  },
  download_failed: { tone: "neutral", message: "Download failed; try again in a moment." },
};
const TONE_STYLES: Record<Banner["tone"], string> = {
  success: "border-green-900 bg-green-950 text-green-300",
  neutral: "border-neutral-800 text-neutral-300",
};

function FlagBanner({ flag }: { flag?: string }) {
  const banner = flag ? BANNERS[flag] : undefined;
  if (!banner) return null;
  return (
    <div className={`rounded border px-4 py-3 text-sm ${TONE_STYLES[banner.tone]}`}>
      {banner.message}
    </div>
  );
}

/** The dry-run counts as a flat service/table/rows list (per-service nesting kept as a
 * grouping column, not separate tables). */
function CountsTable({ counts }: { counts: PrivacyCounts }) {
  const rows = Object.entries(counts).flatMap(([service, tables]) =>
    Object.entries(tables ?? {}).map(([table, n]) => ({ service, table, n })),
  );
  if (rows.length === 0) {
    return <p className="text-xs text-neutral-500">Dry-run found no rows to erase.</p>;
  }
  return (
    <div className="overflow-hidden rounded border border-neutral-800">
      <table className="w-full text-left text-xs">
        <thead className="bg-neutral-900 text-neutral-400">
          <tr>
            <th className="px-3 py-1.5">Service</th>
            <th className="px-3 py-1.5">Table</th>
            <th className="px-3 py-1.5">Rows</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.service}.${r.table}`} className="border-t border-neutral-800">
              <td className="px-3 py-1.5 text-neutral-400">{r.service}</td>
              <td className="px-3 py-1.5 font-mono">{r.table}</td>
              <td className="px-3 py-1.5">{r.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobDetails({ job }: { job: PrivacyJob }) {
  if (job.status === "awaiting_confirm" && job.kind === "erase") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-neutral-400">
          Dry-run complete. These rows will be erased or anonymized in this org's records
          (hashes are kept, so any ban still enforces):
        </p>
        <CountsTable counts={job.dry_run_counts ?? {}} />
        <ConfirmJob jobId={job.id} />
      </div>
    );
  }
  if (job.status === "failed") {
    return <p className="text-xs text-red-400">{job.error || "job failed"}</p>;
  }
  if (job.status === "completed" && job.kind === "export") {
    if (!downloadAvailable(job)) {
      return (
        <p className="text-xs text-neutral-500">
          Bundle no longer available (one-time download taken or expired).
        </p>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <a
          href={`/privacy/${job.id}/download`}
          className="text-xs text-indigo-400 hover:text-indigo-300"
        >
          Download bundle (.json.gz)
        </a>
        <span className="text-xs text-neutral-500">
          One-time download: the link disappears after the first take.
        </span>
      </div>
    );
  }
  if (job.status === "completed" && job.kind === "erase") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-neutral-400">Erased rows per service:</p>
        <CountsTable counts={job.result_counts ?? {}} />
      </div>
    );
  }
  return <span className="text-xs text-neutral-500">in progress</span>;
}

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ flag?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.PlayersErase)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to privacy jobs.</p>;
  }
  const { flag } = await searchParams;
  const jobs = await fetchPrivacyJobs();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Privacy</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Data export and erasure jobs for this org, started from a player profile. Jobs
          here are tenant-scoped: they cover this org&apos;s records only, never the global
          identity graph or other orgs. Erasures run a dry-run first and wait for your
          confirmation below.
        </p>
      </div>

      <FlagBanner flag={flag} />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-300">Jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-neutral-500">No privacy jobs yet.</p>
        ) : (
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-t border-neutral-800 align-top">
                    <td className="px-3 py-2 capitalize">{job.kind}</td>
                    <td className="px-3 py-2 text-neutral-400">
                      {new Date(job.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          STATUS_STYLES[job.status] ?? "bg-neutral-800 text-neutral-300"
                        }`}
                      >
                        {STATUS_LABELS[job.status] ?? job.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <JobDetails job={job} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
