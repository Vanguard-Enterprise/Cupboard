// Steam login landing. Steam authenticates against a central host which then 302s the
// browser to https://{host}/login/complete?code=XYZ; the middleware rewrites that here and
// stamps x-cb-site-host. We exchange the one-time code server-side for a player session,
// set the httpOnly cookies, and 303 the browser to their account (a GET after the exchange).
import { NextRequest, NextResponse } from "next/server";
import { gatewayBase } from "@/lib/api";
import { setPlayerSession, type PlayerTokens } from "@/lib/player";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const siteHost = request.headers.get("x-cb-site-host");
  const fail = NextResponse.redirect(new URL("/login?error=1", request.url), 303);

  if (!code || !siteHost) return fail;

  const res = await fetch(gatewayBase() + "/auth/player/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, site_host: siteHost }),
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return fail;

  const body = (await res.json().catch(() => null)) as PlayerTokens | null;
  if (!body?.access_token || !body?.refresh_token) return fail;

  await setPlayerSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
  });
  return NextResponse.redirect(new URL("/account", request.url), 303);
}
