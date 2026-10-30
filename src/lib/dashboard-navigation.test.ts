import { describe, expect, it } from "vitest";
import {
  accessPath,
  alertsPath,
  auditLogPath,
  connectionsPath,
  credentialsPath,
  navigationHref,
  profilePath,
  rolesPath,
  usagePath,
  usersPath,
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
    expect(navigationHref("alerts-data")).toBe(alertsPath);
    // Observability's planned alerts page is separate from alert settings.
    expect(navigationHref("alerts")).toBeUndefined();
  });
});
