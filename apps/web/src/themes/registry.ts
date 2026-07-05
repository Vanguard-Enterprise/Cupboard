// Theme registry: maps a site's theme_id onto the components + CSS variables that render
// it. The tenant service validates theme ids against its own allowlist
// (services/tenant/src/domain/sites.rs ALLOWED_THEMES) — extend both together. Unknown
// ids fall back to the default theme so a stale DB value can never break rendering.
import type { CSSProperties, ComponentType, ReactNode } from "react";
import type { ResolvedSite } from "@/lib/site";
import { ember } from "@/themes/ember";

/** The site-config shape themes consume. All fields optional; themes supply defaults. */
export type SiteConfig = {
  name?: string;
  logo_url?: string;
  colors?: {
    primary?: string;
    background?: string;
    foreground?: string;
  };
  hero?: {
    title?: string;
    subtitle?: string;
  };
  about?: string;
  links?: { label?: string; url?: string }[];
};

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

export const DEFAULT_THEME_ID = ember.id;

export function getTheme(themeId: string): ThemeDefinition {
  return THEMES[themeId] ?? THEMES[DEFAULT_THEME_ID];
}

/** Config arrives as untyped JSONB; narrow it defensively (no runtime validator dep). */
export function asSiteConfig(raw: Record<string, unknown>): SiteConfig {
  return (raw ?? {}) as SiteConfig;
}

/** The display name every theme should use. */
export function siteDisplayName(site: ResolvedSite, config: SiteConfig): string {
  return config.name?.trim() || site.slug;
}
