"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api-client";
import {
  parseOrganizationTeam,
  type OrganizationTeamSettings,
} from "@/lib/organization-team";
export type TeamResponse = OrganizationTeamSettings & {
  revision: number;
  currentUserId: string;
};
export function useOrganizationTeam() {
  const [team, setTeam] = useState<TeamResponse | null>(null);
  const [ready, setReady] = useState(false);
  const [storageError, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [invitationLink, setInvitationLink] = useState("");
  const reload = useCallback(async () => {
    try {
      const value = await apiRequest<TeamResponse>("team");
      parseOrganizationTeam(JSON.stringify(value));
      setTeam(value);
      setError("");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not load team settings.",
      );
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => {
    // The loader updates state only after its fetch settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    const refresh = () => {
      if (!savingRef.current) void reload();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [reload]);
  async function save(settings: OrganizationTeamSettings) {
    if (!team || savingRef.current) return false;
    const changes: unknown[] = [];
    for (const collection of ["roles", "users"] as const) {
      const previous = team[collection];
      const next = settings[collection];
      for (const item of next) {
        const old = previous.find((entry) => entry.id === item.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(item))
          changes.push(
            collection === "roles"
              ? { kind: old ? "updateRole" : "createRole", role: item }
              : { kind: old ? "updateUser" : "invite", user: item },
          );
      }
      for (const item of previous)
        if (!next.some((entry) => entry.id === item.id))
          changes.push({
            kind: collection === "roles" ? "deleteRole" : "removeUser",
            id: item.id,
          });
    }
    if (!changes.length) return true;
    if (changes.length !== 1) {
      setError("Change one user or role at a time.");
      return false;
    }
    return mutate(changes[0]);
  }
  async function mutate(change: unknown) {
    if (!team || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const response = await apiRequest<{
        team: TeamResponse;
        invitationToken: string | null;
      }>("team", { revision: team.revision, change });
      setTeam(response.team);
      if (response.invitationToken)
        setInvitationLink(
          `${window.location.origin}/join#${response.invitationToken}`,
        );
      return true;
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not save team settings.",
      );
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return {
    ready,
    settings: team ?? { roles: [], users: [] },
    currentOperatorId: team?.currentUserId ?? "",
    storageError,
    clearStorageError: () => setError(""),
    save,
    saving,
    reorderRoles: (ids: string[]) => mutate({ kind: "reorderRoles", ids }),
    canManage: team !== null,
    reload,
    invitationLink,
    clearInvitation: () => setInvitationLink(""),
  };
}
