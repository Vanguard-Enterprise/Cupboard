"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  KeyRoundIcon,
  PlusIcon,
  RotateCcwIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  UserRoundCogIcon,
  UsersIcon,
  WalletCardsIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  defaultOrganizationAccess,
  createInvitationMember,
  organizationAccessChangedEvent,
  organizationAccessKey,
  parseOrganizationAccess,
  roleLabels,
  roles,
  type ApprovalRule,
  type OrganizationAccessSettings,
  type OrganizationRole,
} from "@/lib/organization-access";

const ruleIcons: Record<ApprovalRule["id"], typeof ServerCogIcon> = {
  "server-lifecycle": ServerCogIcon,
  "member-access": UserRoundCogIcon,
  credentials: KeyRoundIcon,
  billing: WalletCardsIcon,
};

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === organizationAccessKey) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(organizationAccessChangedEvent, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(organizationAccessChangedEvent, callback);
  };
}

function snapshot() {
  try {
    return window.localStorage.getItem(organizationAccessKey) ?? "";
  } catch {
    return "storage-unavailable";
  }
}

const serverSnapshot = () => null;

function AccessEditor({
  saved,
  sourceVersion,
  initialStorageError,
  needsReplacement,
}: {
  saved: OrganizationAccessSettings;
  sourceVersion: string;
  initialStorageError: string;
  needsReplacement: boolean;
}) {
  const [draft, setDraft] = useState<OrganizationAccessSettings>(saved);
  const [baseline, setBaseline] = useState(saved);
  const [baselineVersion, setBaselineVersion] = useState(sourceVersion);
  const [conflict, setConflict] = useState(false);
  const [storageError, setStorageError] = useState(initialStorageError);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] =
    useState<Exclude<OrganizationRole, "owner">>("viewer");
  const [inviteError, setInviteError] = useState("");

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );
  const activeMembers = draft.members.filter(
    (member) => member.status === "active",
  ).length;
  const pendingInvitation = createInvitationMember(
    inviteEmail,
    inviteRole,
    "pending-invitation",
  );
  const inviteEmailIsValid = Boolean(pendingInvitation);

  if (sourceVersion !== baselineVersion) {
    const wasDirty = JSON.stringify(draft) !== JSON.stringify(baseline);
    setBaselineVersion(sourceVersion);
    setBaseline(saved);
    setStorageError(initialStorageError);
    if (!wasDirty) {
      setDraft(saved);
      setConflict(false);
    } else {
      setConflict(JSON.stringify(draft) !== JSON.stringify(saved));
    }
  }

  function updateMemberRole(id: string, role: OrganizationRole) {
    setDraft((current) => ({
      ...current,
      members: current.members.map((member) =>
        member.id === id ? { ...member, role } : member,
      ),
    }));
  }

  function updateRule(id: ApprovalRule["id"], update: Partial<ApprovalRule>) {
    setDraft((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === id ? { ...rule, ...update } : rule,
      ),
    }));
  }

  function addInvitation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invitation = createInvitationMember(
      inviteEmail,
      inviteRole,
      `invited-${Date.now()}`,
    );
    if (!invitation) {
      setInviteError("Enter a valid email address.");
      return;
    }
    if (
      draft.members.some(
        (member) => member.email.toLowerCase() === invitation.email,
      )
    ) {
      setInviteError("This email already has access or a pending invitation.");
      return;
    }
    setDraft((current) => ({
      ...current,
      members: [...current.members, invitation],
    }));
    closeInviteDialog();
  }

  function closeInviteDialog() {
    setInviteEmail("");
    setInviteRole("viewer");
    setInviteError("");
    setInviteOpen(false);
  }

  function saveChanges() {
    try {
      window.localStorage.setItem(organizationAccessKey, JSON.stringify(draft));
      window.dispatchEvent(new Event(organizationAccessChangedEvent));
      setStorageError("");
      toast.success("Changes saved");
    } catch {
      setStorageError("Could not save access settings in this browser.");
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if ((dirty || needsReplacement) && !conflict) saveChanges();
      }}
    >
      {storageError && (
        <p role="alert" className="text-sm text-destructive">
          {storageError}
        </p>
      )}

      <section
        aria-labelledby="members-heading"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-5 sm:px-6">
          <div className="flex items-center gap-2">
            <UsersIcon className="size-5 text-primary" aria-hidden="true" />
            <h2 id="members-heading" className="text-lg font-semibold">
              Member access
            </h2>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <p className="text-[11px] text-text-muted/80">
              {activeMembers} active members <span aria-hidden="true">·</span>{" "}
              {draft.members.length - activeMembers} pending
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-9 px-3"
              onClick={() => setInviteOpen(true)}
            >
              <PlusIcon /> Invite member
            </Button>
          </div>
        </div>
        <div className="divide-y divide-border">
          {draft.members.map((member) => (
            <div
              key={member.id}
              className={`grid gap-3 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6 ${
                member.role === "owner"
                  ? ""
                  : "transition-colors hover:bg-surface-elevated/40"
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <Avatar className="size-9">
                  <AvatarFallback className="bg-surface-elevated text-xs font-medium text-foreground">
                    {member.initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {member.name}
                    </p>
                    {member.id === "demo-operator" && (
                      <span className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] leading-none text-text-muted">
                        You
                      </span>
                    )}
                    <Badge
                      variant="outline"
                      className={
                        member.status === "active"
                          ? "border-primary/25 bg-primary/10 text-primary"
                          : "border-warning/15 bg-warning/[0.03] text-warning/70"
                      }
                    >
                      {member.status === "active" ? "Active" : "Invited"}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {member.email}
                  </p>
                </div>
              </div>
              {member.role === "owner" ? (
                <span
                  aria-label={`Role for ${member.name}`}
                  className="px-2.5 text-sm text-muted-foreground sm:w-40 sm:justify-self-end"
                >
                  Owner
                </span>
              ) : (
                <Select
                  value={member.role}
                  onValueChange={(value) =>
                    updateMemberRole(member.id, value as OrganizationRole)
                  }
                >
                  <SelectTrigger
                    aria-label={`Role for ${member.name}`}
                    className="h-9 w-full border-border bg-input-background sm:w-40 sm:justify-self-end"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="end">
                    {roles
                      .filter((role) => role !== "owner")
                      .map((role) => (
                        <SelectItem key={role} value={role}>
                          {roleLabels[role]}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="approval-heading"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon
              className="size-5 text-primary"
              aria-hidden="true"
            />
            <h2 id="approval-heading" className="text-lg font-semibold">
              Approval rules
            </h2>
          </div>
        </div>
        <div className="divide-y divide-border">
          {draft.rules.map((rule) => {
            const Icon = ruleIcons[rule.id];
            return (
              <div
                key={rule.id}
                className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-5 py-3 sm:grid-cols-[1.5rem_minmax(0,1fr)_2.5rem_9rem] sm:px-6"
              >
                <span className="flex size-6 items-center justify-center text-text-muted">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{rule.title}</p>
                  <p className="mt-2 text-xs leading-5 text-text-muted">
                    {rule.description}
                  </p>
                </div>
                <div className="col-start-2 flex items-center justify-between gap-4 sm:contents">
                  <Switch
                    id={`${rule.id}-enabled`}
                    checked={rule.enabled}
                    onCheckedChange={(enabled) =>
                      updateRule(rule.id, { enabled })
                    }
                    aria-label={`Require approval for ${rule.title}`}
                    className="data-checked:ring-1 data-checked:ring-primary/35 sm:col-start-3 sm:justify-self-center"
                  />
                  <Select
                    value={String(rule.approvals)}
                    disabled={!rule.enabled}
                    onValueChange={(value) =>
                      updateRule(rule.id, {
                        approvals: Number(value) as 1 | 2,
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label={`Approvers for ${rule.title}`}
                      className="h-9 w-36 border-border bg-input-background disabled:opacity-25 sm:col-start-4 sm:justify-self-end"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="end">
                      <SelectItem value="1">1 approver</SelectItem>
                      <SelectItem value="2">2 approvers</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-5 pt-5 pb-4 sm:px-6">
          {conflict && (
            <p role="alert" className="mr-auto text-sm text-destructive">
              Access settings changed in another tab. Cancel to load the latest
              version.
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            className="h-9 px-4"
            disabled={!dirty && !conflict}
            onClick={() => {
              setDraft(saved);
              setConflict(false);
            }}
          >
            <RotateCcwIcon /> Cancel
          </Button>
          <Button
            type="submit"
            className="h-9 px-4"
            disabled={(!dirty && !needsReplacement) || conflict}
          >
            Save changes
          </Button>
        </div>
      </section>

      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (open) setInviteOpen(true);
          else closeInviteDialog();
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <form noValidate onSubmit={addInvitation} className="contents">
            <DialogHeader>
              <DialogTitle>Invite member</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-1">
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email address</Label>
                <Input
                  id="invite-email"
                  type="email"
                  autoComplete="email"
                  value={inviteEmail}
                  onChange={(event) => {
                    setInviteEmail(event.target.value);
                    setInviteError("");
                  }}
                  aria-invalid={Boolean(inviteError)}
                  aria-describedby={
                    inviteError ? "invite-email-error" : undefined
                  }
                  placeholder="operator@example.com"
                  maxLength={320}
                  className="h-10"
                  autoFocus
                />
                {inviteError && (
                  <p
                    id="invite-email-error"
                    className="text-sm text-destructive"
                  >
                    {inviteError}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-role">Role</Label>
                <Select
                  value={inviteRole}
                  onValueChange={(value) =>
                    setInviteRole(value as Exclude<OrganizationRole, "owner">)
                  }
                >
                  <SelectTrigger id="invite-role" className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {roles
                      .filter((role) => role !== "owner")
                      .map((role) => (
                        <SelectItem key={role} value={role}>
                          {roleLabels[role]}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeInviteDialog}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!inviteEmailIsValid}>
                Send invitation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </form>
  );
}

export function OrganizationAccess() {
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const loaded = useMemo(() => {
    let saved = defaultOrganizationAccess;
    let storageError = "";
    let needsReplacement = false;
    if (raw === "storage-unavailable") {
      storageError = "Access settings cannot use browser storage.";
    } else if (raw) {
      try {
        saved = parseOrganizationAccess(raw);
      } catch {
        storageError =
          "Saved access settings could not be loaded. Saving will replace the local copy.";
        needsReplacement = true;
      }
    }
    return { saved, storageError, needsReplacement };
  }, [raw]);
  if (raw === null)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading access settings...
      </p>
    );

  return (
    <AccessEditor
      saved={loaded.saved}
      sourceVersion={raw}
      initialStorageError={loaded.storageError}
      needsReplacement={loaded.needsReplacement}
    />
  );
}
