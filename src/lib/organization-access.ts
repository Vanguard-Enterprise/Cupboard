export const organizationAccessKey =
  "cupboard:organization:local-preview:access:v1";
export const organizationAccessChangedEvent = "cupboard-access-saved";

export type ApprovalRule = {
  id: "server-lifecycle" | "credentials" | "billing";
  title: string;
  description: string;
  approvals: 0 | 1 | 2;
};

export type OrganizationAccessSettings = {
  rules: ApprovalRule[];
};

export const defaultOrganizationAccess: OrganizationAccessSettings = {
  rules: [
    {
      id: "server-lifecycle",
      title: "Server lifecycle",
      description: "Restart, stop, update, or wipe a live server.",
      approvals: 1,
    },
    {
      id: "credentials",
      title: "Credentials",
      description: "Reveal, replace, or remove stored secrets or webhooks.",
      approvals: 2,
    },
    {
      id: "billing",
      title: "Billing",
      description: "Change plan, payment method, or billing contact.",
      approvals: 0,
    },
  ],
};

export function parseOrganizationAccess(
  raw: string,
): OrganizationAccessSettings {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid settings");
  const settings = value as Record<string, unknown>;
  if (!Array.isArray(settings.rules)) throw new Error("Invalid settings");

  const defaultRules = new Map(
    defaultOrganizationAccess.rules.map((rule) => [rule.id, rule]),
  );
  const rules = settings.rules.map((rule): ApprovalRule => {
    if (!rule || typeof rule !== "object") throw new Error("Invalid rule");
    const candidate = rule as Record<string, unknown>;
    const source = defaultRules.get(candidate.id as ApprovalRule["id"]);
    if (!source || ![0, 1, 2].includes(candidate.approvals as number))
      throw new Error("Invalid rule");
    return {
      ...source,
      approvals: candidate.approvals as 0 | 1 | 2,
    };
  });
  if (
    rules.length !== defaultRules.size ||
    new Set(rules.map((rule) => rule.id)).size !== defaultRules.size
  )
    throw new Error("Invalid rules");
  return { rules };
}
