// Theme registry: maps a site's theme_id onto the components + CSS variables that render
// it. The tenant service validates theme ids against its own allowlist
// (services/tenant/src/domain/sites.rs ALLOWED_THEMES); extend both together. Unknown
// ids fall back to the default theme so a stale DB value can never break rendering.
import type { CSSProperties, ComponentType, ReactNode } from "react";
import type { ResolvedSite } from "@/lib/site";
import type { SiteConfig } from "@/themes/catalog";
import { DEFAULT_THEME_ID } from "@/themes/catalog";
import { ember } from "@/themes/ember";

export type { SiteConfig } from "@/themes/catalog";
export { DEFAULT_THEME_ID } from "@/themes/catalog";

export type ThemeProps = {
  site: ResolvedSite;
  config: SiteConfig;
};

export type ThemeDefinition = {
  id: string;
  name: string;
  /** `--sf-*` CSS variables the theme's classes reference, derived from the config. */
  cssVariables: (config: SiteConfig) => CSSProperties;
  /** Chrome around every storefront page (header/nav/footer). */
  Shell: ComponentType<ThemeProps & { children: ReactNode }>;
  /** The site home page. */
  HomePage: ComponentType<ThemeProps>;
};

const THEMES: Record<string, ThemeDefinition> = {
  [ember.id]: ember,
};

export function getTheme(themeId: string): ThemeDefinition {
  return THEMES[themeId] ?? THEMES[DEFAULT_THEME_ID];
}

/** Only http(s) URLs may reach href/src attributes (stored-XSS guard; the tenant
 * service validates on write, this covers legacy/direct-DB values at render time). */
export function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Config arrives as untyped JSONB. Normalize defensively field by field: the tenant
 * service validates known fields on write, but SSR must never crash on a value that
 * predates that validation or was written by other means. */
export function asSiteConfig(raw: Record<string, unknown>): SiteConfig {
  const root = obj(raw);
  const colors = obj(root.colors);
  const hero = obj(root.hero);
  const links = Array.isArray(root.links) ? root.links : [];
  return {
    name: str(root.name),
    logo_url: safeHttpUrl(root.logo_url),
    colors: {
      primary: str(colors.primary),
      background: str(colors.background),
      foreground: str(colors.foreground),
    },
    hero: {
      title: str(hero.title),
      subtitle: str(hero.subtitle),
    },
    about: str(root.about),
    links: links
      .map((l) => {
        const link = obj(l);
        return { label: str(link.label), url: safeHttpUrl(link.url) };
      })
      .filter((l) => Boolean(l.label && l.url)),
  };
}

/** The display name every theme should use. */
export function siteDisplayName(site: ResolvedSite, config: SiteConfig): string {
  return config.name?.trim() || site.slug;
}
