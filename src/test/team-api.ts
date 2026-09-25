import { vi } from "vitest";
import { defaultOrganizationTeam } from "./organization-team-fixture";
import type { TeamResponse } from "@/hooks/use-organization-team";
export function setupTeamApi() {
  const state = {
    team: {
      ...structuredClone(defaultOrganizationTeam),
      revision: 1,
      currentUserId: "user-demo-operator",
    } as TeamResponse,
    error: "",
    status: 200,
  };
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === "POST") {
      if (state.error)
        return Response.json({ error: state.error }, { status: state.status });
      const { change } = JSON.parse(String(options.body));
      if (change.kind === "invite")
        state.team.users.push({ ...change.user, id: "server-created-user" });
      if (change.kind === "updateUser")
        state.team.users = state.team.users.map((user) =>
          user.id === change.user.id ? change.user : user,
        );
      if (change.kind === "removeUser")
        state.team.users = state.team.users.filter(
          (user) => user.id !== change.id,
        );
      if (change.kind === "createRole")
        state.team.roles.push({ ...change.role, id: "server-created-role" });
      if (change.kind === "updateRole")
        state.team.roles = state.team.roles.map((role) =>
          role.id === change.role.id ? change.role : role,
        );
      if (change.kind === "reorderRoles")
        state.team.roles = change.ids.map((id: string, position: number) => ({
          ...state.team.roles.find((role) => role.id === id)!,
          position,
        }));
      if (change.kind === "deleteRole")
        state.team.roles = state.team.roles.filter(
          (role) => role.id !== change.id,
        );
      state.team.revision++;
      return Response.json({
        team: state.team,
        invitationToken: change.kind === "invite" ? "a".repeat(64) : null,
      });
    }
    return Response.json(state.team);
  });
  vi.stubGlobal("fetch", fetcher);
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return { state, fetcher };
}
