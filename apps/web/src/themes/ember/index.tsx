// "Ember": the v1 dark storefront theme. Deliberately dependency-free: Tailwind
// utilities over `--sf-*` CSS variables set from the site config.
import type { CSSProperties, ReactNode } from "react";
import type { SiteConfig, ThemeDefinition, ThemeProps } from "@/themes/registry";
import { siteDisplayName } from "@/themes/registry";

function cssVariables(config: SiteConfig): CSSProperties {
  return {
    "--sf-primary": config.colors?.primary || "#f97316",
    "--sf-bg": config.colors?.background || "#0a0a0a",
    "--sf-fg": config.colors?.foreground || "#fafafa",
  } as CSSProperties;
}

function Shell({ site, config, children }: ThemeProps & { children: ReactNode }) {
  const name = siteDisplayName(site, config);
  const links = (config.links ?? []).filter((l) => l.label && l.url);
  return (
    <div className="flex min-h-screen flex-col bg-[var(--sf-bg)] text-[var(--sf-fg)]">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-4">
          {config.logo_url ? (
            // Tenant-supplied remote URL: a plain <img> (next/image would need the host
            // allow-listed in next.config per tenant, which is impossible here).
            // eslint-disable-next-line @next/next/no-img-element
            <img src={config.logo_url} alt={name} className="h-9 w-9 rounded object-cover" />
          ) : (
            <div
              aria-hidden
              className="flex h-9 w-9 items-center justify-center rounded bg-[var(--sf-primary)] font-bold text-black/80"
            >
              {name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="text-lg font-semibold tracking-tight">{name}</span>
          <nav className="ml-auto flex items-center gap-5 text-sm text-[var(--sf-fg)]/80">
            {links.map((l) => (
              <a
                key={`${l.label}-${l.url}`}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-[var(--sf-primary)]"
              >
                {l.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
      <footer className="border-t border-white/10 py-6 text-center text-xs text-[var(--sf-fg)]/50">
        {name} · powered by Cupboard
      </footer>
    </div>
  );
}

function HomePage({ site, config }: ThemeProps) {
  const name = siteDisplayName(site, config);
  const title = config.hero?.title?.trim() || `Welcome to ${name}`;
  const subtitle = config.hero?.subtitle?.trim();
  return (
    <div className="space-y-12">
      <section className="py-12 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{title}</h1>
        {subtitle ? (
          <p className="mx-auto mt-4 max-w-2xl text-lg text-[var(--sf-fg)]/70">{subtitle}</p>
        ) : null}
        <div
          aria-hidden
          className="mx-auto mt-8 h-1 w-24 rounded bg-[var(--sf-primary)]"
        />
      </section>
      {config.about?.trim() ? (
        <section className="mx-auto max-w-3xl">
          <h2 className="mb-3 text-xl font-semibold">About</h2>
          <p className="whitespace-pre-line leading-relaxed text-[var(--sf-fg)]/80">
            {config.about}
          </p>
        </section>
      ) : null}
    </div>
  );
}

export const ember: ThemeDefinition = {
  id: "ember",
  name: "Ember",
  cssVariables,
  Shell,
  HomePage,
};
