export const organizationProfileKey =
  "cupboard:organization:local-preview:profile:v1";
export const defaultOrganizationProfile = {
  name: "Cupboard",
  description: "",
  website: "",
  publicEmail: "",
  supportUrl: "",
  legalName: "",
  privateEmail: "",
  billingEmail: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
};
export type OrganizationProfile = typeof defaultOrganizationProfile;
export type ProfileErrors = Partial<Record<keyof OrganizationProfile, string>>;

export function validateProfile(profile: OrganizationProfile): ProfileErrors {
  const errors: ProfileErrors = {};
  if (!profile.name.trim()) errors.name = "Enter an organization name.";
  for (const key of Object.keys(profile) as (keyof OrganizationProfile)[]) {
    const limit = ["description", "addressLine1", "addressLine2"].includes(key)
      ? 1000
      : 200;
    if (profile[key].length > limit)
      errors[key] = `Use ${limit} characters or fewer.`;
  }
  for (const key of ["publicEmail", "privateEmail", "billingEmail"] as const) {
    if (profile[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile[key]))
      errors[key] = "Enter a valid email address.";
  }
  for (const key of ["website", "supportUrl"] as const) {
    if (!profile[key]) continue;
    try {
      const url = new URL(profile[key]);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      errors[key] = "Enter an http:// or https:// URL without credentials.";
    }
  }
  return errors;
}

export function parseProfile(raw: string): OrganizationProfile {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid profile");
  const stored = value as Record<string, unknown>;
  // Preserve the old free-form address verbatim; do not guess its components.
  if (typeof stored.address === "string" && stored.addressLine1 === undefined) {
    Object.assign(stored, {
      addressLine1: stored.address,
      addressLine2: "",
      city: "",
      region: "",
      postalCode: "",
      country: "",
    });
  }
  const profile = { ...defaultOrganizationProfile };
  for (const key of Object.keys(profile) as (keyof OrganizationProfile)[]) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field !== "string") throw new Error("Invalid profile");
    profile[key] = field;
  }
  if (Object.keys(validateProfile(profile)).length)
    throw new Error("Invalid profile");
  return profile;
}

// Private contact values must never be indexed by the general workspace search.
export function organizationSearchEntries(profile: OrganizationProfile) {
  return [
    {
      title: profile.name,
      detail: "Organization profile",
      keywords: profile.description,
      href: "/dashboard/organization/settings/profile",
    },
    ...(
      [
        ["Website", profile.website],
        ["Public email", profile.publicEmail],
        ["Support", profile.supportUrl],
      ] as const
    )
      .filter(([, value]) => value)
      .map(([title, value]) => ({
        title,
        detail: value,
        keywords: value,
        href: "/dashboard/organization/settings/profile",
      })),
  ];
}
