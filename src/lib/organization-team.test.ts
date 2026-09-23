import { defaultOrganizationTeam } from "@/test/organization-team-fixture";
import { describe, expect, it } from "vitest";
import { parseOrganizationTeam, roleAuthority } from "./organization-team";

describe("organization team settings", () => {
  it("round trips users, roles, and permissions", () => {
    expect(
      parseOrganizationTeam(JSON.stringify(defaultOrganizationTeam)),
    ).toEqual(defaultOrganizationTeam);
  });

  it("rejects users assigned to missing roles", () => {
    const invalid = structuredClone(defaultOrganizationTeam);
    invalid.users[0].roleIds = ["missing"];
    expect(() => parseOrganizationTeam(JSON.stringify(invalid))).toThrow();
  });

  it("rejects invalid last-active timestamps", () => {
    const invalid = structuredClone(defaultOrganizationTeam);
    invalid.users[0].lastActiveAt = "not-a-date";
    expect(() => parseOrganizationTeam(JSON.stringify(invalid))).toThrow();
  });

  it("rejects duplicate user emails and role names", () => {
    const duplicateEmail = structuredClone(defaultOrganizationTeam);
    duplicateEmail.users[1].email = duplicateEmail.users[0].email;
    expect(() =>
      parseOrganizationTeam(JSON.stringify(duplicateEmail)),
    ).toThrow();

    const duplicateRole = structuredClone(defaultOrganizationTeam);
    duplicateRole.roles[1].name = duplicateRole.roles[0].name.toUpperCase();
    expect(() =>
      parseOrganizationTeam(JSON.stringify(duplicateRole)),
    ).toThrow();
  });

  it("rejects unknown permissions and drops unknown fields", () => {
    const unknownPermission = structuredClone(defaultOrganizationTeam);
    Object.assign(unknownPermission.roles[0], {
      permissions: ["servers.view", "secrets.read"],
    });
    expect(() =>
      parseOrganizationTeam(JSON.stringify(unknownPermission)),
    ).toThrow();

    const stored = {
      ...defaultOrganizationTeam,
      apiKey: "never-retain",
      users: defaultOrganizationTeam.users.map((user) => ({
        ...user,
        token: "never-retain",
      })),
    };
    const parsed = parseOrganizationTeam(JSON.stringify(stored));
    expect(parsed).not.toHaveProperty("apiKey");
    expect(parsed.users[0]).not.toHaveProperty("token");
  });
});

describe("member role authority", () => {
  it("requires every existing role to be grantable using combined permissions", () => {
    const team = structuredClone(defaultOrganizationTeam);
    team.users[0].roleIds = ["operator"];
    team.users[1].roleIds = ["viewer", "billing"];
    team.roles.push({
      id: "billing",
      name: "Billing",
      description: "",
      permissions: ["billing.manage"],
      position: 4,
      system: false,
    });
    const operator = team.roles.find((role) => role.id === "operator")!;
    operator.permissions = ["organization.manage", "servers.view"];
    let authority = roleAuthority(team, team.users[0].id);
    expect(authority.canManageUser(team.users[1])).toBe(false);
    expect(authority.canManageUser(team.users[3])).toBe(true);
    team.users[0].roleIds.push("billing");
    authority = roleAuthority(team, team.users[0].id);
    expect(authority.canManageUser(team.users[1])).toBe(true);
    expect(authority.canManageUser(team.users[0])).toBe(false);
    expect(authority.canManageUser(team.users[2])).toBe(false);
    team.users[0].roleIds = ["owner"];
    expect(
      roleAuthority(team, team.users[0].id).canManageUser(team.users[1]),
    ).toBe(true);
  });
});
