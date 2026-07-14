// Server-only: the signed-in player's support tickets and active bans (the ban-appeal
// picker). Reads the player token from the httpOnly cb_player_access cookie and asks the
// gateway; a missing token or any non-ok response yields an empty result so the storefront
// pages degrade quietly instead of erroring. Mirrors lib/entitlements.ts.
import "server-only";
import { cookies } from "next/headers";
import { gatewayBase } from "@/lib/api";

const ACCESS = "cb_player_access";

export type PlayerTicket = {
  id: string;
  type: string;
  status: string;
  category: string | null;
  subject: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
};

export type PlayerTicketMessage = {
  id: string;
  author_kind: string;
  author_display: string;
  body: string;
  // The player API never returns internal notes; carried so the UI can drop any that
  // slip through a future regression.
  internal?: boolean;
  created_at: string;
};

// The detail ticket is the tenant's full row, which (unlike list summaries) carries no
// last_message_at.
export type PlayerTicketDetail = {
  ticket: Omit<PlayerTicket, "last_message_at">;
  messages: PlayerTicketMessage[];
};

export type ActiveBan = {
  id: string;
  subject_type: string;
  subject_value: string | null;
  reason: string | null;
  status: string;
  issued_at: string;
  expires_at: string | null;
};

async function playerGet(path: string): Promise<unknown | null> {
  const token = (await cookies()).get(ACCESS)?.value;
  if (!token) return null;
  const res = await fetch(`${gatewayBase()}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json().catch(() => null);
}

export async function fetchPlayerTickets(): Promise<PlayerTicket[]> {
  const body = (await playerGet("/player/tickets")) as { tickets?: unknown } | null;
  if (!body || !Array.isArray(body.tickets)) return [];
  return body.tickets as PlayerTicket[];
}

/** One ticket with its thread (the API never returns internal staff notes to players),
 * or null when missing/not the player's own. */
export async function fetchPlayerTicket(id: string): Promise<PlayerTicketDetail | null> {
  const body = (await playerGet(`/player/tickets/${id}`)) as {
    ticket?: unknown;
    messages?: unknown;
  } | null;
  if (!body || !body.ticket || !Array.isArray(body.messages)) return null;
  return body as PlayerTicketDetail;
}

/** The player's active bans across the org (decision C lookup), feeding the "appeal this
 * ban" picker. Returns null when the lookup FAILS (an identity outage rides back as a
 * non-ok response), which the form renders as "unavailable" rather than the misleading
 * "no active bans". */
export async function fetchPlayerActiveBans(): Promise<ActiveBan[] | null> {
  const body = (await playerGet("/player/bans/active")) as { bans?: unknown } | null;
  if (!body || !Array.isArray(body.bans)) return null;
  return body.bans as ActiveBan[];
}
