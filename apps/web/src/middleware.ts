// Host-based routing: one Next.js app serves both the operator dashboard (admin hosts,
// internal ingress) and every tenant storefront (public hosts). Admin hosts pass through
// untouched; any other host is rewritten into the /storefront/{host} route group, which
// resolves the site server-side and renders its theme.
//
// Security shape: the storefront segment is only reachable via this rewrite on non-admin
// hosts (direct /storefront/* paths on admin hosts 404), and the rewrite stamps the
// x-cb-site-host request header, which storefront/[host]/layout.tsx re-checks against its
// path segment — a client cannot render host B's site by crafting a path on host A.
import { NextRequest, NextResponse } from "next/server";

const DEFAULT_ADMIN_HOSTS = "localhost:3000,127.0.0.1:3000";

function adminHosts(): Set<string> {
  return new Set(
    (process.env.ADMIN_HOSTS ?? DEFAULT_ADMIN_HOSTS)
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Exported for reuse/tests: classify a raw Host header. */
export function classifyHost(rawHost: string): { admin: boolean; host: string } {
  const full = rawHost.trim().toLowerCase();
  const bare = full.split(":")[0];
  const admins = adminHosts();
  // Entries may be listed with or without a port; match both forms.
  return { admin: admins.has(full) || admins.has(bare), host: bare };
}

export function middleware(req: NextRequest) {
  const { admin, host } = classifyHost(req.headers.get("host") ?? "");
  const { pathname } = req.nextUrl;

  if (admin) {
    // The storefront segment does not exist as a direct path on the admin surface.
    if (pathname === "/storefront" || pathname.startsWith("/storefront/")) {
      return new NextResponse(null, { status: 404 });
    }
    return NextResponse.next();
  }

  if (!host) {
    return new NextResponse(null, { status: 400 });
  }

  // Storefront host: render through /storefront/{host}/... and stamp the header the
  // storefront layout verifies against its path segment.
  const url = req.nextUrl.clone();
  url.pathname = `/storefront/${host}${pathname === "/" ? "" : pathname}`;
  const headers = new Headers(req.headers);
  headers.set("x-cb-site-host", host);
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: [
    "/((?!_next/|favicon\\.ico|robots\\.txt|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map|txt|woff2?)$).*)",
  ],
};
