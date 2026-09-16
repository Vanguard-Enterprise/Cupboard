export const organizationIntegrationsKey =
  "cupboard:organization:local-preview:integrations:v1";

export const webhookEvents = [
  { id: "server.status_changed", label: "Server status changed" },
  { id: "player.reported", label: "Player reported" },
  { id: "moderation.action_created", label: "Moderation action created" },
  { id: "server.wipe_started", label: "Server wipe started" },
] as const;

export type WebhookEvent = (typeof webhookEvents)[number]["id"];

export type ApiCredential = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsed: string | null;
};

export type WebhookEndpoint = {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: string;
  lastDelivery: {
    status: number;
    deliveredAt: string;
  } | null;
};

export type OrganizationIntegrations = {
  credentials: ApiCredential[];
  webhooks: WebhookEndpoint[];
};

export const defaultOrganizationIntegrations: OrganizationIntegrations = {
  credentials: [
    {
      id: "sample-credential-1",
      name: "Server operations",
      prefix: "cb_live_7F2A...91C4",
      createdAt: "Sep 4, 2026",
      lastUsed: "2 minutes ago",
    },
    {
      id: "sample-credential-2",
      name: "Status dashboard",
      prefix: "cb_live_C81D...30E7",
      createdAt: "Aug 19, 2026",
      lastUsed: "Yesterday",
    },
  ],
  webhooks: [
    {
      id: "sample-webhook-1",
      name: "Operations relay",
      url: "https://ops.example.com/hooks/cupboard",
      events: ["server.status_changed", "server.wipe_started"],
      enabled: true,
      createdAt: "Aug 28, 2026",
      lastDelivery: { status: 204, deliveredAt: "4 minutes ago" },
    },
  ],
};

export function readOrganizationIntegrations(
  raw: string | null,
): OrganizationIntegrations {
  if (!raw) return structuredClone(defaultOrganizationIntegrations);
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return structuredClone(defaultOrganizationIntegrations);
    }
    const candidate = value as Record<string, unknown>;
    if (
      !Array.isArray(candidate.credentials) ||
      !candidate.credentials.every(isApiCredential) ||
      !Array.isArray(candidate.webhooks) ||
      !candidate.webhooks.every(isWebhookEndpoint)
    ) {
      return structuredClone(defaultOrganizationIntegrations);
    }
    return {
      credentials: candidate.credentials.map((credential) => ({
        id: credential.id,
        name: credential.name,
        prefix: credential.prefix,
        createdAt: credential.createdAt,
        lastUsed: credential.lastUsed,
      })),
      webhooks: candidate.webhooks.map((webhook) => ({
        id: webhook.id,
        name: webhook.name,
        url: webhook.url,
        events: [...webhook.events],
        enabled: webhook.enabled,
        createdAt: webhook.createdAt,
        lastDelivery: webhook.lastDelivery ? { ...webhook.lastDelivery } : null,
      })),
    };
  } catch {
    return structuredClone(defaultOrganizationIntegrations);
  }
}

function isApiCredential(value: unknown): value is ApiCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Record<string, unknown>;
  return (
    typeof credential.id === "string" &&
    typeof credential.name === "string" &&
    typeof credential.prefix === "string" &&
    typeof credential.createdAt === "string" &&
    (credential.lastUsed === null || typeof credential.lastUsed === "string")
  );
}

const eventIds = new Set<string>(webhookEvents.map((event) => event.id));

function isWebhookEndpoint(value: unknown): value is WebhookEndpoint {
  if (!value || typeof value !== "object") return false;
  const webhook = value as Record<string, unknown>;
  const delivery = webhook.lastDelivery;
  const validDelivery =
    delivery === null ||
    (Boolean(delivery) &&
      typeof delivery === "object" &&
      typeof (delivery as Record<string, unknown>).status === "number" &&
      typeof (delivery as Record<string, unknown>).deliveredAt === "string");
  return (
    typeof webhook.id === "string" &&
    typeof webhook.name === "string" &&
    typeof webhook.url === "string" &&
    Array.isArray(webhook.events) &&
    webhook.events.every(
      (event): event is WebhookEvent =>
        typeof event === "string" && eventIds.has(event),
    ) &&
    typeof webhook.enabled === "boolean" &&
    typeof webhook.createdAt === "string" &&
    validDelivery
  );
}

export function validateWebhookUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a complete URL, including https://.";
  }

  const localHost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) {
    return "Use HTTPS. HTTP is allowed only for localhost.";
  }
  return null;
}

export function createCredentialSecret(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `cb_live_${value}`;
}
