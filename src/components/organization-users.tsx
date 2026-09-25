"use client";

import { useMemo, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import {
  FilterIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
  UserRoundPenIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  SortButton,
  TeamSearch,
  type SortDirection,
} from "@/components/organization-team-controls";
import { useOrganizationTeam } from "@/hooks/use-organization-team";
import type {
  OrganizationRole,
  OrganizationUser,
  OrganizationUserStatus,
} from "@/lib/organization-team";

import { Checkbox } from "@/components/ui/checkbox";
import { roleAuthority } from "@/lib/organization-team";

type UserSort = "name" | "role" | "status" | "lastActive";
type UserDraft = Pick<
  OrganizationUser,
  "name" | "email" | "roleIds" | "status"
>;
type UserDraftField = "name" | "email" | "roleIds";
type UserDraftIssue = { field: UserDraftField; message: string };
const emptyInviteDraft: UserDraft = {
  name: "",
  email: "",
  roleIds: [],
  status: "invited",
};

const statusLabels: Record<OrganizationUserStatus, string> = {
  active: "Active",
  invited: "Invited",
  suspended: "Suspended",
};

const statusOrder: Record<OrganizationUserStatus, number> = {
  active: 0,
  invited: 1,
  suspended: 2,
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function formatLastActive(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function matchesEditableUser(
  current: OrganizationUser,
  original: OrganizationUser,
) {
  return (
    current.name === original.name &&
    current.email === original.email &&
    JSON.stringify(current.roleIds) === JSON.stringify(original.roleIds) &&
    current.status === original.status
  );
}

function UserStatusBadge({ status }: { status: OrganizationUserStatus }) {
  if (status === "active") {
    return (
      <Badge
        variant="outline"
        className="border-primary/25 bg-primary/5 text-primary"
      >
        Active
      </Badge>
    );
  }
  if (status === "suspended") {
    return <Badge variant="destructive">Suspended</Badge>;
  }
  return (
    <Badge
      variant="outline"
      className="border-warning/35 bg-warning/10 text-warning"
    >
      Invited
    </Badge>
  );
}

function UserFields({
  draft,
  roles,
  error,
  errorField,
  lockAccess,
  lockIdentity = false,
  showStatus = true,
  onChange,
}: {
  draft: UserDraft;
  roles: OrganizationRole[];
  error: string;
  errorField: UserDraftField | null;
  lockAccess?: boolean;
  lockIdentity?: boolean;
  showStatus?: boolean;
  onChange: (draft: UserDraft) => void;
}) {
  return (
    <div className="grid gap-4">
      {error && !errorField ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="team-user-name">Name</Label>
        <Input
          id="team-user-name"
          disabled={lockIdentity}
          value={draft.name}
          aria-invalid={errorField === "name"}
          aria-describedby={
            errorField === "name" ? "team-user-name-error" : undefined
          }
          className="h-11 sm:h-10"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          autoFocus
        />
        {errorField === "name" ? (
          <p id="team-user-name-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="team-user-email">Email</Label>
        <Input
          id="team-user-email"
          disabled={lockIdentity}
          type="email"
          value={draft.email}
          aria-invalid={errorField === "email"}
          aria-describedby={
            errorField === "email" ? "team-user-email-error" : undefined
          }
          className="h-11 sm:h-10"
          onChange={(event) =>
            onChange({ ...draft, email: event.target.value })
          }
        />
        {errorField === "email" ? (
          <p id="team-user-email-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className={`grid gap-2 ${showStatus ? "sm:grid-cols-2" : ""}`}>
        <div className="grid gap-2">
          <Label htmlFor="team-user-role">Roles</Label>
          <div
            id="team-user-role"
            role="group"
            aria-label="User roles"
            tabIndex={-1}
            aria-describedby={
              errorField === "roleIds" ? "team-user-role-error" : undefined
            }
            className="grid gap-3 rounded-md border p-3"
          >
            {roles.map((role) => (
              <label
                key={role.id}
                className="flex min-h-8 items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={draft.roleIds.includes(role.id)}
                  disabled={lockAccess || role.id === "owner"}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...draft,
                      roleIds: checked
                        ? [...draft.roleIds, role.id]
                        : draft.roleIds.filter((id) => id !== role.id),
                    })
                  }
                />
                {role.name}
              </label>
            ))}
          </div>
          {errorField === "roleIds" ? (
            <p id="team-user-role-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {showStatus ? (
          <div className="grid gap-2">
            <Label htmlFor="team-user-status">Status</Label>
            <Select
              value={draft.status}
              disabled={lockAccess || draft.status === "invited"}
              onValueChange={(status) =>
                onChange({
                  ...draft,
                  status: status as OrganizationUserStatus,
                })
              }
            >
              <SelectTrigger
                id="team-user-status"
                aria-label="User status"
                className="h-11 w-full bg-input-background sm:h-10"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="active">Active</SelectItem>
                {draft.status === "invited" && (
                  <SelectItem value="invited">Invited</SelectItem>
                )}
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      {lockAccess ? (
        <p className="text-xs leading-5 text-muted-foreground">
          You cannot change access for yourself or users at or above your
          highest role.
        </p>
      ) : null}
    </div>
  );
}

export function OrganizationUsers() {
  const {
    ready,
    settings,
    storageError,
    clearStorageError,
    save,
    currentOperatorId,
    saving,
    canManage,
    reload,
    invitationLink,
    clearInvitation,
  } = useOrganizationTeam();
  const [query, setQuery] = useState("");
  const [roleFilters, setRoleFilters] = useState<Set<string>>(new Set());
  const [statusFilters, setStatusFilters] = useState<
    Set<OrganizationUserStatus>
  >(new Set());
  const [sort, setSort] = useState<UserSort>("name");
  const [direction, setDirection] = useState<SortDirection>("asc");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteDraft, setInviteDraft] = useState<UserDraft>(emptyInviteDraft);
  const [inviteError, setInviteError] = useState("");
  const [inviteErrorField, setInviteErrorField] =
    useState<UserDraftField | null>(null);
  const [editing, setEditing] = useState<OrganizationUser | null>(null);
  const [editDraft, setEditDraft] = useState<UserDraft | null>(null);
  const [editError, setEditError] = useState("");
  const [editErrorField, setEditErrorField] = useState<UserDraftField | null>(
    null,
  );
  const [removing, setRemoving] = useState<OrganizationUser | null>(null);
  const [removeError, setRemoveError] = useState("");
  const rolesById = useMemo(
    () => new Map(settings.roles.map((role) => [role.id, role])),
    [settings.roles],
  );
  const authority = roleAuthority(settings, currentOperatorId);
  const assignableRoles = settings.roles.filter(authority.canGrant);
  const users = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = settings.users.filter((user) => {
      const role = user.roleIds
        .map((id) => rolesById.get(id)?.name ?? "Unknown role")
        .join(", ");
      const matchesQuery =
        !normalized ||
        `${user.name} ${user.email} ${role} ${statusLabels[user.status]}`
          .toLowerCase()
          .includes(normalized);
      const matchesRole =
        roleFilters.size === 0 ||
        user.roleIds.some((id) => roleFilters.has(id));
      const matchesStatus =
        statusFilters.size === 0 || statusFilters.has(user.status);
      return matchesQuery && matchesRole && matchesStatus;
    });
    return filtered.toSorted((left, right) => {
      let result = 0;
      if (sort === "name") result = left.name.localeCompare(right.name);
      if (sort === "role")
        result =
          Math.min(
            ...left.roleIds.map(
              (id) => rolesById.get(id)?.position ?? Infinity,
            ),
          ) -
          Math.min(
            ...right.roleIds.map(
              (id) => rolesById.get(id)?.position ?? Infinity,
            ),
          );
      if (sort === "status")
        result = statusOrder[left.status] - statusOrder[right.status];
      if (sort === "lastActive")
        result = (left.lastActiveAt ?? "").localeCompare(
          right.lastActiveAt ?? "",
        );
      return direction === "asc" ? result : -result;
    });
  }, [
    direction,
    query,
    roleFilters,
    rolesById,
    settings.users,
    sort,
    statusFilters,
  ]);

  if (!ready) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading users...
      </p>
    );
  }

  function changeSort(next: UserSort) {
    if (sort === next) setDirection(direction === "asc" ? "desc" : "asc");
    else {
      setSort(next);
      setDirection("asc");
    }
  }

  function toggleRoleFilter(roleId: string) {
    setRoleFilters((current) => {
      const next = new Set(current);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  function toggleStatusFilter(status: OrganizationUserStatus) {
    setStatusFilters((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function clearFilters() {
    setRoleFilters(new Set());
    setStatusFilters(new Set());
  }

  function validateDraft(
    draft: UserDraft,
    currentId?: string,
  ): UserDraftIssue | null {
    if (!draft.name.trim())
      return { field: "name", message: "Enter the user's name." };
    if (!/^\S+@\S+\.\S+$/.test(draft.email.trim()))
      return { field: "email", message: "Enter a valid email address." };
    if (
      settings.users.some(
        (user) =>
          user.id !== currentId &&
          user.email.toLowerCase() === draft.email.trim().toLowerCase(),
      )
    )
      return {
        field: "email",
        message: "A user with this email already exists.",
      };
    if (
      !draft.roleIds.length ||
      draft.roleIds.some((id) => !settings.roles.some((role) => role.id === id))
    )
      return { field: "roleIds", message: "Choose an available role." };
    return null;
  }

  function focusDraftIssue(
    issue: UserDraftIssue,
    setError: (message: string) => void,
    setErrorField: (field: UserDraftField | null) => void,
  ) {
    flushSync(() => {
      setError(issue.message);
      setErrorField(issue.field);
    });
    const fieldId = issue.field === "roleIds" ? "role" : issue.field;
    document.getElementById(`team-user-${fieldId}`)?.focus();
  }

  async function createUser() {
    const issue = validateDraft(inviteDraft);
    if (issue) {
      focusDraftIssue(issue, setInviteError, setInviteErrorField);
      return;
    }
    setInviteError("");
    setInviteErrorField(null);
    const nextUser: OrganizationUser = {
      id: `user-${Date.now()}`,
      name: inviteDraft.name.trim(),
      email: inviteDraft.email.trim().toLowerCase(),
      roleIds: inviteDraft.roleIds,
      status: "invited",
      lastActiveAt: null,
    };
    if (await save({ ...settings, users: [...settings.users, nextUser] })) {
      setInviteOpen(false);
      setInviteDraft(emptyInviteDraft);
      toast.success(`Invitation created for ${nextUser.email}.`);
    }
  }

  async function updateUser() {
    if (!editing || !editDraft) return;
    const currentUser = settings.users.find(({ id }) => id === editing.id);
    if (!currentUser) {
      setEditError(
        "This user was removed in another tab. Close this dialog to continue.",
      );
      setEditErrorField(null);
      return;
    }
    if (!matchesEditableUser(currentUser, editing)) {
      setEditError(
        "This user changed in another tab. Close and reopen the dialog before saving.",
      );
      setEditErrorField(null);
      return;
    }
    const issue = validateDraft(editDraft, editing.id);
    if (issue) {
      focusDraftIssue(issue, setEditError, setEditErrorField);
      return;
    }
    setEditError("");
    setEditErrorField(null);
    const lockAccess = !authority.canManageUser(editing);
    const next = settings.users.map((user) =>
      user.id === editing.id
        ? {
            ...user,
            name: editDraft.name.trim(),
            email: editDraft.email.trim().toLowerCase(),
            roleIds: lockAccess ? user.roleIds : editDraft.roleIds,
            status: lockAccess ? user.status : editDraft.status,
          }
        : user,
    );
    if (await save({ ...settings, users: next })) {
      setEditing(null);
      setEditDraft(null);
      toast.success("User updated.");
    }
  }

  function openRemoveUser(user: OrganizationUser) {
    clearStorageError();
    setRemoveError("");
    setRemoving(user);
  }

  async function removeUser(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!removing) return;
    const currentUser = settings.users.find(({ id }) => id === removing.id);
    if (!currentUser) {
      setRemoveError(
        "This user was already removed in another tab. Close this confirmation.",
      );
      return;
    }
    if (!matchesEditableUser(currentUser, removing)) {
      setRemoveError(
        "This user changed in another tab. Close and reopen the confirmation before removing them.",
      );
      return;
    }
    if (currentUser.id === currentOperatorId) {
      setRemoveError("The current operator cannot be removed.");
      return;
    }
    if (
      await save({
        ...settings,
        users: settings.users.filter((user) => user.id !== removing.id),
      })
    ) {
      toast.success(`${removing.name} removed.`);
      setRemoveError("");
      setRemoving(null);
    }
  }

  const resultLabel = `${users.length} ${users.length === 1 ? "user" : "users"}`;
  const activeFilterCount = roleFilters.size + statusFilters.size;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <Button
          className="h-11 sm:h-9"
          disabled={saving || !canManage}
          onClick={() => {
            clearStorageError();
            setInviteError("");
            setInviteErrorField(null);
            setInviteOpen(true);
          }}
        >
          <PlusIcon /> Invite user
        </Button>
      </div>
      <div className="space-y-4">
        {storageError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {storageError}
              <Button variant="outline" onClick={() => void reload()}>
                Refresh users
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <section
          aria-label="Organization users"
          className="overflow-hidden rounded-xl border border-border bg-card"
        >
          <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
            <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
              <TeamSearch
                id="user-search"
                label="Search users"
                value={query}
                onChange={setQuery}
                className="sm:w-72 sm:flex-none lg:w-80"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 bg-input-background lg:h-9"
                    aria-label={`Filters${activeFilterCount ? `, ${activeFilterCount} active` : ""}`}
                  >
                    <FilterIcon aria-hidden="true" />
                    Filters
                    {activeFilterCount ? (
                      <Badge
                        variant="secondary"
                        className="ml-0.5 min-w-5 justify-center px-1.5"
                        aria-hidden="true"
                      >
                        {activeFilterCount}
                      </Badge>
                    ) : null}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel>Role</DropdownMenuLabel>
                  {settings.roles.map((role) => (
                    <DropdownMenuCheckboxItem
                      key={role.id}
                      checked={roleFilters.has(role.id)}
                      onCheckedChange={() => toggleRoleFilter(role.id)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      {role.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Status</DropdownMenuLabel>
                  {(
                    Object.entries(statusLabels) as [
                      OrganizationUserStatus,
                      string,
                    ][]
                  ).map(([status, label]) => (
                    <DropdownMenuCheckboxItem
                      key={status}
                      checked={statusFilters.has(status)}
                      onCheckedChange={() => toggleStatusFilter(status)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      {label}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {activeFilterCount ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={clearFilters}>
                        Clear filters
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Select
              value={`${sort}:${direction}`}
              onValueChange={(value) => {
                const [nextSort, nextDirection] = value.split(":") as [
                  UserSort,
                  SortDirection,
                ];
                setSort(nextSort);
                setDirection(nextDirection);
              }}
            >
              <SelectTrigger
                aria-label="Sort users"
                className="h-11 w-full bg-input-background sm:w-48 md:hidden"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value="name:asc">Name, A to Z</SelectItem>
                <SelectItem value="name:desc">Name, Z to A</SelectItem>
                <SelectItem value="role:asc">Role</SelectItem>
                <SelectItem value="status:asc">Status</SelectItem>
                <SelectItem value="lastActive:desc">Recently active</SelectItem>
              </SelectContent>
            </Select>
            <p
              className="ml-auto shrink-0 px-1 text-xs text-text-muted"
              role="status"
            >
              {resultLabel}
            </p>
          </div>

          {users.length ? (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableCaption className="sr-only">
                    Organization users
                  </TableCaption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-4">
                        <SortButton
                          label="User"
                          active={sort === "name"}
                          direction={direction}
                          onClick={() => changeSort("name")}
                        />
                      </TableHead>
                      <TableHead>
                        <SortButton
                          label="Role"
                          active={sort === "role"}
                          direction={direction}
                          onClick={() => changeSort("role")}
                        />
                      </TableHead>
                      <TableHead>
                        <SortButton
                          label="Status"
                          active={sort === "status"}
                          direction={direction}
                          onClick={() => changeSort("status")}
                        />
                      </TableHead>
                      <TableHead>
                        <SortButton
                          label="Last active"
                          active={sort === "lastActive"}
                          direction={direction}
                          onClick={() => changeSort("lastActive")}
                        />
                      </TableHead>
                      <TableHead className="w-14">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface-elevated text-xs font-medium">
                              {initials(user.name)}
                            </span>
                            <span className="min-w-0">
                              <span className="block font-medium">
                                {user.name}
                              </span>
                              <span className="block text-xs text-text-muted">
                                {user.email}
                              </span>
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {user.roleIds
                            .map(
                              (id) => rolesById.get(id)?.name ?? "Unknown role",
                            )
                            .join(", ")}
                        </TableCell>
                        <TableCell>
                          <UserStatusBadge status={user.status} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatLastActive(user.lastActiveAt)}
                        </TableCell>
                        <TableCell className="pr-3 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Manage ${user.name}`}
                                disabled={
                                  saving || !authority.canManageUser(user)
                                }
                              >
                                <MoreHorizontalIcon />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className="w-28 min-w-28"
                            >
                              <DropdownMenuItem
                                onSelect={() => {
                                  clearStorageError();
                                  setEditError("");
                                  setEditErrorField(null);
                                  setEditing(user);
                                  setEditDraft({
                                    name: user.name,
                                    email: user.email,
                                    roleIds: user.roleIds,
                                    status: user.status,
                                  });
                                }}
                              >
                                <UserRoundPenIcon /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={!authority.canManageUser(user)}
                                onSelect={() => openRemoveUser(user)}
                              >
                                <Trash2Icon /> Remove
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <ul
                aria-label="Organization users"
                className="divide-y divide-border md:hidden"
              >
                {users.map((user) => (
                  <li key={user.id} className="p-4">
                    <div className="flex items-start gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-elevated text-xs font-medium">
                        {initials(user.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{user.name}</p>
                        <p className="truncate text-xs text-text-muted">
                          {user.email}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                          <span>
                            {user.roleIds
                              .map((id) => rolesById.get(id)?.name)
                              .join(", ")}
                          </span>
                          <span aria-hidden="true">·</span>
                          <UserStatusBadge status={user.status} />
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-11"
                            aria-label={`Manage ${user.name}`}
                            disabled={saving || !authority.canManageUser(user)}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="w-28 min-w-28"
                        >
                          <DropdownMenuItem
                            onSelect={() => {
                              clearStorageError();
                              setEditError("");
                              setEditErrorField(null);
                              setEditing(user);
                              setEditDraft({
                                name: user.name,
                                email: user.email,
                                roleIds: user.roleIds,
                                status: user.status,
                              });
                            }}
                          >
                            <UserRoundPenIcon /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={!authority.canManageUser(user)}
                            onSelect={() => openRemoveUser(user)}
                          >
                            <Trash2Icon /> Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="px-6 py-12 text-center">
              <h2 className="text-base font-semibold">No matching users</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeFilterCount
                  ? "Try another search or remove a filter."
                  : "Try another name, email, role, or status."}
              </p>
              <Button
                variant="outline"
                className="mt-4 h-11 sm:h-9"
                onClick={() => {
                  setQuery("");
                  clearFilters();
                }}
              >
                {activeFilterCount && query
                  ? "Clear all"
                  : activeFilterCount
                    ? "Clear filters"
                    : "Clear search"}
              </Button>
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={Boolean(invitationLink)}
        onOpenChange={(open) => {
          if (!open) clearInvitation();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share invitation</DialogTitle>
            <DialogDescription>
              Copy this link now and send it to the invited user. It expires
              after seven days and can be accepted once. Cupboard will not show
              it again.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="invitation-link">Invitation link</Label>
          <Input
            id="invitation-link"
            value={invitationLink}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button>Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open);
          if (!open) {
            setInviteDraft(emptyInviteDraft);
            setInviteError("");
            setInviteErrorField(null);
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
            <DialogDescription>
              Choose one or more roles and create an invitation link. Share it
              with the invited user. The link expires after seven days; no email
              is sent.
            </DialogDescription>
          </DialogHeader>
          <UserFields
            draft={inviteDraft}
            roles={assignableRoles}
            error={inviteError || storageError}
            errorField={inviteErrorField}
            showStatus={false}
            onChange={(draft) => {
              setInviteDraft(draft);
              setInviteError("");
              setInviteErrorField(null);
            }}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" className="h-11 sm:h-9">
                Cancel
              </Button>
            </DialogClose>
            <Button
              className="h-11 sm:h-9"
              disabled={saving}
              onClick={createUser}
            >
              Create invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setEditDraft(null);
            setEditErrorField(null);
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>
              Change this user&apos;s roles or suspend access to this
              organization. Saving applies the change to their current session.
            </DialogDescription>
          </DialogHeader>
          {editDraft ? (
            <UserFields
              draft={editDraft}
              roles={settings.roles.filter(
                (role) =>
                  authority.canGrant(role) ||
                  editDraft.roleIds.includes(role.id),
              )}
              error={editError || storageError}
              errorField={editErrorField}
              lockIdentity
              lockAccess={Boolean(editing && !authority.canManageUser(editing))}
              onChange={(draft) => {
                setEditDraft(draft);
                setEditError("");
                setEditErrorField(null);
              }}
            />
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" className="h-11 sm:h-9">
                Cancel
              </Button>
            </DialogClose>
            <Button
              className="h-11 sm:h-9"
              disabled={saving}
              onClick={updateUser}
            >
              Save user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            setRemoveError("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes access to the organization and cancels any pending
              invitation. You can invite the user again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError || storageError ? (
            <Alert variant="destructive">
              <AlertDescription>{removeError || storageError}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep user</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={saving}
              onClick={removeUser}
            >
              Remove user
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
