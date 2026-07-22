// Streams the player's own export bundle (application/gzip) from auth through the BFF;
// the player token stays in the httpOnly cookie and never reaches client JavaScript.
// Downloads are one-time: after the first take auth answers 410, which we turn into a
// friendly ?privacy= banner on the account page. Relative-Location 303s, mirroring the
// checkout continue route.
import { NextRequest, NextResponse } from "next/server";
import { gatewayBase } from "@/lib/api";

const ACCESS = "cb_player_access";

function see(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: path } });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; id: string }> },
): Promise<NextResponse> {
  const token = request.cookies.get(ACCESS)?.value;
  if (!token) return see("/login");

  const { id } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return see("/account?privacy=error");

  const res = await fetch(`${gatewayBase()}/auth/player/privacy/jobs/${id}/download`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res) return see("/account?privacy=error");
  if (res.status === 410) return see("/account?privacy=download_gone");
  if (!res.ok || !res.body) return see("/account?privacy=error");

  return new NextResponse(res.body, {
    status: 200,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/gzip",
      "content-disposition":
        res.headers.get("content-disposition") ?? 'attachment; filename="my-data.json.gz"',
      "cache-control": "no-store",
    },
  });
}
