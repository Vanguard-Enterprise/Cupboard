import { describe, expect, it } from "vitest";
import {
  defaultOrganizationProfile,
  organizationSearchEntries,
  parseProfile,
  validateProfile,
} from "./organization-profile";
import { dashboardNavigation, navigationHref } from "./dashboard-navigation";

describe("organization profile", () => {
  it("round trips saved details and both contact types", () => {
    const profile = {
      ...defaultOrganizationProfile,
      name: "Test community",
      publicEmail: "support@example.com",
      privateEmail: "owner@example.com",
    };
    expect(validateProfile(profile)).toEqual({});
    expect(parseProfile(JSON.stringify(profile))).toEqual(profile);
  });
  it("rejects missing names, invalid contact details, and unsafe URLs", () => {
    expect(
      validateProfile({
        ...defaultOrganizationProfile,
        name: " ",
        publicEmail: "bad",
        website: "javascript:alert(1)",
      }),
    ).toHaveProperty("name");
    expect(
      validateProfile({
        ...defaultOrganizationProfile,
        website: "https://user:password@example.com",
      }),
    ).toHaveProperty("website");
    expect(
      validateProfile({ ...defaultOrganizationProfile, publicEmail: "bad" }),
    ).toHaveProperty("publicEmail");
  });
  it("rejects malformed storage and does not retain unknown secret fields", () => {
    expect(() => parseProfile("not json")).toThrow();
    expect(() =>
      parseProfile(
        JSON.stringify({ ...defaultOrganizationProfile, name: 123 }),
      ),
    ).toThrow();
    expect(
      parseProfile(
        JSON.stringify({
          ...defaultOrganizationProfile,
          token: "never-retain",
        }),
      ),
    ).not.toHaveProperty("token");
  });
  it("does not index private information in organization search", () => {
    const entries = JSON.stringify(
      organizationSearchEntries({
        ...defaultOrganizationProfile,
        publicEmail: "public@example.com",
        privateEmail: "internal@example.com",
        billingEmail: "billing@example.com",
        legalName: "private-legal",
        addressLine1: "private-address",
        addressLine2: "private-unit",
        city: "private-city",
        region: "private-region",
        postalCode: "private-postal",
        country: "private-country",
      }),
    );
    expect(entries).toContain("public@example.com");
    for (const value of [
      "internal@example.com",
      "billing@example.com",
      "private-legal",
      "private-address",
      "private-unit",
      "private-city",
      "private-region",
      "private-postal",
      "private-country",
    ])
      expect(entries).not.toContain(value);
  });
  it("preserves existing free-form billing addresses without guessing components", () => {
    const {
      addressLine1,
      addressLine2,
      city,
      region,
      postalCode,
      country,
      ...old
    } = defaultOrganizationProfile;
    void [addressLine1, addressLine2, city, region, postalCode, country];
    const migrated = parseProfile(
      JSON.stringify({ ...old, address: "10 Main Street\nExample City" }),
    );
    expect(migrated.addressLine1).toBe("10 Main Street\nExample City");
    expect(migrated.city).toBe("");
    expect(migrated).not.toHaveProperty("address");
  });
  it("round trips structured international address fields", () => {
    const profile = {
      ...defaultOrganizationProfile,
      addressLine1: "10 Main Street",
      addressLine2: "Suite 4",
      city: "London",
      region: "",
      postalCode: "SW1A 1AA",
      country: "United Kingdom",
    };
    expect(parseProfile(JSON.stringify(profile))).toEqual(profile);
    expect(validateProfile(profile)).toEqual({});
    expect(
      validateProfile({ ...profile, postalCode: "x".repeat(201) }),
    ).toHaveProperty("postalCode");
  });
  it("only links to implemented sidebar destinations", () => {
    const links = dashboardNavigation
      .flatMap((group) =>
        group.items.flatMap((item) =>
          item.sections.map((section) => navigationHref(section.id)),
        ),
      )
      .filter(Boolean);
    expect(links).toEqual([
      "/dashboard/organization/integrations/connections",
      "/dashboard/organization/settings/profile",
      "/dashboard/organization/settings/usage",
    ]);
  });
});
