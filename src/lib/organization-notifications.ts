export const defaultOrganizationNotifications = {
  serverIncidents: false,
  securityAlerts: false,
  moderationActivity: false,
  weeklySummary: false,
};

export type OrganizationNotifications = typeof defaultOrganizationNotifications;

export function parseOrganizationNotifications(
  raw: string,
): OrganizationNotifications {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") {
    throw new Error("Invalid notification preferences");
  }

  const stored = value as Record<string, unknown>;
  const preferences = { ...defaultOrganizationNotifications };
  for (const key of Object.keys(
    preferences,
  ) as (keyof OrganizationNotifications)[]) {
    if (typeof stored[key] !== "boolean") {
      throw new Error("Invalid notification preferences");
    }
    preferences[key] = stored[key];
  }
  return preferences;
}
