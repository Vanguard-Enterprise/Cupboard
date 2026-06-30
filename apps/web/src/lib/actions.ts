"use server";

// Server Actions backing the auth forms. Each calls the gateway, persists the session as
// httpOnly cookies, and redirects. They return `{ error }` on failure so client forms can
// render it via useActionState.
import { redirect } from "next/navigation";
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
