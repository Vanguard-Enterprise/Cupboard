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

export type PlayerTicketFormState = { error?: string };

async function playerTicketError(res: Response | null): Promise<string> {
  if (!res) return "request failed";
  try {
    const body = await res.json();
    return body?.message ?? body?.error ?? `request failed (${res.status})`;
  } catch {
    return `request failed (${res.status})`;
  }
}

/** Open a support ticket (general or ban appeal). The tenant comes from the player token;
 * on success the browser is sent to the new ticket's thread (or the list when the create
 * response carries no id). */
export async function createPlayerTicketAction(
  _prev: PlayerTicketFormState,
  form: FormData,
): Promise<PlayerTicketFormState> {
  const token = (await cookies()).get("cb_player_access")?.value;
  if (!token) redirect("/login");

  const type = form.get("type");
  if (type !== "general" && type !== "ban_appeal") return { error: "unsupported ticket type" };
  const subject = typeof form.get("subject") === "string" ? String(form.get("subject")).trim() : "";
  if (!subject) return { error: "subject is required" };
  const messageBody = typeof form.get("body") === "string" ? String(form.get("body")).trim() : "";
  if (!messageBody) return { error: "message is required" };

  const payload: Record<string, unknown> = { type, subject, body: messageBody };
  const category = form.get("category");
  if (typeof category === "string" && category.trim()) payload.category = category.trim();
  const banId = form.get("ban_id");
  if (type === "ban_appeal") {
    if (typeof banId !== "string" || !banId) return { error: "pick the ban you are appealing" };
    payload.ban_id = banId;
  }

  const res = await fetch(`${gatewayBase()}/player/tickets`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return { error: await playerTicketError(res) };
  // The 201 body is {"ticket": {...}} (tenant tickets contract).
  const created = (await res.json().catch(() => null)) as { ticket?: { id?: unknown } } | null;
  const id = created?.ticket?.id;
  // redirect() throws NEXT_REDIRECT; keep it out of any try/catch above.
  redirect(typeof id === "string" ? `/tickets/${id}` : "/tickets");
}

/** Reply on the player's own ticket; redirects back to the thread so it re-renders
 * fresh. */
export async function replyPlayerTicketAction(
  _prev: PlayerTicketFormState,
  form: FormData,
): Promise<PlayerTicketFormState> {
  const token = (await cookies()).get("cb_player_access")?.value;
  if (!token) redirect("/login");

  const id = form.get("ticket_id");
  if (typeof id !== "string" || !id) return { error: "missing ticket" };
  const messageBody = typeof form.get("body") === "string" ? String(form.get("body")).trim() : "";
  if (!messageBody) return { error: "message is required" };

  const res = await fetch(`${gatewayBase()}/player/tickets/${id}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body: messageBody }),
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return { error: await playerTicketError(res) };
  redirect(`/tickets/${id}`);
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
