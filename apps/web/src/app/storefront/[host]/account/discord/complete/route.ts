// Discord link landing. After the player authorizes Discord, the central login host 302s
// the browser to https://{host}/account/discord/complete?code=XYZ; the middleware rewrites
// it here. We finalize the link server-side UNDER THE PLAYER'S SESSION (the code is bound to
// the player who started the flow, and the backend only links when the completing session
// matches), then 303 the browser to their account with the outcome.
import { NextRequest, NextResponse } from "next/server";
import { gatewayBase } from "@/lib/api";

const ACCESS = "cb_player_access";

// A relative-Location 303. Building an absolute URL from request.url would use the pod's
// internal address (0.0.0.0:3000) since cupboard-web is behind Traefik/the gateway; a
// relative Location resolves against the public storefront URL the browser is on.
function see(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: path } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const token = request.cookies.get(ACCESS)?.value;
  const fail = see("/account?discord=error");

  if (!token) return see("/login");
  if (!code) return fail;

  const res = await fetch(gatewayBase() + "/auth/player/discord/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ code }),
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return fail;

  const body = (await res.json().catch(() => null)) as { outcome?: unknown } | null;
  const outcome = body && typeof body.outcome === "string" ? body.outcome : "error";
  return see(`/account?discord=${outcome}`);
}
