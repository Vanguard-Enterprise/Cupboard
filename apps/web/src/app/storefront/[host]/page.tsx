// Storefront home page. The layout has already verified the host and resolved the site;
// resolveSite() here is deduped to the same fetch by React.cache.
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { resolveSite } from "@/lib/site";
import { asSiteConfig, getTheme } from "@/themes/registry";

export default async function StorefrontHome() {
  const host = (await headers()).get("x-cb-site-host");
  if (!host) notFound();
  const site = await resolveSite(host);
  if (!site) notFound();

  const config = asSiteConfig(site.config);
  const theme = getTheme(site.theme_id);
  return <theme.HomePage site={site} config={config} />;
}
