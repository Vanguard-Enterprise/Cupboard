import { describe, expect, it } from "vitest";
import {
  accessPath,
  alertsPath,
  auditLogPath,
  connectionsPath,
  credentialsPath,
  discordPath,
  navigationHref,
  profilePath,
  rolesPath,
  usagePath,
  usersPath,
  maintenancePath,
} from "./dashboard-navigation";

describe("dashboard navigation", () => {
  it("links implemented organization pages and leaves planned pages disabled", () => {
    expect(navigationHref("connections")).toBe(connectionsPath);
    expect(navigationHref("organization")).toBe(profilePath);
    expect(navigationHref("billing")).toBe(usagePath);
    expect(navigationHref("credentials")).toBe(credentialsPath);
    expect(navigationHref("access")).toBe(accessPath);
    expect(navigationHref("audit-log")).toBe(auditLogPath);
    expect(navigationHref("team-users")).toBe(usersPath);
    expect(navigationHref("team-roles")).toBe(rolesPath);
    expect(navigationHref("maintenance")).toBe(maintenancePath);
    expect(navigationHref("alerts-data")).toBe(alertsPath);
    expect(navigationHref("discord")).toBe(discordPath);
    // Observability's planned alerts page is separate from alert settings.
    expect(navigationHref("alerts")).toBeUndefined();
  });
});
