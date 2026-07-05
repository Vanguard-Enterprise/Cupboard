// Storefront home page. The layout has already verified the host and resolved the site;
// resolveSite() here is deduped to the same fetch by React.cache. A small store teaser is
// appended below the theme's home page when the tenant has a store with products.
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { fetchCatalog, formatPrice, type CatalogProduct } from "@/lib/catalog";
import { resolveSite } from "@/lib/site";
import { asSiteConfig, getTheme } from "@/themes/registry";

export default async function StorefrontHome() {
  const host = (await headers()).get("x-cb-site-host");
  if (!host) notFound();
  const site = await resolveSite(host);
  if (!site) notFound();

  const config = asSiteConfig(site.config);
  const theme = getTheme(site.theme_id);

  const catalog = await fetchCatalog(host);
  const teaser = catalog
    ? [...catalog.products].sort((a, b) => a.sort_order - b.sort_order).slice(0, 3)
    : [];

  return (
    <>
      <theme.HomePage site={site} config={config} />
      {teaser.length > 0 ? (
        <StoreTeaser products={teaser} storeName={catalog?.store_name} />
      ) : null}
    </>
  );
}

function StoreTeaser({
  products,
  storeName,
}: {
  products: CatalogProduct[];
  storeName?: string | null;
}) {
  return (
    <section className="mt-16 border-t border-white/10 pt-12">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold">{storeName?.trim() || "From the store"}</h2>
        <a
          href="/store"
          className="text-sm text-[var(--sf-primary)] transition-colors hover:underline"
        >
          Visit the store &rarr;
        </a>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {products.map((p) => (
          <a
            key={p.external_id}
            href={`/store/${p.external_id}`}
            className={`group flex flex-col overflow-hidden rounded-lg border border-white/10 transition-colors hover:border-[var(--sf-primary)] ${
              p.available ? "" : "opacity-60"
            }`}
          >
            {p.image_url ? (
              // Store-supplied remote URL: a plain <img> (next/image would need the host
              // allow-listed in next.config per tenant, which is impossible here).
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.image_url} alt={p.name} className="aspect-video w-full object-cover" />
            ) : (
              <div aria-hidden className="aspect-video w-full bg-white/5" />
            )}
            <div className="flex flex-1 flex-col gap-1 p-3">
              <span className="text-sm font-medium leading-snug">{p.name}</span>
              <span className="mt-auto text-sm text-[var(--sf-fg)]/70">
                {p.available ? teaserPrice(p) : "Sold out"}
              </span>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

function teaserPrice(product: CatalogProduct): string {
  const final = product.price_final_minor;
  const effective =
    final != null && final < product.price_minor ? final : product.price_minor;
  return formatPrice(effective, product.currency);
}
