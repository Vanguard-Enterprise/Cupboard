"use server";

// Server Actions backing the auth forms. Each calls the gateway, persists the session as
// httpOnly cookies, and redirects. They return `{ error }` on failure so client forms can
// render it via useActionState.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DEFAULT_THEME_ID } from "@/themes/catalog";
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

/** Outbound BattleMetrics sync changes, keyed by explicit intent: `enable` (target
 * list + optional one-time backfill), `retarget` (save a new target list while
 * enabled, no toggle), `disable` (only `sync_bans_outbound: false`, never touching
 * the stored target list). */
export async function updateBmOutboundAction(
  _prev: BmOutboundFormState,
  form: FormData,
): Promise<BmOutboundFormState> {
  const intent = form.get("intent");
  const body: Record<string, unknown> = {};
  if (intent === "disable") {
    body.sync_bans_outbound = false;
  } else {
    const targetBanList = form.get("target_ban_list");
    if (typeof targetBanList === "string" && targetBanList) {
      body.target_ban_list = targetBanList;
    }
    if (intent === "enable") {
      body.sync_bans_outbound = true;
      body.backfill_existing = form.get("backfill_existing") === "on";
    } else if (!body.target_ban_list) {
      return { error: "choose a target ban list first" };
    }
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

export type BmRetryOutboxState = { error?: string; requeued?: number };

/** Requeue terminally-failed outbound pushes (`failed` -> `pending`) after a BM outage
 * that outlasted the retry window. A healthy runner drains them on its next tick. */
export async function retryBmOutboxAction(
  _prev: BmRetryOutboxState,
  _form: FormData,
): Promise<BmRetryOutboxState> {
  const res = await apiFetch("/integrations/bm/outbox/retry", { method: "POST" });
  if (!res.ok) return { error: await readError(res) };
  const data = await res.json();
  revalidatePath("/integrations/battlemetrics/status");
  return { requeued: data.requeued };
}

export type BmImportControlFormState = { error?: string; ok?: boolean };

/** Pause, resume, or cancel the tenant's live BattleMetrics import job (action comes
 * from a hidden form field so one server action covers all three buttons). */
export async function controlBmImportAction(
  _prev: BmImportControlFormState,
  form: FormData,
): Promise<BmImportControlFormState> {
  const action = form.get("action");
  if (typeof action !== "string" || !action) return { error: "missing action" };
  const res = await apiFetch(`/integrations/bm/import/${action}`, { method: "POST" });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/integrations/battlemetrics");
  return { ok: true };
}

export type BmResolveConflictFormState = { error?: string; ok?: boolean };

/** Resolve a BattleMetrics sync conflict: `keep_local` acknowledges the automatic
 * local-won outcome; `accept_remote` re-applies BM's side to the local ban. The choice
 * comes from the submit button; a 404 (already resolved by someone else) surfaces as an
 * error. */
export async function resolveBmConflictAction(
  _prev: BmResolveConflictFormState,
  form: FormData,
): Promise<BmResolveConflictFormState> {
  const id = form.get("id");
  const choice = form.get("choice");
  if (typeof id !== "string" || !id) return { error: "missing conflict id" };
  if (choice !== "keep_local" && choice !== "accept_remote") {
    return { error: "missing resolution choice" };
  }
  const res = await apiFetch(`/integrations/bm/conflicts/${id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choice }),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/integrations/battlemetrics/conflicts");
  return { ok: true };
}

export type BmImportScopeFormState = { error?: string; ok?: boolean };

/** Persist which BM entity types (servers/players/notes) the next import job pulls. */
export async function updateBmImportScopeAction(
  _prev: BmImportScopeFormState,
  form: FormData,
): Promise<BmImportScopeFormState> {
  const res = await apiFetch("/integrations/bm/sync", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      import_servers: form.get("import_servers") === "on",
      import_players: form.get("import_players") === "on",
      import_notes: form.get("import_notes") === "on",
    }),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/integrations/battlemetrics");
  return { ok: true };
}

export type SiteFormState = { error?: string; ok?: boolean };

function trimmed(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

/** URL fields must be absolute http(s) URLs; anything else (javascript:, data:,
 * scheme-relative) is refused before it reaches the API, which enforces the same rule. */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Build the site config JSON from the editor's form fields. Empty strings are
 * omitted rather than sent; links missing a label or url are dropped. The config is
 * always sent in full since the API replaces it wholesale. Returns an error string
 * instead when a field is invalid. */
function buildSiteConfig(
  form: FormData,
): { config: Record<string, unknown> } | { error: string } {
  const config: Record<string, unknown> = {};

  const name = trimmed(form, "name");
  if (name) config.name = name;
  const logoUrl = trimmed(form, "logo_url");
  if (logoUrl) {
    if (!isHttpUrl(logoUrl)) {
      return { error: "Logo URL must start with http:// or https://" };
    }
    config.logo_url = logoUrl;
  }

  const colors: Record<string, string> = {};
  const primary = trimmed(form, "color_primary");
  if (primary) colors.primary = primary;
  const background = trimmed(form, "color_background");
  if (background) colors.background = background;
  const foreground = trimmed(form, "color_foreground");
  if (foreground) colors.foreground = foreground;
  if (Object.keys(colors).length > 0) config.colors = colors;

  const hero: Record<string, string> = {};
  const heroTitle = trimmed(form, "hero_title");
  if (heroTitle) hero.title = heroTitle;
  const heroSubtitle = trimmed(form, "hero_subtitle");
  if (heroSubtitle) hero.subtitle = heroSubtitle;
  if (Object.keys(hero).length > 0) config.hero = hero;

  const about = trimmed(form, "about");
  if (about) config.about = about;

  const labels = form.getAll("link_label");
  const urls = form.getAll("link_url");
  const links = labels
    .map((label, i) => ({ label: String(label).trim(), url: String(urls[i] ?? "").trim() }))
    .filter((l) => l.label && l.url);
  for (const link of links) {
    if (!isHttpUrl(link.url)) {
      return { error: `Link "${link.label}": URL must start with http:// or https://` };
    }
  }
  if (links.length > 0) config.links = links;

  return { config };
}

/** Create the tenant's white-label site (one per org). */
export async function createSiteAction(
  _prev: SiteFormState,
  form: FormData,
): Promise<SiteFormState> {
  const slug = trimmed(form, "slug");
  if (!slug) return { error: "slug is required" };
  const themeId = trimmed(form, "theme_id") || DEFAULT_THEME_ID;
  const built = buildSiteConfig(form);
  if ("error" in built) return { error: built.error };

  const res = await apiFetch("/sites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, theme_id: themeId, config: built.config }),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/site");
  return { ok: true };
}

/** Update the tenant's site: slug, theme, publish state, and the full config. */
export async function updateSiteAction(
  _prev: SiteFormState,
  form: FormData,
): Promise<SiteFormState> {
  const slug = trimmed(form, "slug");
  if (!slug) return { error: "slug is required" };
  const themeId = trimmed(form, "theme_id") || DEFAULT_THEME_ID;
  const built = buildSiteConfig(form);
  if ("error" in built) return { error: built.error };
  const body = {
    slug,
    theme_id: themeId,
    config: built.config,
    published: form.get("published") === "on",
  };

  const res = await apiFetch("/sites", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/site");
  return { ok: true };
}

export type StoreConnectFormState = { error?: string; ok?: boolean };

/** Connect the tenant's store to a payment provider (PayNow only for now). The backend
 * probes the API key before storing it; the key is write-only and never read back. */
export async function connectStoreAction(
  _prev: StoreConnectFormState,
  form: FormData,
): Promise<StoreConnectFormState> {
  const provider = form.get("provider");
  if (provider !== "paynow") return { error: "unsupported provider" };
  const apiKey = form.get("api_key");
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { error: "API key is required" };
  }
  const body: Record<string, unknown> = { provider, api_key: apiKey };
  const storeId = trimmed(form, "store_id");
  if (storeId) body.store_id = storeId;

  const res = await apiFetch("/store/connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/store");
  return { ok: true };
}

export type StoreFormState = { error?: string; ok?: boolean };

/** Disconnect the tenant's store connection. */
export async function disconnectStoreAction(
  _prev: StoreFormState,
  _form: FormData,
): Promise<StoreFormState> {
  const res = await apiFetch("/store/connection", { method: "DELETE" });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/store");
  return { ok: true };
}

/** Trigger an immediate catalog sync for the tenant's store connection. */
export async function syncStoreAction(
  _prev: StoreFormState,
  _form: FormData,
): Promise<StoreFormState> {
  const res = await apiFetch("/store/sync", { method: "POST" });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/store");
  return { ok: true };
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
