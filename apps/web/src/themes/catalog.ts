// Theme catalog: shared config type + theme ids/names only, with no component imports,
// so client components (the admin theme picker, server actions) can consume it without
// pulling theme render code into their bundles. Mirrors the tenant service's allowlist
// (services/tenant/src/domain/sites.rs ALLOWED_THEMES); extend both together.

/** The site-config shape themes and the admin editor share. All fields optional;
 * consumers supply defaults. */
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

export const THEME_CHOICES = [{ id: "ember", name: "Ember" }] as const;

export const DEFAULT_THEME_ID = "ember";
