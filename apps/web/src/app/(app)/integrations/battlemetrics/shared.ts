import { apiFetch } from "@/lib/api";

export type BmConnection = {
  id: string;
  bm_org_id: string;
  status: "connected" | "error" | "disabled";
  last_error: string | null;
  sync_enabled: boolean;
  sync_bans_outbound: boolean;
  settings: unknown;
  last_tail_at: string | null;
  last_scan_at: string | null;
  sync_error: string | null;
  created_at: string;
  updated_at: string;
};

export type BmConflict = {
  id: string;
  entity_type: string;
  external_id: string;
  local_id: string | null;
  direction: "inbound" | "outbound";
  local_snapshot: Record<string, unknown> | null;
  remote_snapshot: Record<string, unknown> | null;
  resolution: "local_won" | "remote_won" | "manual_pending" | "manual_resolved";
  created_at: string;
};

export type BmImportJob = {
  id: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  phase: "servers" | "ban_lists" | "bans" | "players" | "notes" | "done";
  phase_counts: Record<string, number>;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type BmBanList = {
  external_id: string;
  name: string | null;
  owner_bm_org: string | null;
  subscribed: boolean;
  perm_create: boolean;
  import_enabled: boolean;
};

export type BmOutbox = {
  pending: number;
  needs_verify: number;
  failed: number;
  abandoned: number;
};

export type BmStatus = {
  configured: boolean;
  connection: BmConnection | null;
  latest_job: BmImportJob | null;
  ban_lists: BmBanList[];
  conflicts: BmConflict[];
  outbox: BmOutbox;
};

export const EMPTY_OUTBOX: BmOutbox = {
  pending: 0,
  needs_verify: 0,
  failed: 0,
  abandoned: 0,
};

export async function fetchStatus(): Promise<BmStatus | "error"> {
  try {
    const res = await apiFetch("/integrations/bm");
    if (!res.ok) return "error";
    return res.json();
  } catch {
    return "error";
  }
}

export const CONNECTION_STATUS_STYLES: Record<BmConnection["status"], string> = {
  connected: "bg-green-900 text-green-300",
  error: "bg-red-900 text-red-300",
  disabled: "bg-neutral-800 text-neutral-400",
};

export const JOB_STATUS_STYLES: Record<BmImportJob["status"], string> = {
  queued: "bg-neutral-800 text-neutral-400",
  running: "bg-blue-900 text-blue-300",
  paused: "bg-yellow-900 text-yellow-300",
  completed: "bg-green-900 text-green-300",
  failed: "bg-red-900 text-red-300",
  cancelled: "bg-neutral-800 text-neutral-400",
};

export const PHASE_COUNT_LABELS: Record<string, string> = {
  ban_lists: "Ban lists",
  bans_imported: "Bans imported",
  bans_updated: "Bans updated",
  bans_unchanged: "Bans unchanged",
  bans_skipped_no_identifier: "Bans skipped (no identifier)",
  servers_imported: "Servers imported",
  servers_skipped_unconfigured: "Servers skipped (unconfigured)",
  servers_skipped_disabled: "Servers skipped (disabled)",
  servers_skipped_incomplete: "Servers skipped (incomplete)",
  players_matched: "Players matched",
  players_skipped_no_steam: "Players skipped (no steam id)",
  players_skipped_disabled: "Players skipped (disabled)",
  notes_imported: "Notes imported",
  notes_skipped_empty: "Notes skipped (empty)",
  notes_skipped_disabled: "Notes skipped (disabled)",
  sync_conflicts: "Sync conflicts",
};

export const CONFLICT_RESOLUTION_STYLES: Record<BmConflict["resolution"], string> = {
  local_won: "bg-yellow-900 text-yellow-300",
  remote_won: "bg-neutral-800 text-neutral-400",
  manual_pending: "bg-yellow-900 text-yellow-300",
  manual_resolved: "bg-green-900 text-green-300",
};

// A conflict still awaiting an operator decision. The API exposes `resolution`, not a
// timestamp: `local_won` is the automatic keep-local outcome that still wants review,
// and `manual_pending` is an explicitly parked conflict. `manual_resolved` and
// `remote_won` are settled.
export function isConflictReviewable(resolution: BmConflict["resolution"]): boolean {
  return resolution === "local_won" || resolution === "manual_pending";
}

// Small dependency-free "3m ago" formatter; "-" for null. Only needs coarse buckets
// since these pages poll every few seconds anyway.
export function relativeTime(iso: string | null): string {
  if (!iso) return "-";
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// `settings` is an opaque jsonb blob; only pull out the one key the page needs.
export function targetBanList(settings: unknown): string | null {
  if (typeof settings !== "object" || settings === null) return null;
  const value = (settings as Record<string, unknown>).target_ban_list;
  return typeof value === "string" ? value : null;
}

// Import subset gates default to enabled; only an explicit `false` in settings turns
// one off.
export function importScopeFlag(settings: unknown, key: string): boolean {
  if (typeof settings !== "object" || settings === null) return true;
  return (settings as Record<string, unknown>)[key] !== false;
}
