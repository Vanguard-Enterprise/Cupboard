// Server-only BFF for PLAYER (storefront customer) sessions. Deliberately separate from
// lib/api.ts (operator sessions): players log in via Steam against a tenant site and get
// their own httpOnly cookies (cb_player_access / cb_player_refresh), keyed to a distinct
// backend keypair, so a player token is never an operator token and vice versa. There is
// no org cookie: a player belongs to a single tenant, resolved server-side from the host.
import "server-only";
import { cookies } from "next/headers";
import { gatewayBase } from "@/lib/api";

const ACCESS = "cb_player_access";
const REFRESH = "cb_player_refresh";

export type Player = {
  id: string;
  tenant: string;
  // Nullable: the backend returns steam_id from an Option (a future Discord-only player
  // has no Steam identity). Consumers must guard before slicing/formatting it.
  steam_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export type PlayerTokens = {
  access_token: string;
  refresh_token: string;
};

function cookieBase() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

/** Persist a fresh player session (both tokens) after login exchange. */
export async function setPlayerSession(tokens: PlayerTokens): Promise<void> {
  const jar = await cookies();
  const base = cookieBase();
  jar.set(ACCESS, tokens.access_token, base);
  jar.set(REFRESH, tokens.refresh_token, { ...base, maxAge: 60 * 60 * 24 * 30 });
}

/** Drop the player session cookies (sign out). */
export async function clearPlayerSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS);
  jar.delete(REFRESH);
}

async function playerCookie(name: string): Promise<string | undefined> {
  return (await cookies()).get(name)?.value;
}

/** The stored refresh token, for the logout server action. */
export async function playerRefreshToken(): Promise<string | undefined> {
  return playerCookie(REFRESH);
}

async function setPlayerAccess(accessToken: string): Promise<void> {
  // Next.js forbids cookies().set() during a Server Component render (only Server Actions
  // and Route Handlers may write cookies). getPlayer() is called from both contexts, so
  // this is best-effort: when it throws in a render context we still use the freshly
  // refreshed token for THIS request; the next action/handler that calls getPlayer()
  // persists it. This keeps a returning player with an expired access token but a valid
  // refresh token from crashing the page.
  try {
    const jar = await cookies();
    jar.set(ACCESS, accessToken, cookieBase());
  } catch {
    // Rendering context; the new access token is still used for the current request.
  }
}

async function fetchMe(token: string | undefined): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(gatewayBase() + "/auth/player/me", { headers, cache: "no-store" });
}

/** The current player (from cb_player_access), or null if not signed in. On a 401 it
 * attempts a single silent refresh via cb_player_refresh, re-mints the access cookie, and
 * retries once — mirroring apiFetch's shape on the operator side. */
export async function getPlayer(): Promise<Player | null> {
  const access = await playerCookie(ACCESS);
  const refresh = await playerCookie(REFRESH);
  if (!access && !refresh) return null;

  let res = await fetchMe(access);
  if (res.status === 401 && refresh) {
    const refreshed = await fetch(gatewayBase() + "/auth/player/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
      cache: "no-store",
    });
    if (!refreshed.ok) return null;
    const { access_token } = (await refreshed.json()) as { access_token: string };
    await setPlayerAccess(access_token);
    res = await fetchMe(access_token);
  }
  if (!res.ok) return null;
  const body = (await res.json()) as { player: Player };
  return body.player;
}
