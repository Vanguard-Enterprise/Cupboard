import { describe, expect, it } from "vitest";
import {
  implementedPages,
  implementedPageSearchOrder,
} from "./implemented-pages";
import { dashboardNavigation, navigationHref } from "./dashboard-navigation";

const expected = [
  {
    id: "organization",
    href: "/dashboard/organization/settings/profile",
    navigationLabel: "Organization profile",
    searchLabel: "Organization settings",
    searchValue: "Organization settings profile contacts",
    breadcrumbs: ["Organization", "Settings", "Profile"],
    metadataTitle: "Organization profile | Cupboard",
  },
  {
    id: "billing",
    href: "/dashboard/organization/settings/usage",
    navigationLabel: "Billing & usage",
    searchLabel: "Organization usage",
    searchValue: "Organization usage activity capacity billing",
    breadcrumbs: ["Organization", "Settings", "Usage"],
    metadataTitle: "Organization usage | Cupboard",
  },
  {
    id: "credentials",
    href: "/dashboard/organization/integrations/credentials",
    navigationLabel: "Credentials & webhooks",
    searchLabel: "Credentials & webhooks",
    searchValue: "Organization integrations API credentials webhooks",
    breadcrumbs: ["Organization", "Integrations", "Credentials & webhooks"],
    metadataTitle: "Credentials and webhooks | Cupboard",
  },
  {
    id: "security-alerts",
    href: "/dashboard/organization/security/alerts",
    navigationLabel: "Security alerts",
    searchLabel: "Security alerts",
    searchValue: "Security alerts findings risk incidents servers",
    breadcrumbs: ["Organization", "Security", "Alerts"],
    metadataTitle: "Security alerts | Cupboard",
  },
  {
    id: "audit-log",
    href: "/dashboard/organization/security/audit-log",
    navigationLabel: "Audit log",
    searchLabel: "Audit log",
    searchValue: "Organization security audit log events history access",
    breadcrumbs: ["Organization", "Security", "Audit log"],
    metadataTitle: "Audit log | Cupboard",
  },
  {
    id: "access",
    href: "/dashboard/organization/security/access",
    navigationLabel: "Access & approvals",
    searchLabel: "Access & approvals",
    searchValue:
      "Organization security access approvals members roles invitations",
    breadcrumbs: ["Organization", "Security", "Access & approvals"],
    metadataTitle: "Access and approvals | Cupboard",
  },
  {
    id: "connections",
    href: "/dashboard/organization/integrations/connections",
    navigationLabel: "Connections",
    searchLabel: "Connections",
    searchValue: "Organization integrations connections external services",
    breadcrumbs: ["Organization", "Integrations", "Connections"],
    metadataTitle: "Connections | Cupboard",
  },
  {
    id: "preferences",
    href: "/dashboard/organization/settings/notifications-data",
    navigationLabel: "Notifications & data",
    searchLabel: "Notifications & data",
    searchValue: "Organization notifications data preferences browser storage",
    breadcrumbs: ["Organization", "Settings", "Notifications & data"],
    metadataTitle: "Notifications and data | Cupboard",
  },
] as const;
describe("implemented page contracts", () => {
  it.each(expected)(
    "preserves $id labels, URL and metadata",
    ({ id, ...page }) => {
      expect(implementedPages[id]).toEqual({ kind: "organization", ...page });
      expect(navigationHref(id)).toBe(page.href);
      const section = dashboardNavigation
        .flatMap((group) => group.items)
        .flatMap((item) => item.sections)
        .find((section) => section.id === id);
      expect(section?.title).toBe(page.navigationLabel);
    },
  );
  it("keeps dashboard search-only and preserves search order", () => {
    expect(implementedPages.dashboard).toEqual({
      kind: "dashboard",
      href: "/dashboard",
      searchLabel: "Dashboard",
      searchValue: "Dashboard overview",
    });
    expect(implementedPageSearchOrder).toEqual([
      "dashboard",
      "organization",
      "billing",
      "credentials",
      "security-alerts",
      "audit-log",
      "access",
      "connections",
      "preferences",
    ]);
    for (const id of ["dashboard", "servers", "unknown"])
      expect(navigationHref(id)).toBeUndefined();
  });
});
