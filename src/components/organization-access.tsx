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

function initialsForEmail(email: string) {
  return (
    email
      .split("@")[0]
      .split(/[._-]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "IN"
  );
}

function nameForEmail(email: string) {
  return email
    .split("@")[0]
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === organizationAccessKey) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
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
  initial,
  initialStorageError,
}: {
  initial: OrganizationAccessSettings;
  initialStorageError: string;
}) {
  const [saved, setSaved] = useState<OrganizationAccessSettings>(initial);
  const [draft, setDraft] = useState<OrganizationAccessSettings>(initial);
  const [storageError, setStorageError] = useState(initialStorageError);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganizationRole>("viewer");
  const [inviteError, setInviteError] = useState("");

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );
  const activeMembers = draft.members.filter(
    (member) => member.status === "active",
  ).length;
  const inviteEmailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    inviteEmail.trim(),
  );

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
    const email = inviteEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteError("Enter a valid email address.");
      return;
    }
    if (draft.members.some((member) => member.email.toLowerCase() === email)) {
      setInviteError("This email already has access or a pending invitation.");
      return;
    }
    setDraft((current) => ({
      ...current,
      members: [
        ...current.members,
        {
          id: `invited-${Date.now()}`,
          name: nameForEmail(email),
          email,
          initials: initialsForEmail(email),
          role: inviteRole,
          status: "invited",
        },
      ],
    }));
    setInviteEmail("");
    setInviteRole("viewer");
    setInviteError("");
    setInviteOpen(false);
  }

  function saveChanges() {
    try {
      window.localStorage.setItem(organizationAccessKey, JSON.stringify(draft));
      setSaved(draft);
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
        if (dirty) saveChanges();
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
          <Button
            type="button"
            variant="secondary"
            className="h-9 px-4"
            disabled={!dirty}
            onClick={() => setDraft(saved)}
          >
            <RotateCcwIcon /> Cancel
          </Button>
          <Button type="submit" className="h-9 px-4" disabled={!dirty}>
            Save changes
          </Button>
        </div>
      </section>

      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open);
          if (!open) setInviteError("");
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
                    setInviteRole(value as OrganizationRole)
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
                onClick={() => setInviteOpen(false)}
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
  if (raw === null)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading access settings...
      </p>
    );

  let initial = defaultOrganizationAccess;
  let initialStorageError = "";
  if (raw === "storage-unavailable") {
    initialStorageError = "Access settings cannot use browser storage.";
  } else if (raw) {
    try {
      initial = parseOrganizationAccess(raw);
    } catch {
      initialStorageError =
        "Saved access settings could not be loaded. Saving will replace the local copy.";
    }
  }

  return (
    <AccessEditor
      key={raw}
      initial={initial}
      initialStorageError={initialStorageError}
    />
  );
}
