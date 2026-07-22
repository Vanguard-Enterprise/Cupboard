// Server-only: the signed-in player's own privacy (DSAR) jobs, PLATFORM-GLOBAL scope
// (decision A2: the data subject themselves may reach the whole graph). Reads the player
// token from the httpOnly cb_player_access cookie and asks the gateway; a missing token or
// any non-ok response yields an empty list so the account page degrades quietly. Mirrors
// lib/tickets.ts.
import "server-only";
import { cookies } from "next/headers";
import { gatewayBase } from "@/lib/api";

const ACCESS = "cb_player_access";

export type PlayerPrivacyJobStatus =
  | "queued"
  | "running"
  | "awaiting_confirm"
  | "completed"
  | "failed";

/** Per-service row counts, keyed service -> table -> rows. */
export type PlayerPrivacyCounts = Record<string, Record<string, number>>;

export type PlayerPrivacyJob = {
  id: string;
  kind: "export" | "erase";
  scope_kind: string;
  status: PlayerPrivacyJobStatus;
  dry_run_counts?: PlayerPrivacyCounts | null;
  result_counts?: PlayerPrivacyCounts | null;
  error?: string | null;
  created_at: string;
  // Optional bundle bookkeeping on export jobs; when absent the link stays and the
  // endpoint's one-time semantics (410) answer authoritatively.
  bundle_expires_at?: string | null;
  downloaded_at?: string | null;
};

export async function fetchPlayerPrivacyJobs(): Promise<PlayerPrivacyJob[]> {
  const token = (await cookies()).get(ACCESS)?.value;
  if (!token) return [];
  const res = await fetch(`${gatewayBase()}/auth/player/privacy/jobs`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = (await res.json().catch(() => null)) as unknown;
  return Array.isArray(body) ? (body as PlayerPrivacyJob[]) : [];
}

/** Whether a completed export still has its one-time bundle to hand out. */
export function playerDownloadAvailable(job: PlayerPrivacyJob): boolean {
  if (job.kind !== "export" || job.status !== "completed") return false;
  if (job.downloaded_at) return false;
  if (job.bundle_expires_at && new Date(job.bundle_expires_at).getTime() <= Date.now()) {
    return false;
  }
  return true;
}
