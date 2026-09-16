import { describe, expect, it } from "vitest";
import {
  createCredentialSecret,
  parseOrganizationIntegrations,
  readOrganizationIntegrations,
  validateWebhookUrl,
} from "./organization-integrations";

describe("organization integrations data", () => {
  it("accepts secure endpoints and local HTTP development endpoints", () => {
    expect(validateWebhookUrl("https://hooks.example.com/events")).toBeNull();
    expect(validateWebhookUrl("http://localhost:4000/events")).toBeNull();
    expect(validateWebhookUrl("http://example.com/events")).toBe(
      "Use HTTPS. HTTP is allowed only for localhost.",
    );
    expect(validateWebhookUrl("not-a-url")).toBe(
      "Enter a complete URL, including https://.",
    );
  });

  it("generates distinct credential secrets", () => {
    const first = createCredentialSecret();
    const second = createCredentialSecret();
    expect(first).toMatch(/^cb_live_[A-F0-9]{36}$/);
    expect(second).not.toBe(first);
  });

  it("falls back to safe sample data for malformed storage", () => {
    expect(readOrganizationIntegrations("not-json").credentials.length).toBe(2);
    expect(
      readOrganizationIntegrations('{"credentials":"bad"}').webhooks.length,
    ).toBe(1);
  });

  it("rejects malformed storage when a write needs verified data", () => {
    expect(() => parseOrganizationIntegrations("not-json")).toThrow(
      "Invalid integration data",
    );
    expect(() =>
      parseOrganizationIntegrations('{"credentials":"bad"}'),
    ).toThrow("Invalid integration data");
  });

  it("drops unknown stored fields so secrets cannot survive a rewrite", () => {
    const parsed = parseOrganizationIntegrations(
      JSON.stringify({
        credentials: [
          {
            id: "credential-1",
            name: "Deploy agent",
            prefix: "cb_live_ABCD...1234",
            createdAt: "Sep 15, 2026",
            lastUsed: null,
            secret: "must-not-survive",
          },
        ],
        webhooks: [],
      }),
    );
    expect(JSON.stringify(parsed)).not.toContain("must-not-survive");
  });
});
