"use server";

// Server Actions backing the auth forms. Each calls the gateway, persists the session as
// httpOnly cookies, and redirects. They return `{ error }` on failure so client forms can
// render it via useActionState.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { apiFetch, clearSession, gatewayBase, listOrgs, setSession, type Tokens } from "./api";

export type FormState = { error?: string };

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.message ?? body?.error ?? `request failed (${res.status})`;
  } catch {
    return `request failed (${res.status})`;
  }
}

/** After authenticating, scope the session to an org (the only one, or the first) and go
 * to the dashboard; with no orgs yet, go to onboarding. */
async function postAuthRedirect(tokens: Tokens): Promise<never> {
  await setSession(tokens, null);
  const orgs = await listOrgs();
  if (orgs.length === 0) redirect("/onboarding");
  await scopeToOrg(orgs[0].id);
  redirect("/dashboard");
}

async function scopeToOrg(orgId: string): Promise<void> {
  // Re-mint an org-scoped access token from the refresh token.
  const jar = await import("next/headers").then((m) => m.cookies());
  const refresh = (await jar).get("cb_refresh")?.value;
  const res = await fetch(gatewayBase() + "/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh, org_id: orgId }),
    cache: "no-store",
  });
  if (res.ok) await setSession((await res.json()) as Tokens, orgId);
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const res = await fetch(gatewayBase() + "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    cache: "no-store",
  });
  if (!res.ok) return { error: await readError(res) };
  await postAuthRedirect((await res.json()) as Tokens);
  return {};
}

export async function signupAction(_prev: FormState, form: FormData): Promise<FormState> {
  const res = await fetch(gatewayBase() + "/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: form.get("email"),
      password: form.get("password"),
      display_name: form.get("display_name"),
    }),
    cache: "no-store",
  });
  if (!res.ok) return { error: await readError(res) };
  await postAuthRedirect((await res.json()) as Tokens);
  return {};
}

export async function createOrgAction(_prev: FormState, form: FormData): Promise<FormState> {
  const res = await apiFetch("/auth/orgs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: form.get("name") }),
  });
  if (!res.ok) return { error: await readError(res) };
  const org = await res.json();
  await scopeToOrg(org.id);
  redirect("/dashboard");
  return {};
}

export async function switchOrgAction(form: FormData): Promise<void> {
  const orgId = form.get("org_id");
  if (typeof orgId === "string") await scopeToOrg(orgId);
  redirect("/dashboard");
}

export async function acceptInviteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const res = await fetch(gatewayBase() + "/auth/invites/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: form.get("token"),
      password: form.get("password") || null,
      display_name: form.get("display_name") || null,
    }),
    cache: "no-store",
  });
  if (!res.ok) return { error: await readError(res) };
  // Accept returns an org-scoped session already.
  const tokens = (await res.json()) as Tokens;
  await setSession(tokens, null);
  redirect("/dashboard");
  return {};
}

export type InviteState = { error?: string; acceptUrl?: string };

