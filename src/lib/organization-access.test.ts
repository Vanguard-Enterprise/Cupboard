import { describe, expect, it } from "vitest";
import {
  defaultOrganizationAccess,
  parseOrganizationAccess,
} from "./organization-access";

describe("organization approval settings", () => {
  it("round trips approval rules", () => {
    expect(
      parseOrganizationAccess(JSON.stringify(defaultOrganizationAccess)),
    ).toEqual(defaultOrganizationAccess);
  });

  it("rejects malformed approval thresholds", () => {
    const invalidApprovals = structuredClone(defaultOrganizationAccess);
    Object.assign(invalidApprovals.rules[0], { approvals: 3 });
    expect(() =>
      parseOrganizationAccess(JSON.stringify(invalidApprovals)),
    ).toThrow();
  });

  it("requires one copy of every approval rule", () => {
    const duplicateRule = structuredClone(defaultOrganizationAccess);
    duplicateRule.rules[2] = duplicateRule.rules[0];
    expect(() =>
      parseOrganizationAccess(JSON.stringify(duplicateRule)),
    ).toThrow();
  });

  it("drops unknown fields instead of retaining them", () => {
    const stored = {
      ...defaultOrganizationAccess,
      apiKey: "never-retain",
      rules: defaultOrganizationAccess.rules.map((rule) => ({
        ...rule,
        secret: "never-retain",
      })),
    };
    const parsed = parseOrganizationAccess(JSON.stringify(stored));
    expect(parsed).not.toHaveProperty("apiKey");
    expect(parsed.rules[0]).not.toHaveProperty("secret");
  });
});
