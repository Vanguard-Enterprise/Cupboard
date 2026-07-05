// Storefront shell for one tenant site, addressed by hostname. Only reachable through
// the middleware rewrite (see src/middleware.ts): the [host] path segment must match the
// x-cb-site-host header the middleware stamped from the actual Host header — a crafted
// path like /storefront/other-site.example on some other host renders nothing.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { resolveSite } from "@/lib/site";
import { asSiteConfig, getTheme, siteDisplayName } from "@/themes/registry";

type Params = { params: Promise<{ host: string }> };

/** The verified storefront host for this request, or null if the guard fails. */
async function verifiedHost(params: Params["params"]): Promise<string | null> {
  const { host } = await params;
  const stamped = (await headers()).get("x-cb-site-host");
  const decoded = decodeURIComponent(host).toLowerCase();
  if (!stamped || stamped.toLowerCase() !== decoded) return null;
  return decoded;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const host = await verifiedHost(params);
  if (!host) return {};
  const site = await resolveSite(host);
  if (!site) return {};
  const config = asSiteConfig(site.config);
  return {
    title: siteDisplayName(site, config),
    description: config.hero?.subtitle ?? undefined,
  };
}

export default async function StorefrontLayout({
  children,
  params,
}: Params & { children: React.ReactNode }) {
  const host = await verifiedHost(params);
  if (!host) notFound();

  const site = await resolveSite(host);
  if (!site) notFound();

  const config = asSiteConfig(site.config);
  const theme = getTheme(site.theme_id);
  return (
    <div style={theme.cssVariables(config)}>
      <theme.Shell site={site} config={config}>
        {children}
      </theme.Shell>
    </div>
  );
}
