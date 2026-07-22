// Server-only: operator-side privacy job reads (the DSAR coordinator in auth, reached
// through the gateway /auth passthrough). Jobs are TENANT-SCOPED here: an operator job
// covers this org's rows only, never the global identity graph or other orgs (decision
// A2). Mirrors the degrade-quietly shape of the other lib fetchers.
import "server-only";
import { apiFetch } from "@/lib/api";

export type PrivacyJobStatus =
  | "queued"
  | "running"
  | "awaiting_confirm"
  | "completed"
  | "failed";

/** Per-service row counts, keyed service -> table -> rows (dry-run and result shapes). */
export type PrivacyCounts = Record<string, Record<string, number>>;

export type PrivacyJob = {
  id: string;
  kind: "export" | "erase";
  scope_kind: string;
  status: PrivacyJobStatus;
  dry_run_counts?: PrivacyCounts | null;
  result_counts?: PrivacyCounts | null;
  error?: string | null;
  created_at: string;
  // Optional bundle bookkeeping the auth side may include on export jobs. When absent the
  // UI still offers the link and lets the endpoint's one-time/expiry semantics (410)
  // answer authoritatively.
  bundle_expires_at?: string | null;
  downloaded_at?: string | null;
};

export async function fetchPrivacyJobs(): Promise<PrivacyJob[]> {
  const res = await apiFetch("/auth/privacy/jobs");
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as unknown;
  return Array.isArray(body) ? (body as PrivacyJob[]) : [];
}

/** Whether a completed export still has its one-time bundle to hand out. Fields are
 * optional, so this only hides the link when the API positively says it is gone; the
 * download route's 410 handling covers the rest. */
export function downloadAvailable(job: PrivacyJob): boolean {
  if (job.kind !== "export" || job.status !== "completed") return false;
  if (job.downloaded_at) return false;
  if (job.bundle_expires_at && new Date(job.bundle_expires_at).getTime() <= Date.now()) {
    return false;
  }
  return true;
}
