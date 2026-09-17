export type AlertSeverity = "critical" | "high" | "medium" | "low";

export type SecurityAlert = {
  id: string;
  title: string;
  severity: AlertSeverity;
  server: string;
  address: string;
  source: string;
  detectedAt: string;
  lastSeen: string;
  evidence: string;
  impact: string;
  recommendation: string;
};

export const initiallyAcknowledgedAlertIds = ["SEC-2017"] as const;

export const securityAlerts: SecurityAlert[] = [
  {
    id: "SEC-2041",
    title: "RCON endpoint accepts public connections",
    severity: "critical",
    server: "Rusthaven Main",
    address: "203.0.113.18:28016",
    source: "Connection policy",
    detectedAt: "Sep 15, 10:42 PM",
    lastSeen: "2 minutes ago",
    evidence:
      "The RCON port accepted a connection from outside the organization allowlist during the latest check.",
    impact:
      "Anyone who obtains the RCON password can attempt to control the live server from the public internet.",
    recommendation:
      "Restrict port 28016 to the management network, then rotate the RCON password and test the connection again.",
  },
  {
    id: "SEC-2038",
    title: "Console password has not been rotated",
    severity: "high",
    server: "Dustbowl EU",
    address: "198.51.100.42:28016",
    source: "Credential policy",
    detectedAt: "Sep 15, 8:14 PM",
    lastSeen: "18 minutes ago",
    evidence:
      "The stored RCON credential is 186 days old. The organization policy requires rotation every 90 days.",
    impact:
      "A password exposed in an old staff device, backup, or message remains valid against this server.",
    recommendation:
      "Create a new unique RCON password, update the server and Cupboard connection, then revoke the old credential.",
  },
  {
    id: "SEC-2032",
    title: "Plugin signature checks are disabled",
    severity: "high",
    server: "Rusthaven Main",
    address: "203.0.113.18:28016",
    source: "Carbon configuration",
    detectedAt: "Sep 15, 5:31 PM",
    lastSeen: "24 minutes ago",
    evidence:
      "Carbon is configured to load plugin packages without verifying their published signatures.",
    impact:
      "A modified package can run with the same server access as a trusted plugin without a clear warning.",
    recommendation:
      "Enable signature verification, review unsigned plugins, and restart only after the affected packages are accounted for.",
  },
  {
    id: "SEC-2017",
    title: "Webhook secret is stored in a host file",
    severity: "medium",
    server: "Helix Training",
    address: "192.0.2.67:28016",
    source: "File inspection",
    detectedAt: "Sep 14, 3:08 PM",
    lastSeen: "1 day ago",
    evidence:
      "A Discord webhook URL appears in a readable plugin configuration file under the server directory.",
    impact:
      "Anyone with access to the server files can use the webhook to post messages to its Discord channel.",
    recommendation:
      "Move the webhook to managed secret storage, rotate it in Discord, and remove the value from retained backups where practical.",
  },
  {
    id: "SEC-1984",
    title: "Panel gateway uses an outdated certificate chain",
    severity: "low",
    server: "Northstar PvE",
    address: "192.0.2.114:443",
    source: "TLS check",
    detectedAt: "Sep 12, 9:20 AM",
    lastSeen: "3 hours ago",
    evidence:
      "The gateway still serves an older intermediate certificate that some supported clients no longer trust.",
    impact:
      "A small number of operator devices may reject the panel connection or show a certificate warning.",
    recommendation:
      "Install the current intermediate certificate from the issuer and confirm the full chain from an external client.",
  },
];
