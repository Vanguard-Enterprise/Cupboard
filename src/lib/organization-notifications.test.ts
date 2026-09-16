import { describe, expect, it } from "vitest";
import {
  defaultOrganizationNotifications,
  parseOrganizationNotifications,
} from "./organization-notifications";

describe("organization notification preferences", () => {
  it("defaults unavailable notification delivery to off", () => {
    expect(defaultOrganizationNotifications).toEqual({
      serverIncidents: false,
      securityAlerts: false,
      moderationActivity: false,
      weeklySummary: false,
    });
  });

  it("parses a complete boolean preference record", () => {
    expect(
      parseOrganizationNotifications(
        JSON.stringify({
          ...defaultOrganizationNotifications,
          moderationActivity: true,
        }),
      ),
    ).toEqual({
      ...defaultOrganizationNotifications,
      moderationActivity: true,
    });
  });

  it.each([
    "null",
    "[]",
    JSON.stringify({ ...defaultOrganizationNotifications, weeklySummary: 1 }),
    JSON.stringify({ serverIncidents: true }),
  ])("rejects malformed saved data", (raw) => {
    expect(() => parseOrganizationNotifications(raw)).toThrow(
      "Invalid notification preferences",
    );
  });
});