export async function createInviteAction(
  _prev: InviteState,
  form: FormData,
): Promise<InviteState> {
  const roleId = form.get("role_id");
  const body: Record<string, unknown> = { email: form.get("email") };
  if (typeof roleId === "string" && roleId) body.role_ids = [roleId];
  const res = await apiFetch("/auth/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: await readError(res) };
  const created = await res.json();
  return { acceptUrl: created.accept_url };
}

export type ServerFormState = { error?: string; ok?: boolean };

/** Add a game-server connection (Fleet). The RCON password is sent once and stored
 * envelope-encrypted server-side; it is never read back. */
export async function createServerAction(
  _prev: ServerFormState,
  form: FormData,
): Promise<ServerFormState> {
  const port = Number(form.get("rcon_port"));
  const queryPortRaw = form.get("query_port");
  const queryPort = queryPortRaw ? Number(queryPortRaw) : null;
  const body: Record<string, unknown> = {
    name: form.get("name"),
    rcon_host: form.get("rcon_host"),
    rcon_port: Number.isFinite(port) ? port : 0,
    rcon_password: form.get("rcon_password"),
  };
  if (queryPort && Number.isFinite(queryPort)) body.query_port = queryPort;

  const res = await apiFetch("/fleet/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/servers");
  return { ok: true };
}

/** Remove a server connection. */
export async function deleteServerAction(form: FormData): Promise<void> {
  const id = form.get("server_id");
  if (typeof id === "string" && id) {
    await apiFetch(`/fleet/servers/${id}`, { method: "DELETE" });
    revalidatePath("/servers");
  }
}

export type IngestTokenState = { error?: string; token?: string };

/** Issue (or rotate) a server's push-ingest token. The plaintext comes back exactly
 * once — the UI must show it immediately; it is never retrievable again. */
export async function issueIngestTokenAction(
  _prev: IngestTokenState,
  form: FormData,
): Promise<IngestTokenState> {
  const id = form.get("server_id");
  if (typeof id !== "string" || !id) return { error: "missing server" };
  const res = await apiFetch(`/fleet/servers/${id}/ingest-token`, { method: "POST" });
  if (!res.ok) return { error: await readError(res) };
  const body = await res.json();
  revalidatePath("/servers");
  return { token: body.token };
}

export async function revokeIngestTokenAction(form: FormData): Promise<void> {
  const id = form.get("server_id");
  if (typeof id === "string" && id) {
    await apiFetch(`/fleet/servers/${id}/ingest-token`, { method: "DELETE" });
    revalidatePath("/servers");
  }
}

export type BanFormState = { error?: string; ok?: boolean };

/// Create an identifier-level ban (Identity). `subject_value` is the Steam ID.
export async function createBanAction(
  _prev: BanFormState,
  form: FormData,
): Promise<BanFormState> {
  const body: Record<string, unknown> = {
    subject_type: "steam",
    subject_value: form.get("subject_value"),
    reason: form.get("reason") || null,
    scope: "network",
  };
  const playerId = form.get("player_id");
  if (typeof playerId === "string" && playerId) body.player_id = playerId;

  const res = await apiFetch("/bans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/bans");
  return { ok: true };
}

/// Revoke an active ban.
export async function revokeBanAction(form: FormData): Promise<void> {
  const id = form.get("ban_id");
  if (typeof id === "string" && id) {
    await apiFetch(`/bans/${id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: form.get("reason") || null }),
    });
    revalidatePath("/bans");
  }
}

/// Dismiss or action a ban-evasion alert.
export async function dismissEvasionAction(form: FormData): Promise<void> {
  await updateEvasion(form, "dismiss");
}
export async function actionEvasionAction(form: FormData): Promise<void> {
  await updateEvasion(form, "action");
}
async function updateEvasion(form: FormData, verb: "dismiss" | "action"): Promise<void> {
  const id = form.get("alert_id");
  if (typeof id === "string" && id) {
    await apiFetch(`/evasion/${id}/${verb}`, { method: "POST" });
    revalidatePath("/evasion");
  }
}

export type BmConnectFormState = { error?: string; ok?: boolean };

/** Connect (or reconnect) the tenant's BattleMetrics org + personal access token. The
 * backend probes the token against BattleMetrics before storing it; the token is
 * never read back. */
export async function connectBattlemetricsAction(
  _prev: BmConnectFormState,
  form: FormData,
): Promise<BmConnectFormState> {
  const bmOrgId = form.get("bm_org_id");
  const token = form.get("token");
  if (typeof bmOrgId !== "string" || !bmOrgId.trim()) {
    return { error: "organization id is required" };
  }
  if (typeof token !== "string" || !token.trim()) {
    return { error: "token is required" };
  }

  const res = await apiFetch("/integrations/bm/connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bm_org_id: bmOrgId, token }),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/integrations/battlemetrics");
  return { ok: true };
}

export type BmImportFormState = { error?: string; ok?: boolean };

/** Queue a BattleMetrics import job for the tenant's connection. */
export async function startBmImportAction(
  _prev: BmImportFormState,
  _form: FormData,
): Promise<BmImportFormState> {
  const res = await apiFetch("/integrations/bm/import", { method: "POST" });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/integrations/battlemetrics");
  return { ok: true };
}

export type BmSyncFormState = { error?: string; ok?: boolean };

/** Toggle inbound BattleMetrics sync (new bans tail in ~1m, edits/deletes re-scan in
 * ~15m) for the tenant's connection. */
export async function toggleBmSyncAction(
  _prev: BmSyncFormState,
  form: FormData,
): Promise<BmSyncFormState> {
  const syncEnabled = form.get("sync_enabled") === "true";
  const res = await apiFetch("/integrations/bm/sync", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sync_enabled: syncEnabled }),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/integrations/battlemetrics");
  return { ok: true };
}

export type BmOutboundFormState = { error?: string; ok?: boolean; backfilled?: number };

/** Toggle outbound BattleMetrics sync. Enabling also sets the target ban list and,
 * if requested, queues a one-time backfill of existing active bans; disabling sends
 * only `sync_bans_outbound: false` so it never touches the stored target list. */
export async function updateBmOutboundAction(
  _prev: BmOutboundFormState,
  form: FormData,
): Promise<BmOutboundFormState> {
  const enabling = form.get("sync_bans_outbound") === "true";
  const body: Record<string, unknown> = { sync_bans_outbound: enabling };
  if (enabling) {
    const targetBanList = form.get("target_ban_list");
    if (typeof targetBanList === "string" && targetBanList) {
      body.target_ban_list = targetBanList;
    }
    body.backfill_existing = form.get("backfill_existing") === "on";
  }
  const res = await apiFetch("/integrations/bm/sync", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: await readError(res) };
  const data = await res.json();
  revalidatePath("/integrations/battlemetrics");
  return { ok: true, backfilled: data.backfilled };
}

export async function logoutAction(): Promise<void> {
  const jar = await import("next/headers").then((m) => m.cookies());
  const refresh = (await jar).get("cb_refresh")?.value;
  if (refresh) {
    await fetch(gatewayBase() + "/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
      cache: "no-store",
    }).catch(() => {});
  }
  await clearSession();
  redirect("/login");
}
