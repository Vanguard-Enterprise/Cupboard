// Streams a completed export bundle (application/gzip) from auth through the BFF, so the
// operator token never reaches the browser. Downloads are one-time: after the first take
// auth answers 410, which we turn into a friendly banner back on the Privacy page rather
// than a bare error body. Relative-Location 303s, mirroring the checkout continue route.
import { NextResponse } from "next/server";
import { apiFetch } from "@/lib/api";

function see(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: path } });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return see("/privacy?flag=download_failed");

  const res = await apiFetch(`/auth/privacy/jobs/${id}/download`).catch(() => null);
  if (!res) return see("/privacy?flag=download_failed");
  if (res.status === 410) return see("/privacy?flag=download_gone");
  if (!res.ok || !res.body) return see("/privacy?flag=download_failed");

  return new NextResponse(res.body, {
    status: 200,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/gzip",
      "content-disposition":
        res.headers.get("content-disposition") ??
        `attachment; filename="cupboard-export-${id}.json.gz"`,
      "cache-control": "no-store",
    },
  });
}
