export const organizationPreviewStorage = {
  profile: {
    key: "cupboard:organization:local-preview:profile:v1",
    changedEvent: "cupboard-profile-saved",
  },
  notifications: {
    key: "cupboard:organization:local-preview:notifications:v1",
    changedEvent: "cupboard-notifications-saved",
  },
  integrations: {
    key: "cupboard:organization:local-preview:integrations:v1",
    changedEvent: "cupboard-integrations-saved",
  },
  access: {
    key: "cupboard:organization:local-preview:access:v1",
    changedEvent: "cupboard-access-saved",
  },
  securityAlerts: {
    key: "cupboard:organization:local-preview:security-alerts:v1",
    changedEvent: "cupboard-security-alerts-saved",
  },
} as const;
