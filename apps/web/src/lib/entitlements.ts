// Server-only: the signed-in player's owned products (entitlements). Reads the player token
// from the httpOnly cb_player_access cookie and asks the gateway; a missing token or any
// non-ok response (including 401) yields an empty list so the account page degrades to its
// "No purchases yet" state instead of erroring.
import "server-only";
import { cookies } from "next/headers";
import { gatewayBase } from "@/lib/api";

const ACCESS = "cb_player_access";

export type Entitlement = {
  product_external_id: string;
  // Nullable: a product row may have been removed after purchase; consumers fall back to
  // the external id for display.
  product_name: string | null;
  kind: string;
  status: string;
  granted_at: string;
  // Null for one-time / non-expiring grants.
  expires_at: string | null;
};

export async function fetchPlayerEntitlements(): Promise<Entitlement[]> {
  const token = (await cookies()).get(ACCESS)?.value;
  if (!token) return [];
  const res = await fetch(`${gatewayBase()}/player/entitlements`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = (await res.json().catch(() => null)) as { entitlements?: unknown } | null;
  if (!body || !Array.isArray(body.entitlements)) return [];
  return body.entitlements as Entitlement[];
}
