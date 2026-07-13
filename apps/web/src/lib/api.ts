// Server-only BFF: talks to the gateway and manages the session as httpOnly cookies, so
// access/refresh tokens never reach client JavaScript. The active org is remembered in a
// cookie so silent refreshes stay scoped to it.
import "server-only";
import { cookies } from "next/headers";

const ACCESS = "cb_access";
const REFRESH = "cb_refresh";
const ORG = "cb_org";

export function gatewayBase(): string {
  return process.env.GATEWAY_URL ?? "http://localhost:18080";
}

export type Session = {
  user: { id: string; email: string | null; display_name: string };
  org: string | null;
  permissions: string[];
};

export type Tokens = {
  access_token: string;
  refresh_token: string;
};

export async function setSession(tokens: Tokens, org?: string | null): Promise<void> {
  const jar = await cookies();
  const secure = process.env.NODE_ENV === "production";
  const base = { httpOnly: true, sameSite: "lax" as const, secure, path: "/" };
  jar.set(ACCESS, tokens.access_token, base);
  jar.set(REFRESH, tokens.refresh_token, { ...base, maxAge: 60 * 60 * 24 * 30 });
  if (org !== undefined) {
    if (org) jar.set(ORG, org, { ...base, maxAge: 60 * 60 * 24 * 30 });
    else jar.delete(ORG);
  }
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS);
  jar.delete(REFRESH);
  jar.delete(ORG);
}

async function cookieValue(name: string): Promise<string | undefined> {
  return (await cookies()).get(name)?.value;
}

export async function activeOrg(): Promise<string | undefined> {
  return cookieValue(ORG);
}

function withAuth(init: RequestInit | undefined, token: string | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers, cache: "no-store" };
}

/** Authenticated server-side fetch to the gateway, with a single silent refresh on 401. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const access = await cookieValue(ACCESS);
  const res = await fetch(gatewayBase() + path, withAuth(init, access));
  if (res.status !== 401) return res;

  const refresh = await cookieValue(REFRESH);
  if (!refresh) return res;
  const org = await cookieValue(ORG);
  const refreshed = await fetch(gatewayBase() + "/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh, org_id: org ?? null }),
    cache: "no-store",
  });
  if (!refreshed.ok) return res;
  const tokens = (await refreshed.json()) as Tokens;
  // Best-effort persist: Next.js forbids cookie writes during a Server Component render
  // (only Server Actions / Route Handlers may write). apiFetch is called from both, so when
  // a render triggers the refresh we still use the fresh token for THIS request (below) and
  // let the next action/handler persist it, rather than crashing the page. Mirrors
  // setPlayerAccess() in lib/player.ts.
  try {
    await setSession(tokens, org ?? null);
  } catch {
    // Rendering context; the refreshed token is still used for the current request.
  }
  return fetch(gatewayBase() + path, withAuth(init, tokens.access_token));
}

/** The current session (user + active org + permissions), or null if unauthenticated. */
export async function getSession(): Promise<Session | null> {
  if (!(await cookieValue(ACCESS)) && !(await cookieValue(REFRESH))) return null;
  const res = await apiFetch("/auth/me");
  if (!res.ok) return null;
  return (await res.json()) as Session;
}

/** A user's organizations (for the tenant switcher). */
export async function listOrgs(): Promise<{ id: string; slug: string; name: string }[]> {
  const res = await apiFetch("/auth/orgs");
  if (!res.ok) return [];
  return res.json();
}
