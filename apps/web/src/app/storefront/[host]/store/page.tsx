// Store catalog page. The layout has already verified the host; fetchCatalog() here is
// deduped to the same fetch by React.cache. Products are grouped into category sections in
// sort_order; anything with no known category falls into a trailing "Other" section.
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { fetchCatalog, formatPrice, intervalLabel, type CatalogProduct } from "@/lib/catalog";

const bySort = (a: CatalogProduct, b: CatalogProduct) =>
  a.sort_order - b.sort_order || a.name.localeCompare(b.name);

export default async function StorePage() {
  const host = (await headers()).get("x-cb-site-host");
  if (!host) notFound();
  const catalog = await fetchCatalog(host);
  if (!catalog) notFound();

  const categories = [...catalog.categories].sort((a, b) => a.sort_order - b.sort_order);
  const known = new Set(categories.map((c) => c.external_id));

  const sections = categories
    .map((c) => ({
      key: c.external_id,
      name: c.name,
      products: catalog.products
        .filter((p) => p.category_ids.includes(c.external_id))
        .sort(bySort),
    }))
    .filter((s) => s.products.length > 0);

  const other = catalog.products
    .filter((p) => !p.category_ids.some((id) => known.has(id)))
    .sort(bySort);

  const empty = sections.length === 0 && other.length === 0;

  return (
    <div className="space-y-12">
      <header>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {catalog.store_name?.trim() || "Store"}
        </h1>
        <div aria-hidden className="mt-4 h-1 w-24 rounded bg-[var(--sf-primary)]" />
      </header>

      {empty ? (
        <p className="text-[var(--sf-muted)]">No products are available right now.</p>
      ) : null}

      {sections.map((s) => (
        <CategorySection key={s.key} name={s.name} products={s.products} />
      ))}
      {other.length > 0 ? <CategorySection name="Other" products={other} /> : null}
    </div>
  );
}

function CategorySection({ name, products }: { name: string; products: CatalogProduct[] }) {
  return (
    <section className="space-y-5">
      <h2 className="text-xl font-semibold">{name}</h2>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((p) => (
          <ProductCard key={p.external_id} product={p} />
        ))}
      </div>
    </section>
  );
}

function ProductCard({ product }: { product: CatalogProduct }) {
  const interval = intervalLabel(product);
  return (
    <a
      href={`/store/${product.external_id}`}
      className={`group flex flex-col overflow-hidden rounded-lg border border-[var(--sf-border)] transition-colors hover:border-[var(--sf-primary)] ${
        product.available ? "" : "opacity-60"
      }`}
    >
      {product.image_url ? (
        // Tenant/store-supplied remote URL: a plain <img> (next/image would need the host
        // allow-listed in next.config per tenant, which is impossible here).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.image_url} alt={product.name} className="aspect-video w-full object-cover" />
      ) : (
        <div aria-hidden className="aspect-video w-full bg-[var(--sf-card)]" />
      )}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium leading-snug">{product.name}</h3>
          {interval ? (
            <span className="shrink-0 rounded-full border border-[var(--sf-primary)]/40 px-2 py-0.5 text-xs text-[var(--sf-primary)]">
              {interval}
            </span>
          ) : null}
        </div>
        <div className="mt-auto">
          {product.available ? (
            <PriceBlock product={product} />
          ) : (
            <span className="inline-block rounded bg-[var(--sf-card)] px-2 py-0.5 text-xs font-medium text-[var(--sf-muted)]">
              Sold out
            </span>
          )}
        </div>
      </div>
    </a>
  );
}

function PriceBlock({ product }: { product: CatalogProduct }) {
  const final = product.price_final_minor;
  if (final != null && final < product.price_minor) {
    return (
      <p className="flex items-baseline gap-2">
        <span className="font-semibold text-[var(--sf-primary)]">
          {formatPrice(final, product.currency)}
        </span>
        <span className="text-sm text-[var(--sf-fg)]/50 line-through">
          {formatPrice(product.price_minor, product.currency)}
        </span>
      </p>
    );
  }
  return <p className="font-semibold">{formatPrice(product.price_minor, product.currency)}</p>;
}
