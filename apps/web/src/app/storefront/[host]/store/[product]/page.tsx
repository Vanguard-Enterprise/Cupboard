// Product detail page. Host is verified by the layout; fetchCatalog() is deduped by
// React.cache. The product is found by its external_id (the [product] path segment).
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { fetchCatalog, formatPrice, intervalLabel } from "@/lib/catalog";

type Params = { params: Promise<{ product: string }> };

export default async function ProductPage({ params }: Params) {
  const host = (await headers()).get("x-cb-site-host");
  if (!host) notFound();
  const { product: productId } = await params;
  const catalog = await fetchCatalog(host);
  if (!catalog) notFound();

  const product = catalog.products.find((p) => p.external_id === productId);
  if (!product) notFound();

  const interval = intervalLabel(product);
  const final = product.price_final_minor;
  const onSale = final != null && final < product.price_minor;

  return (
    <div className="space-y-8">
      <a
        href="/store"
        className="inline-flex items-center gap-1 text-sm text-[var(--sf-fg)]/70 transition-colors hover:text-[var(--sf-primary)]"
      >
        <span aria-hidden>&larr;</span> Back to store
      </a>

      <div className="grid gap-8 md:grid-cols-2">
        <div>
          {product.image_url ? (
            // Store-supplied remote URL: a plain <img> (next/image would need the host
            // allow-listed in next.config per tenant, which is impossible here).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.image_url}
              alt={product.name}
              className="w-full rounded-lg border border-white/10 object-cover"
            />
          ) : (
            <div aria-hidden className="aspect-video w-full rounded-lg border border-white/10 bg-white/5" />
          )}
        </div>

        <div className="space-y-5">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">{product.name}</h1>
            {interval ? (
              <p className="text-sm text-[var(--sf-primary)]">Subscription · {interval}</p>
            ) : null}
          </div>

          <div>
            {product.available ? (
              onSale ? (
                <p className="flex items-baseline gap-3">
                  <span className="text-2xl font-semibold text-[var(--sf-primary)]">
                    {formatPrice(final, product.currency)}
                  </span>
                  <span className="text-[var(--sf-fg)]/50 line-through">
                    {formatPrice(product.price_minor, product.currency)}
                  </span>
                </p>
              ) : (
                <p className="text-2xl font-semibold">
                  {formatPrice(product.price_minor, product.currency)}
                </p>
              )
            ) : (
              <span className="inline-block rounded bg-white/10 px-3 py-1 text-sm font-medium text-[var(--sf-fg)]/70">
                Sold out
              </span>
            )}
          </div>

          {product.description?.trim() ? (
            <p className="whitespace-pre-line leading-relaxed text-[var(--sf-fg)]/80">
              {product.description}
            </p>
          ) : null}

          <div className="space-y-2 pt-2">
            <button
              type="button"
              disabled
              className="cursor-not-allowed rounded-md bg-[var(--sf-primary)] px-5 py-2.5 font-medium text-black/80 opacity-60"
            >
              Sign in to purchase
            </button>
            <p className="text-xs text-[var(--sf-fg)]/50">
              Checkout arrives with player accounts
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
