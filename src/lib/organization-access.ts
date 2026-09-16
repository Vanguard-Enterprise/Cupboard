export const organizationAccessKey =
  "cupboard:organization:local-preview:access:v1";
export const organizationAccessChangedEvent = "cupboard-access-saved";

export const roles = ["owner", "administrator", "operator", "viewer"] as const;
export type OrganizationRole = (typeof roles)[number];

export const roleLabels: Record<OrganizationRole, string> = {
  owner: "Owner",
  administrator: "Administrator",
  operator: "Operator",
  viewer: "Viewer",
};

export type OrganizationMember = {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: OrganizationRole;
  status: "active" | "invited";
};

export type ApprovalRule = {
  id: "server-lifecycle" | "member-access" | "credentials" | "billing";
  title: string;
  description: string;
  enabled: boolean;
  approvals: 1 | 2;
};

export type OrganizationAccessSettings = {
  members: OrganizationMember[];
  rules: ApprovalRule[];
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isOrganizationMember(
  candidate: Record<string, unknown>,
): candidate is Record<keyof OrganizationMember, string> & {
  role: OrganizationRole;
  status: OrganizationMember["status"];
} {
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.email === "string" &&
    typeof candidate.initials === "string" &&
    Boolean(candidate.id) &&
    Boolean(candidate.name) &&
    emailPattern.test(candidate.email) &&
    Boolean(candidate.initials) &&
    candidate.id.length <= 200 &&
    candidate.name.length <= 200 &&
    candidate.email.length <= 320 &&
    candidate.initials.length <= 4 &&
    roles.includes(candidate.role as OrganizationRole) &&
    ["active", "invited"].includes(candidate.status as string)
  );
}

export function createInvitationMember(
  emailInput: string,
  role: Exclude<OrganizationRole, "owner">,
  id: string,
): OrganizationMember | null {
  const email = emailInput.trim().toLowerCase();
  const name = email
    .split("@")[0]
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
  const initials =
    email
      .split("@")[0]
      .split(/[._-]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "IN";
  const candidate = {
    id,
    name,
    email,
    initials,
    role,
    status: "invited" as const,
  };
  return isOrganizationMember(candidate) ? candidate : null;
}

export const defaultOrganizationAccess: OrganizationAccessSettings = {
  members: [
    {
      id: "demo-operator",
      name: "Demo operator",
      email: "operator@example.com",
      initials: "DO",
      role: "owner",
      status: "active",
    },
    {
      id: "maya-chen",
      name: "Maya Chen",
      email: "maya@example.com",
      initials: "MC",
      role: "administrator",
      status: "active",
    },
    {
      id: "jordan-lee",
      name: "Jordan Lee",
      email: "jordan@example.com",
      initials: "JL",
      role: "operator",
      status: "active",
    },
    {
      id: "sam-rivera",
      name: "Sam Rivera",
      email: "sam@example.com",
      initials: "SR",
      role: "viewer",
      status: "invited",
    },
  ],
  rules: [
    {
      id: "server-lifecycle",
      title: "Server lifecycle",
      description: "Restart, stop, update, or wipe a live server.",
      enabled: true,
      approvals: 1,
    },
    {
      id: "member-access",
      title: "Member access",
      description: "Change roles, remove members, or revoke invitations.",
      enabled: true,
      approvals: 2,
    },
    {
      id: "credentials",
      title: "Credentials",
      description: "Reveal, replace, or remove stored secrets or webhooks.",
      enabled: true,
      approvals: 2,
    },
    {
      id: "billing",
      title: "Billing",
      description: "Change plan, payment method, or billing contact.",
      enabled: false,
      approvals: 1,
    },
  ],
};

export function parseOrganizationAccess(
  raw: string,
): OrganizationAccessSettings {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid settings");
  const settings = value as Record<string, unknown>;
  if (!Array.isArray(settings.members) || !Array.isArray(settings.rules))
    throw new Error("Invalid settings");

  const members = settings.members.map((member): OrganizationMember => {
    if (!member || typeof member !== "object")
      throw new Error("Invalid member");
    const candidate = member as Record<string, unknown>;
    if (!isOrganizationMember(candidate)) throw new Error("Invalid member");
    return {
      id: candidate.id,
      name: candidate.name,
      email: candidate.email,
      initials: candidate.initials,
      role: candidate.role as OrganizationRole,
      status: candidate.status as OrganizationMember["status"],
    };
  });
  if (
    new Set(members.map((member) => member.id)).size !== members.length ||
    new Set(members.map((member) => member.email.toLowerCase())).size !==
      members.length ||
    !members.some(
      (member) => member.role === "owner" && member.status === "active",
    )
  )
    throw new Error("Invalid members");

  const defaultRules = new Map(
    defaultOrganizationAccess.rules.map((rule) => [rule.id, rule]),
  );
  const rules = settings.rules.map((rule): ApprovalRule => {
    if (!rule || typeof rule !== "object") throw new Error("Invalid rule");
    const candidate = rule as Record<string, unknown>;
    const source = defaultRules.get(candidate.id as ApprovalRule["id"]);
    if (
      !source ||
      typeof candidate.enabled !== "boolean" ||
      ![1, 2].includes(candidate.approvals as number)
    )
      throw new Error("Invalid rule");
    return {
      ...source,
      enabled: candidate.enabled,
      approvals: candidate.approvals as 1 | 2,
    };
  });
  if (
    rules.length !== defaultRules.size ||
    new Set(rules.map((rule) => rule.id)).size !== defaultRules.size
  )
    throw new Error("Invalid rules");
  return { members, rules };
}
