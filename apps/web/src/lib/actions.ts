"use server";

// Server Actions backing the auth forms. Each calls the gateway, persists the session as
// httpOnly cookies, and redirects. They return `{ error }` on failure so client forms can
// render it via useActionState.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DEFAULT_THEME_ID } from "@/themes/catalog";
import { apiFetch, clearSession, gatewayBase, listOrgs, setSession, type Tokens } from "./api";

export type FormState = { error?: string; redirectTo?: string };

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
async function postAuthTarget(tokens: Tokens): Promise<string> {
  await setSession(tokens, null);
  const orgs = await listOrgs();
  if (orgs.length === 0) return "/onboarding";
  await scopeToOrg(orgs[0].id);
  return "/dashboard";
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
  return { redirectTo: await postAuthTarget((await res.json()) as Tokens) };
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
  redirect(await postAuthTarget((await res.json()) as Tokens));
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

export type DomainFormState = { error?: string; ok?: boolean };

/** Connect a custom domain to the tenant's site. The API validates the domain, enforces
 * the per-tenant cap, and rejects a domain already connected elsewhere (409); those
 * messages surface inline via readError. */
export async function addDomainAction(
  _prev: DomainFormState,
  form: FormData,
): Promise<DomainFormState> {
  const domain = trimmed(form, "domain");
  if (!domain) return { error: "domain is required" };

  const res = await apiFetch("/sites/domains", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/site");
  return { ok: true };
}

/** Disconnect a custom domain from the tenant's site. */
export async function removeDomainAction(
  _prev: DomainFormState,
  form: FormData,
): Promise<DomainFormState> {
  const id = form.get("domain_id");
  if (typeof id !== "string" || !id) return { error: "missing domain" };
  const res = await apiFetch(`/sites/domains/${id}`, { method: "DELETE" });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/site");
  return { ok: true };
}

/** Retry DNS/certificate issuance for a domain stuck in a failed status. */
export async function retryDomainAction(
  _prev: DomainFormState,
  form: FormData,
): Promise<DomainFormState> {
  const id = form.get("domain_id");
  if (typeof id !== "string" || !id) return { error: "missing domain" };
  const res = await apiFetch(`/sites/domains/${id}/retry`, { method: "POST" });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/site");
  return { ok: true };
}

export type StoreConnectFormState = { error?: string; ok?: boolean };

/** Connect the tenant's store to a payment provider (PayNow or Tebex). The backend probes
 * the API key before storing it; the key is write-only and never read back. PayNow takes an
 * optional store id; Tebex requires both its public/project token (store_id) and the Game
 * Server secret key (api_key). */
export async function connectStoreAction(
  _prev: StoreConnectFormState,
  form: FormData,
): Promise<StoreConnectFormState> {
  const provider = form.get("provider");
  if (provider !== "paynow" && provider !== "tebex") return { error: "unsupported provider" };
  const apiKey = form.get("api_key");
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { error: provider === "tebex" ? "Game Server secret key is required" : "API key is required" };
  }
  const body: Record<string, unknown> = { provider, api_key: apiKey };
  const storeId = trimmed(form, "store_id");
  if (provider === "tebex") {
    if (!storeId) return { error: "Tebex public token is required" };
    body.store_id = storeId;
  } else if (storeId) {
    body.store_id = storeId;
  }

  const res = await apiFetch("/store/connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/store");
  return { ok: true };
}

/** Save the operator-provided Tebex webhook secret (Tebex only). The secret is stored
 * server-side and used to verify inbound webhook signatures; it is never read back. */
export async function setWebhookSecretAction(
  _prev: StoreConnectFormState,
  form: FormData,
): Promise<StoreConnectFormState> {
  const secret = form.get("secret");
  if (typeof secret !== "string" || !secret.trim()) {
    return { error: "Webhook secret is required" };
  }
  const res = await apiFetch("/store/webhook-secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret }),
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

export type ApiKeyCreateState = { error?: string; token?: string };

/** Create a scoped API key. Scopes are capped server-side to the operator's own resolved
 * permissions; the plaintext token comes back exactly once, so the UI must reveal it
 * immediately. It is never retrievable again. */
export async function createApiKeyAction(
  _prev: ApiKeyCreateState,
  form: FormData,
): Promise<ApiKeyCreateState> {
  const name = trimmed(form, "name");
  if (!name) return { error: "name is required" };
  const scopes = form.getAll("scopes").filter((s): s is string => typeof s === "string" && !!s);
  if (scopes.length === 0) return { error: "select at least one scope" };

  const body: Record<string, unknown> = { name, scopes };
  // Already RFC 3339: the client converts the datetime-local value using the browser's
  // timezone (this action runs in the container's timezone, so no date math here).
  const expiresRaw = trimmed(form, "expires_at");
  if (expiresRaw) {
    if (Number.isNaN(new Date(expiresRaw).getTime())) return { error: "invalid expiry date" };
    body.expires_at = expiresRaw;
  }

  const res = await apiFetch("/auth/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: await readError(res) };
  const created = await res.json();
  revalidatePath("/api-keys");
  return { token: created.token };
}

/** Revoke an API key. The endpoint returns 204; the row stays visible but muted. */
export async function revokeApiKeyAction(form: FormData): Promise<void> {
  const id = form.get("key_id");
  if (typeof id === "string" && id) {
    await apiFetch(`/auth/api-keys/${id}/revoke`, { method: "POST" });
    revalidatePath("/api-keys");
  }
}

export type BillingActionState = { error?: string };

/** Absolute (app)/billing return URL for the Stripe hosted-redirect handoffs, built from
 * the request's Host header (only admin hosts reach these actions; the middleware routes
 * every other host to the storefront). Stripe requires https. */
async function billingReturnUrl(): Promise<string> {
  const hdrs = await import("next/headers").then((m) => m.headers());
  return `https://${hdrs.get("host")}/billing`;
}

/** Hand the operator off to Stripe Checkout (subscription mode) for a paid plan. The
 * plan comes from the submit button. The tenant rejects checkout when a live
 * subscription already exists; plan changes go through the portal instead. */
export async function startPlanCheckoutAction(
  _prev: BillingActionState,
  form: FormData,
): Promise<BillingActionState> {
  const plan = form.get("plan");
  if (plan !== "team" && plan !== "enterprise") return { error: "unsupported plan" };
  const res = await apiFetch("/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan, return_url: await billingReturnUrl() }),
  });
  if (!res.ok) return { error: await readError(res) };
  const body = await res.json();
  if (typeof body.redirect_url !== "string") return { error: "checkout returned no redirect" };
  redirect(body.redirect_url);
}

/** Hand the operator off to Stripe Checkout (payment mode) for a one-off service. The
 * service key comes from the submit button. Purchase is self-serve; fulfillment stays
 * manual (Resolved with Frank #2). */
export async function buyServiceAction(
  _prev: BillingActionState,
  form: FormData,
): Promise<BillingActionState> {
  const service = form.get("service");
  if (typeof service !== "string" || !service) return { error: "missing service" };
  const res = await apiFetch("/billing/services/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service, return_url: await billingReturnUrl() }),
  });
  if (!res.ok) return { error: await readError(res) };
  const body = await res.json();
  if (typeof body.redirect_url !== "string") return { error: "checkout returned no redirect" };
  redirect(body.redirect_url);
}

/** Hand the operator off to the Stripe Customer Portal (manage/cancel/payment method). */
export async function openBillingPortalAction(
  _prev: BillingActionState,
  _form: FormData,
): Promise<BillingActionState> {
  const res = await apiFetch("/billing/portal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ return_url: await billingReturnUrl() }),
  });
  if (!res.ok) return { error: await readError(res) };
  const body = await res.json();
  if (typeof body.redirect_url !== "string") return { error: "portal returned no redirect" };
  redirect(body.redirect_url);
}

export type TicketReplyState = { error?: string; ok?: boolean };

/** Staff reply on a ticket; the internal checkbox turns it into a staff-only note the
 * player never sees (the API excludes internal messages from the player surface). */
export async function createTicketMessageAction(
  _prev: TicketReplyState,
  form: FormData,
): Promise<TicketReplyState> {
  const id = form.get("ticket_id");
  if (typeof id !== "string" || !id) return { error: "missing ticket" };
  const body = trimmed(form, "body");
  if (!body) return { error: "message is required" };
  const res = await apiFetch(`/tickets/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, internal: form.get("internal") === "on" }),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath(`/tickets/${id}`);
  return { ok: true };
}

export type TicketActionState = { error?: string };

/** Move a ticket between open/pending/resolved/closed; the status rides on the button.
 * API refusals (e.g. a 409 for a change colliding with a sibling open appeal) surface
 * as {error} for the controls to render. */
export async function setTicketStatusAction(
  _prev: TicketActionState,
  form: FormData,
): Promise<TicketActionState> {
  const id = form.get("ticket_id");
  const status = form.get("status");
  if (typeof id !== "string" || !id) return { error: "missing ticket" };
  if (typeof status !== "string" || !status) return { error: "missing status" };
  const res = await apiFetch(`/tickets/${id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath(`/tickets/${id}`);
  return {};
}

/** Assign a ticket (assignee_user_id in the form; empty = unassign). */
export async function assignTicketAction(
  _prev: TicketActionState,
  form: FormData,
): Promise<TicketActionState> {
  const id = form.get("ticket_id");
  if (typeof id !== "string" || !id) return { error: "missing ticket" };
  const assignee = form.get("assignee_user_id");
  const res = await apiFetch(`/tickets/${id}/assign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assignee_user_id: typeof assignee === "string" && assignee ? assignee : null,
    }),
  });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath(`/tickets/${id}`);
  return {};
}

export type BindCodeState = { error?: string; code?: string; expiresAt?: string };

/** Mint a one-time Discord setup code (the /cupboard setup handoff). The plaintext comes
 * back exactly once and expires in 15 minutes; minting a new code invalidates the
 * previous one. */
export async function createTicketBindCodeAction(
  _prev: BindCodeState,
  _form: FormData,
): Promise<BindCodeState> {
  const res = await apiFetch("/tickets/discord/bind-code", { method: "POST" });
  if (!res.ok) return { error: await readError(res) };
  const body = await res.json();
  if (typeof body.code !== "string") return { error: "no code returned" };
  return { code: body.code, expiresAt: body.expires_at };
}

export type PrivacyJobFormState = { error?: string };

/** Start a TENANT-SCOPED privacy job (export or erase) for a player, from the admin
 * profile card. Covers this org's records only; the global identity graph and other
 * orgs' rows are never touched by an operator job (decision A2). The kind rides on the
 * submit button; identifiers come from the profile (whichever exist). Auth self-gates on
 * players.erase, so its refusals surface as-is. On success the operator lands on the
 * Privacy page, where erase jobs wait for dry-run confirmation. */
export async function createPrivacyJobAction(
  _prev: PrivacyJobFormState,
  form: FormData,
): Promise<PrivacyJobFormState> {
  const kind = form.get("kind");
  if (kind !== "export" && kind !== "erase") return { error: "unsupported job kind" };
  const body: Record<string, unknown> = { kind };
  const steamId = trimmed(form, "steam_id");
  if (steamId) body.steam_id = steamId;
  const discordId = trimmed(form, "discord_id");
  if (discordId) body.discord_id = discordId;
  if (!steamId && !discordId) {
    return { error: "this profile has no Steam or Discord identifier to key the job on" };
  }

  const res = await apiFetch("/auth/privacy/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: await readError(res) };
  redirect(`/privacy?flag=${kind}_started`);
  return {};
}

/** Confirm an erase job sitting in awaiting_confirm (the dry-run counts have been shown).
 * Auth refuses confirms from any other status; that refusal surfaces as-is. */
export async function confirmPrivacyJobAction(
  _prev: PrivacyJobFormState,
  form: FormData,
): Promise<PrivacyJobFormState> {
  const id = form.get("job_id");
  if (typeof id !== "string" || !id) return { error: "missing job" };
  const res = await apiFetch(`/auth/privacy/jobs/${id}/confirm`, { method: "POST" });
  if (!res.ok) return { error: await readError(res) };
  revalidatePath("/privacy");
  return {};
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
