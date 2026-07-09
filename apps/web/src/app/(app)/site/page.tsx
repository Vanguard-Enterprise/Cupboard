import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import type { SiteConfig } from "@/themes/catalog";
import { CreateSiteForm } from "./create-site-form";
import { DomainsPanel, type Domain } from "./domains-panel";
import { SiteEditor } from "./site-editor";

export type Site = {
  id: string;
  tenant_id: string;
  slug: string;
  theme_id: string;
  config: SiteConfig;
  published: boolean;
  created_at: string;
  updated_at: string;
};

type SitesResponse = { site: Site | null; default_host: string | null };

type DomainsResponse = { domains: Domain[]; edge_target: string | null };

export default async function SitePage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.SitesEdit)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to site management.</p>;
  }

  const res = await apiFetch("/sites");
  const data: SitesResponse = res.ok ? await res.json() : { site: null, default_host: null };

  let domainsData: DomainsResponse = { domains: [], edge_target: null };
  if (res.ok && data.site) {
    const domainsRes = await apiFetch("/sites/domains");
    if (domainsRes.ok) domainsData = await domainsRes.json();
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Site</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Manage your white-label public site: theme, branding, and content.
        </p>
      </div>
      {!res.ok && (
        <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          Could not load your site right now (service error).
        </p>
      )}
      {res.ok && !data.site && <CreateSiteForm />}
      {res.ok && data.site && data.default_host && (
        <>
          <SiteEditor site={data.site} defaultHost={data.default_host} />
          <DomainsPanel domains={domainsData.domains} edgeTarget={domainsData.edge_target} />
        </>
      )}
    </div>
  );
}
