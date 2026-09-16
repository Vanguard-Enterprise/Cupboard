import { describe, expect, it } from "vitest";
import {
  createInvitationMember,
  defaultOrganizationAccess,
  parseOrganizationAccess,
} from "./organization-access";

describe("organization access settings", () => {
  it("round trips member access and approval rules", () => {
    expect(
      parseOrganizationAccess(JSON.stringify(defaultOrganizationAccess)),
    ).toEqual(defaultOrganizationAccess);
  });

  it("rejects malformed roles and approval thresholds", () => {
    const invalidRole = structuredClone(defaultOrganizationAccess);
    Object.assign(invalidRole.members[1], { role: "super-admin" });
    expect(() =>
      parseOrganizationAccess(JSON.stringify(invalidRole)),
    ).toThrow();

    const invalidApprovals = structuredClone(defaultOrganizationAccess);
    Object.assign(invalidApprovals.rules[0], { approvals: 3 });
    expect(() =>
      parseOrganizationAccess(JSON.stringify(invalidApprovals)),
    ).toThrow();
  });

  it("requires one active owner and one copy of every approval rule", () => {
    const noOwner = structuredClone(defaultOrganizationAccess);
    noOwner.members[0].role = "administrator";
    expect(() => parseOrganizationAccess(JSON.stringify(noOwner))).toThrow();

    const duplicateRule = structuredClone(defaultOrganizationAccess);
    duplicateRule.rules[3] = duplicateRule.rules[0];
    expect(() =>
      parseOrganizationAccess(JSON.stringify(duplicateRule)),
    ).toThrow();
  });

  it("drops unknown fields instead of retaining them", () => {
    const stored = {
      ...defaultOrganizationAccess,
      apiKey: "never-retain",
      members: defaultOrganizationAccess.members.map((member) => ({
        ...member,
        sessionToken: "never-retain",
      })),
      rules: defaultOrganizationAccess.rules.map((rule) => ({
        ...rule,
        secret: "never-retain",
      })),
    };
    const parsed = parseOrganizationAccess(JSON.stringify(stored));
    expect(parsed).not.toHaveProperty("apiKey");
    expect(parsed.members[0]).not.toHaveProperty("sessionToken");
    expect(parsed.rules[0]).not.toHaveProperty("secret");
  });

  it("only creates invitations that the persistence parser accepts", () => {
    const invitation = createInvitationMember(
      "new.operator@example.com",
      "viewer",
      "invited-1",
    );
    expect(invitation).not.toBeNull();
    expect(
      parseOrganizationAccess(
        JSON.stringify({
          ...defaultOrganizationAccess,
          members: [...defaultOrganizationAccess.members, invitation],
        }),
      ).members.at(-1),
    ).toEqual(invitation);
    expect(
      createInvitationMember(
        `${"a".repeat(201)}@example.com`,
        "viewer",
        "invited-2",
      ),
    ).toBeNull();
    expect(
      createInvitationMember(
        `${"a".repeat(310)}@example.com`,
        "viewer",
        "invited-3",
      ),
    ).toBeNull();
  });
});
