"use server";

// Server Actions for the storefront player auth flow. Every gateway call is server-side;
// the browser only ever follows a redirect these return. The tenant is resolved from the
// verified x-cb-site-host header server-side and never taken from client input.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { gatewayBase } from "@/lib/api";
import { clearPlayerSession, playerRefreshToken } from "@/lib/player";

/** Begin Steam sign-in: ask the gateway for the Steam redirect URL for this host and send
 * the browser there. The tenant is NOT passed from here: the auth callback resolves the
 * host to its owning tenant authoritatively (so an unregistered host is rejected server
 * side). Any failure sends the player back to the login page with an error flag. */
export async function startSteamLogin(): Promise<void> {
  const host = (await headers()).get("x-cb-site-host");
  let target: string | null = null;

  if (host) {
    const qs = new URLSearchParams({ site_host: host });
    const res = await fetch(`${gatewayBase()}/auth/player/steam/start?${qs.toString()}`, {
      cache: "no-store",
    }).catch(() => null);
    if (res && res.ok) {
      const body = (await res.json().catch(() => null)) as { url?: unknown } | null;
      if (body && typeof body.url === "string") target = body.url;
    }
  }

  // redirect() throws NEXT_REDIRECT; keep it out of any try/catch above.
  if (!target) redirect("/login?error=1");
  redirect(target);
}

/** Begin Discord account linking for the signed-in player: ask the gateway for the Discord
 * authorize URL (bound to this host and the player's token) and send the browser there. The
 * gateway callback returns the browser to /account?discord=(linked|conflict|error). A missing
 * player session bounces to /login; any other failure returns to /account with an error flag. */
export async function linkDiscord(): Promise<void> {
  const token = (await cookies()).get("cb_player_access")?.value;
  if (!token) redirect("/login");

  const host = (await headers()).get("x-cb-site-host");
  if (!host) redirect("/account?discord=error");
  const res = await fetch(`${gatewayBase()}/auth/player/discord/link`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ site_host: host }),
    cache: "no-store",
  }).catch(() => null);

  if (res && res.ok) {
    const body = (await res.json().catch(() => null)) as { url?: unknown } | null;
    // redirect() throws NEXT_REDIRECT; keep it out of any try/catch above.
    if (body && typeof body.url === "string") redirect(body.url);
  }
  redirect("/account?discord=error");
}

/** Sign the player out: best-effort revoke at the gateway, drop the cookies, go home. */
export async function logoutPlayer(): Promise<void> {
  const refresh = await playerRefreshToken();
  if (refresh) {
    await fetch(gatewayBase() + "/auth/player/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
      cache: "no-store",
    }).catch(() => {});
  }
  await clearPlayerSession();
  redirect("/");
}
