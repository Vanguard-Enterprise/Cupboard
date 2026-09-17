type ImplementedPage =
  | {
      kind: "dashboard";
      href: string;
      searchLabel: string;
      searchValue: string;
    }
  | {
      kind: "organization";
      href: string;
      navigationLabel: string;
      breadcrumbs: readonly string[];
      searchLabel: string;
      searchValue: string;
      metadataTitle: string;
    };

export const implementedPages = {
  dashboard: {
    kind: "dashboard",
    href: "/dashboard",
    searchLabel: "Dashboard",
    searchValue: "Dashboard overview",
  },
  organization: {
    kind: "organization",
    href: "/dashboard/organization/settings/profile",
    navigationLabel: "Organization profile",
    breadcrumbs: ["Organization", "Settings", "Profile"],
    searchLabel: "Organization settings",
    searchValue: "Organization settings profile contacts",
    metadataTitle: "Organization profile | Cupboard",
  },
  billing: {
    kind: "organization",
    href: "/dashboard/organization/settings/usage",
    navigationLabel: "Billing & usage",
    breadcrumbs: ["Organization", "Settings", "Usage"],
    searchLabel: "Organization usage",
    searchValue: "Organization usage activity capacity billing",
    metadataTitle: "Organization usage | Cupboard",
  },
  credentials: {
    kind: "organization",
    href: "/dashboard/organization/integrations/credentials",
    navigationLabel: "Credentials & webhooks",
    breadcrumbs: ["Organization", "Integrations", "Credentials & webhooks"],
    searchLabel: "Credentials & webhooks",
    searchValue: "Organization integrations API credentials webhooks",
    metadataTitle: "Credentials and webhooks | Cupboard",
  },
  "security-alerts": {
    kind: "organization",
    href: "/dashboard/organization/security/alerts",
    navigationLabel: "Security alerts",
    breadcrumbs: ["Organization", "Security", "Alerts"],
    searchLabel: "Security alerts",
    searchValue: "Security alerts findings risk incidents servers",
    metadataTitle: "Security alerts | Cupboard",
  },
  "audit-log": {
    kind: "organization",
    href: "/dashboard/organization/security/audit-log",
    navigationLabel: "Audit log",
    breadcrumbs: ["Organization", "Security", "Audit log"],
    searchLabel: "Audit log",
    searchValue: "Organization security audit log events history access",
    metadataTitle: "Audit log | Cupboard",
  },
  access: {
    kind: "organization",
    href: "/dashboard/organization/security/access",
    navigationLabel: "Access & approvals",
    breadcrumbs: ["Organization", "Security", "Access & approvals"],
    searchLabel: "Access & approvals",
    searchValue:
      "Organization security access approvals members roles invitations",
    metadataTitle: "Access and approvals | Cupboard",
  },
  connections: {
    kind: "organization",
    href: "/dashboard/organization/integrations/connections",
    navigationLabel: "Connections",
    breadcrumbs: ["Organization", "Integrations", "Connections"],
    searchLabel: "Connections",
    searchValue: "Organization integrations connections external services",
    metadataTitle: "Connections | Cupboard",
  },
  preferences: {
    kind: "organization",
    href: "/dashboard/organization/settings/notifications-data",
    navigationLabel: "Notifications & data",
    breadcrumbs: ["Organization", "Settings", "Notifications & data"],
    searchLabel: "Notifications & data",
    searchValue: "Organization notifications data preferences browser storage",
    metadataTitle: "Notifications and data | Cupboard",
  },
} as const satisfies Readonly<Record<string, ImplementedPage>>;

export type ImplementedPageId = keyof typeof implementedPages;
export type OrganizationPageId = Exclude<ImplementedPageId, "dashboard">;
type ImplementedPageEntry = {
  [K in ImplementedPageId]: [K, (typeof implementedPages)[K]];
}[ImplementedPageId];
export type OrganizationPageEntry = Extract<
  ImplementedPageEntry,
  [OrganizationPageId, unknown]
>;
export const implementedPageEntries = Object.entries(
  implementedPages,
) as ImplementedPageEntry[];
export const implementedPageSearchOrder = [
  "dashboard",
  "organization",
  "billing",
  "credentials",
  "security-alerts",
  "audit-log",
  "access",
  "connections",
  "preferences",
] as const satisfies readonly ImplementedPageId[];
