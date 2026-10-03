"use client";

import { roleAuthority } from "@/lib/organization-team";
import { useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import {
  CheckIcon,
  MinusIcon,
  GripVerticalIcon,
  LockKeyholeIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  CopyPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
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
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
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
import { Textarea } from "@/components/ui/textarea";
import {
  SortButton,
  TeamSearch,
  type SortDirection,
} from "@/components/organization-team-controls";
import { useOrganizationTeam } from "@/hooks/use-organization-team";
import {
  permissionDefinitions,
  type OrganizationRole,
  type PermissionId,
} from "@/lib/organization-team";

type RoleSort = "position" | "name" | "users" | "permissions";
type RoleDraft = Pick<OrganizationRole, "name" | "description" | "permissions">;
type RoleDraftField = keyof RoleDraft;
type RoleDraftIssue = { field: RoleDraftField; message: string };

const emptyDraft: RoleDraft = {
  name: "",
  description: "",
  permissions: [],
};

function matchesEditableRole(
  current: OrganizationRole,
  original: OrganizationRole,
) {
  return (
    current.name === original.name &&
    current.description === original.description &&
    current.permissions.length === original.permissions.length &&
    current.permissions.every(
      (permission, index) => permission === original.permissions[index],
    )
  );
}

function PermissionBadges({ permissions }: { permissions: PermissionId[] }) {
  const labels = [
    permissions.includes("servers.manage")
      ? "Server management"
      : permissions.includes("servers.view")
        ? "Server viewing"
        : null,
    permissions.includes("players.moderate") ? "Moderation" : null,
    permissions.includes("organization.manage")
      ? "Organization management"
      : null,
    permissions.includes("integrations.manage") ? "Integrations" : null,
    permissions.includes("billing.manage") ? "Billing" : null,
  ].filter(Boolean);
  return (
    <p className="max-w-lg text-sm leading-6 text-muted-foreground">
      {labels.join(" · ") || "No permissions"}
    </p>
  );
}

function RoleFields({
  draft,
  error,
  errorField,
  editingSystemRole,
  lockPermissions,
  onChange,
}: {
  draft: RoleDraft;
  error: string;
  errorField: RoleDraftField | null;
  editingSystemRole: boolean;
  lockPermissions: boolean;
  onChange: (draft: RoleDraft) => void;
}) {
  const groups = ["Servers", "Community", "Organization"] as const;
  return (
    <div className="grid gap-5">
      {error && !errorField ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="role-name">Role name</Label>
        <Input
          id="role-name"
          value={draft.name}
          aria-invalid={errorField === "name"}
          aria-describedby={
            errorField === "name" ? "role-name-error" : undefined
          }
          disabled={editingSystemRole || lockPermissions}
          className="h-11 sm:h-10"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          autoFocus={!editingSystemRole}
        />
        {errorField === "name" ? (
          <p id="role-name-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="role-description">Description</Label>
        <Textarea
          id="role-description"
          disabled={lockPermissions}
          value={draft.description}
          aria-invalid={errorField === "description"}
          aria-describedby={
            errorField === "description" ? "role-description-error" : undefined
          }
          className="min-h-[88px] resize-none"
          onChange={(event) =>
            onChange({ ...draft, description: event.target.value })
          }
        />
        {errorField === "description" ? (
          <p id="role-description-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <fieldset
        disabled={lockPermissions}
        aria-invalid={errorField === "permissions"}
        aria-describedby={
          errorField === "permissions" ? "role-permissions-error" : undefined
        }
        className="grid gap-4"
      >
        <legend className="text-sm font-medium">Permissions</legend>
        {groups.map((group) => (
          <div key={group} className="grid gap-2">
            <p className="flex justify-between text-sm font-medium">
              {group}
              <span className="text-xs text-muted-foreground">
                {
                  permissionDefinitions.filter(
                    (permission) =>
                      permission.group === group &&
                      draft.permissions.includes(permission.id),
                  ).length
                }{" "}
                selected
              </span>
            </p>
            <div className="divide-y divide-border rounded-lg border border-border">
              {permissionDefinitions
                .filter((permission) => permission.group === group)
                .map((permission) => {
                  const checked = draft.permissions.includes(permission.id);
                  return (
                    <label
                      key={permission.id}
                      className="flex cursor-pointer items-start gap-3 p-3 transition-colors hover:bg-surface-elevated has-disabled:cursor-not-allowed has-disabled:opacity-60"
                    >
                      <Checkbox
                        id={`role-permission-${permission.id}`}
                        disabled={lockPermissions}
                        checked={checked}
                        aria-invalid={errorField === "permissions"}
                        aria-describedby={
                          errorField === "permissions"
                            ? "role-permissions-error"
                            : undefined
                        }
                        onCheckedChange={(nextChecked) =>
                          onChange({
                            ...draft,
                            permissions: nextChecked
                              ? [...draft.permissions, permission.id]
                              : draft.permissions.filter(
                                  (id) => id !== permission.id,
                                ),
                          })
                        }
                        aria-label={permission.label}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">
                          {permission.label}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          {permission.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
            </div>
          </div>
        ))}
        {errorField === "permissions" ? (
          <p id="role-permissions-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </fieldset>
      {lockPermissions ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Permissions cannot be changed for this role.
        </p>
      ) : null}
    </div>
  );
}

export function OrganizationRoles() {
  const {
    ready,
    settings,
    storageError,
    clearStorageError,
    save,
    saving,
    canManage,
    currentOperatorId,
    reorderRoles,
    reload,
  } = useOrganizationTeam();
  const detailsTrigger = useRef<HTMLButtonElement | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const pointerDrag = useRef<{
    id: string;
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
    target: string | null;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [sort, setSort] = useState<RoleSort>("position");
  const [direction, setDirection] = useState<SortDirection>("asc");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<OrganizationRole | null>(null);
  const [draft, setDraft] = useState<RoleDraft>(emptyDraft);
  const [formError, setFormError] = useState("");
  const [formErrorField, setFormErrorField] = useState<RoleDraftField | null>(
    null,
  );
  const [deleting, setDeleting] = useState<OrganizationRole | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const userCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const user of settings.users)
      for (const id of user.roleIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [settings.users]);
  const roles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = settings.roles.filter((role) => {
      const permissions = permissionDefinitions
        .filter(({ id }) => role.permissions.includes(id))
        .map(({ label }) => label)
        .join(" ");
      return `${role.name} ${role.description} ${permissions}`
        .toLowerCase()
        .includes(normalized);
    });
    return filtered.toSorted((left, right) => {
      let result = 0;
      if (sort === "position") result = left.position - right.position;
      if (sort === "name") result = left.name.localeCompare(right.name);
      if (sort === "users")
        result =
          (userCounts.get(left.id) ?? 0) - (userCounts.get(right.id) ?? 0);
      if (sort === "permissions")
        result = left.permissions.length - right.permissions.length;
      return direction === "asc" ? result : -result;
    });
  }, [direction, query, settings.roles, sort, userCounts]);

  const selectedRole = settings.roles.find(
    (role) => role.id === selectedRoleId,
  );
  const authority = roleAuthority(settings, currentOperatorId);
  const orderedRoles = settings.roles.toSorted(
    (a, b) => a.position - b.position,
  );
  const canMove = (role: OrganizationRole) =>
    !saving &&
    !role.system &&
    authority.canGrant(role) &&
    sort === "position" &&
    direction === "asc" &&
    !query.trim();
  async function moveRole(id: string, targetId: string) {
    const from = orderedRoles.findIndex((role) => role.id === id);
    const to = orderedRoles.findIndex((role) => role.id === targetId);
    if (
      from < 0 ||
      to < 0 ||
      from === to ||
      !canMove(orderedRoles[from]) ||
      !canMove(orderedRoles[to])
    )
      return;
    const ids = orderedRoles.map((role) => role.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    if (await reorderRoles(ids)) toast.success("Role order updated.");
  }
  function moveAdjacent(role: OrganizationRole, offset: number) {
    const target =
      orderedRoles[
        orderedRoles.findIndex((entry) => entry.id === role.id) + offset
      ];
    if (target) void moveRole(role.id, target.id);
  }
  function canMoveAdjacent(role: OrganizationRole, offset: number) {
    const target =
      orderedRoles[
        orderedRoles.findIndex((entry) => entry.id === role.id) + offset
      ];
    return canMove(role) && Boolean(target && canMove(target));
  }
  function reorderHandle(role: OrganizationRole) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-11 touch-none cursor-grab active:cursor-grabbing md:size-8"
        aria-label={`Reorder ${role.name}`}
        title={
          canMove(role)
            ? "Drag to reorder, or use Arrow Up and Arrow Down"
            : "This role cannot be moved"
        }
        disabled={!canMove(role)}
        onPointerDown={(event) => {
          if (event.button !== 0 || !canMove(role)) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerDrag.current = {
            id: role.id,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            moved: false,
            target: null,
          };
        }}
        onPointerMove={(event) => {
          const drag = pointerDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (
            Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5 &&
            !drag.moved
          )
            return;
          drag.moved = true;
          const id = document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLElement>("[data-role-target]")?.dataset.roleTarget;
          const target = orderedRoles.find((entry) => entry.id === id);
          drag.target =
            target && target.id !== drag.id && canMove(target)
              ? target.id
              : null;
          setDropTarget(drag.target);
        }}
        onPointerUp={(event) => {
          const drag = pointerDrag.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          pointerDrag.current = null;
          setDropTarget(null);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          if (drag.moved && drag.target) void moveRole(drag.id, drag.target);
        }}
        onPointerCancel={() => {
          pointerDrag.current = null;
          setDropTarget(null);
        }}
        onLostPointerCapture={() => {
          pointerDrag.current = null;
          setDropTarget(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            pointerDrag.current = null;
            setDropTarget(null);
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            moveAdjacent(role, event.key === "ArrowUp" ? -1 : 1);
          }
        }}
      >
        {role.system ? <LockKeyholeIcon /> : <GripVerticalIcon />}
      </Button>
    );
  }
  if (!ready) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading roles...
      </p>
    );
  }

  function changeSort(next: RoleSort) {
    if (sort === next) setDirection(direction === "asc" ? "desc" : "asc");
    else {
      setSort(next);
      setDirection("asc");
    }
  }

  function openRoleDialog(role?: OrganizationRole) {
    clearStorageError();
    setFormError("");
    setFormErrorField(null);
    setEditing(role ?? null);
    setDraft(
      role
        ? {
            name: role.name,
            description: role.description,
            permissions: [...role.permissions],
          }
        : emptyDraft,
    );
    setDialogOpen(true);
  }

  function focusRoleIssue(issue: RoleDraftIssue) {
    flushSync(() => {
      setFormError(issue.message);
      setFormErrorField(issue.field);
    });
    const fieldId =
      issue.field === "permissions"
        ? `role-permission-${permissionDefinitions[0].id}`
        : `role-${issue.field}`;
    document.getElementById(fieldId)?.focus();
  }

  async function saveRole() {
    if (editing) {
      const currentRole = settings.roles.find(({ id }) => id === editing.id);
      if (!currentRole) {
        setFormError(
          "This role was removed in another tab. Close this dialog to continue.",
        );
        setFormErrorField(null);
        return;
      }
      if (!matchesEditableRole(currentRole, editing)) {
        setFormError(
          "This role changed in another tab. Close and reopen the dialog before saving.",
        );
        setFormErrorField(null);
        return;
      }
    }
    const normalizedName = draft.name.trim();
    if (!normalizedName) {
      focusRoleIssue({ field: "name", message: "Enter a role name." });
      return;
    }
    if (!draft.description.trim()) {
      focusRoleIssue({
        field: "description",
        message: "Describe what this role is for.",
      });
      return;
    }
    if (!draft.permissions.length) {
      focusRoleIssue({
        field: "permissions",
        message: "Choose at least one permission.",
      });
      return;
    }
    if (
      settings.roles.some(
        (role) =>
          role.id !== editing?.id &&
          role.name.toLowerCase() === normalizedName.toLowerCase(),
      )
    ) {
      focusRoleIssue({
        field: "name",
        message: "A role with this name already exists.",
      });
      return;
    }
    setFormError("");
    setFormErrorField(null);

    const nextRole: OrganizationRole = editing
      ? {
          ...editing,
          name: editing.system ? editing.name : normalizedName,
          description: draft.description.trim(),
          permissions:
            editing.id === "owner"
              ? permissionDefinitions.map(({ id }) => id)
              : draft.permissions,
        }
      : {
          id: `role-${Date.now()}`,
          name: normalizedName,
          description: draft.description.trim(),
          permissions: draft.permissions,
          system: false,
          position:
            Math.max(1, ...settings.roles.map((role) => role.position)) + 1,
        };
    const nextRoles = editing
      ? settings.roles.map((role) => (role.id === editing.id ? nextRole : role))
      : [...settings.roles, nextRole];
    if (await save({ ...settings, roles: nextRoles })) {
      setDialogOpen(false);
      toast.success(editing ? "Role updated." : "Role created.");
    }
  }

  function duplicateRole(role: OrganizationRole) {
    clearStorageError();
    setEditing(null);
    setFormError("");
    setFormErrorField(null);
    setDraft({
      name: `${role.name} copy`,
      description: role.description,
      permissions: [...role.permissions],
    });
    setDialogOpen(true);
  }

  function openDeleteRole(role: OrganizationRole) {
    clearStorageError();
    setDeleteError("");
    setDeleting(role);
  }

  async function deleteRole(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!deleting) return;
    const currentRole = settings.roles.find(({ id }) => id === deleting.id);
    if (!currentRole) {
      setDeleteError(
        "This role was already deleted in another tab. Close this confirmation.",
      );
      return;
    }
    if (!matchesEditableRole(currentRole, deleting)) {
      setDeleteError(
        "This role changed in another tab. Close and reopen the confirmation before deleting it.",
      );
      return;
    }
    const assignedUsers = userCounts.get(deleting.id) ?? 0;
    if (currentRole.system || assignedUsers > 0) {
      setDeleteError(
        assignedUsers > 0
          ? `This role is now assigned to ${assignedUsers} ${assignedUsers === 1 ? "user" : "users"}. Reassign ${assignedUsers === 1 ? "that user" : "those users"} before deleting the role.`
          : "Built-in roles cannot be deleted.",
      );
      return;
    }
    if (
      await save({
        ...settings,
        roles: settings.roles.filter((role) => role.id !== deleting.id),
      })
    ) {
      toast.success(`${deleting.name} deleted.`);
      setDeleteError("");
      setDeleting(null);
    }
  }

  const resultLabel = `${roles.length} ${roles.length === 1 ? "role" : "roles"}`;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Roles</h1>
        </div>
        <Button
          className="h-11 sm:h-9"
          disabled={saving || !canManage}
          onClick={() => openRoleDialog()}
        >
          <PlusIcon /> Add role
        </Button>
      </div>
      <div className="space-y-4">
        {storageError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {storageError}
              <Button variant="outline" onClick={() => void reload()}>
                Refresh roles
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <section
          aria-label="Organization roles"
          className="overflow-hidden rounded-xl border border-border bg-card"
        >
          <div className="flex flex-col gap-3 border-b border-border p-3 sm:flex-row sm:items-center">
            <TeamSearch
              id="role-search"
              label="Search roles"
              value={query}
              onChange={setQuery}
            />
            <Select
              value={`${sort}:${direction}`}
              onValueChange={(value) => {
                const [nextSort, nextDirection] = value.split(":") as [
                  RoleSort,
                  SortDirection,
                ];
                setSort(nextSort);
                setDirection(nextDirection);
              }}
            >
              <SelectTrigger
                aria-label="Sort roles"
                className="h-11 w-full bg-input-background sm:w-48"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value="position:asc">Highest role first</SelectItem>
                <SelectItem value="name:asc">Name, A to Z</SelectItem>
                <SelectItem value="name:desc">Name, Z to A</SelectItem>
                <SelectItem value="users:desc">Most users</SelectItem>
                <SelectItem value="permissions:desc">
                  Most permissions
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="shrink-0 px-1 text-xs text-text-muted" role="status">
              {resultLabel}
            </p>
          </div>

          {(sort !== "position" || direction !== "asc" || query.trim()) && (
            <div className="flex items-center gap-3 border-b p-3 text-sm text-muted-foreground">
              <span>
                Reordering uses the full hierarchy, highest role first.
              </span>
              <Button
                variant="outline"
                onClick={() => {
                  setSort("position");
                  setDirection("asc");
                  setQuery("");
                }}
              >
                Enable reordering
              </Button>
            </div>
          )}
          {roles.length ? (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableCaption className="sr-only">
                    Organization roles and permissions
                  </TableCaption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-12">
                        <span className="sr-only">Order</span>
                      </TableHead>
                      <TableHead className="px-4">
                        <SortButton
                          label="Role"
                          active={sort === "name"}
                          direction={direction}
                          onClick={() => changeSort("name")}
                        />
                      </TableHead>
                      <TableHead>
                        <SortButton
                          label="Members"
                          active={sort === "users"}
                          direction={direction}
                          onClick={() => changeSort("users")}
                        />
                      </TableHead>
                      <TableHead>
                        <SortButton
                          label="Access summary"
                          active={sort === "permissions"}
                          direction={direction}
                          onClick={() => changeSort("permissions")}
                        />
                      </TableHead>
                      <TableHead className="w-14">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {roles.map((role) => {
                      const count = userCounts.get(role.id) ?? 0;
                      return (
                        <TableRow
                          key={role.id}
                          data-role-target={role.id}
                          className={
                            dropTarget === role.id
                              ? "bg-primary/10 outline-2 outline-primary -outline-offset-2"
                              : undefined
                          }
                          draggable={canMove(role)}
                          onDragStart={(event) => {
                            if (!canMove(role)) {
                              event.preventDefault();
                              return;
                            }
                            event.dataTransfer.setData("text/plain", role.id);
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          onDragOver={(event) => {
                            if (canMove(role)) {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setDropTarget(role.id);
                            }
                          }}
                          onDragLeave={() => setDropTarget(null)}
                          onDragEnd={() => setDropTarget(null)}
                          onDrop={(event) => {
                            event.preventDefault();
                            setDropTarget(null);
                            void moveRole(
                              event.dataTransfer.getData("text/plain"),
                              role.id,
                            );
                          }}
                        >
                          <TableCell>{reorderHandle(role)}</TableCell>
                          <TableCell className="max-w-sm px-4 py-3 whitespace-normal">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                className="rounded-sm text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                aria-label={`View ${role.name} role`}
                                onClick={(event) => {
                                  detailsTrigger.current = event.currentTarget;
                                  setSelectedRoleId(role.id);
                                }}
                              >
                                {role.name}
                              </button>
                              {role.system ? (
                                <Badge variant="outline">Built in</Badge>
                              ) : null}
                            </div>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              {role.description}
                            </p>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {count}
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <PermissionBadges permissions={role.permissions} />
                          </TableCell>
                          <TableCell className="pr-3 text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Manage ${role.name}`}
                                >
                                  <MoreHorizontalIcon />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem
                                  onSelect={() => openRoleDialog(role)}
                                >
                                  <PencilIcon /> Edit role
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => duplicateRole(role)}
                                >
                                  <CopyPlusIcon /> Duplicate role
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  disabled={!canMoveAdjacent(role, -1)}
                                  onSelect={() => moveAdjacent(role, -1)}
                                >
                                  <ArrowUpIcon /> Move up
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={!canMoveAdjacent(role, 1)}
                                  onSelect={() => moveAdjacent(role, 1)}
                                >
                                  <ArrowDownIcon /> Move down
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={
                                    role.system ||
                                    count > 0 ||
                                    !authority.canGrant(role)
                                  }
                                  onSelect={() => openDeleteRole(role)}
                                >
                                  <Trash2Icon /> Delete role
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <ul
                aria-label="Organization roles"
                className="divide-y divide-border md:hidden"
              >
                {roles.map((role) => (
                  <li
                    key={role.id}
                    data-role-target={role.id}
                    className={`p-4 ${dropTarget === role.id ? "bg-primary/10 outline-2 outline-primary -outline-offset-2" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      {reorderHandle(role)}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            className="min-h-11 rounded-sm text-left font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`View ${role.name} role`}
                            onClick={(event) => {
                              detailsTrigger.current = event.currentTarget;
                              setSelectedRoleId(role.id);
                            }}
                          >
                            {role.name}
                          </button>
                          {role.system ? (
                            <Badge variant="outline">Built in</Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm leading-5 text-muted-foreground">
                          {role.description}
                        </p>
                        <p className="mt-3 text-xs text-text-muted">
                          {userCounts.get(role.id) ?? 0}{" "}
                          {(userCounts.get(role.id) ?? 0) === 1
                            ? "user"
                            : "users"}{" "}
                          · {role.permissions.length} permissions
                        </p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-11"
                            aria-label={`Manage ${role.name}`}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onSelect={() => openRoleDialog(role)}
                          >
                            <PencilIcon /> Edit role
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => duplicateRole(role)}
                          >
                            <CopyPlusIcon /> Duplicate role
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={!canMoveAdjacent(role, -1)}
                            onSelect={() => moveAdjacent(role, -1)}
                          >
                            <ArrowUpIcon /> Move up
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!canMoveAdjacent(role, 1)}
                            onSelect={() => moveAdjacent(role, 1)}
                          >
                            <ArrowDownIcon /> Move down
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={
                              role.system ||
                              (userCounts.get(role.id) ?? 0) > 0 ||
                              !authority.canGrant(role)
                            }
                            onSelect={() => openDeleteRole(role)}
                          >
                            <Trash2Icon /> Delete role
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-3">
                      <PermissionBadges permissions={role.permissions} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="px-6 py-12 text-center">
              <h2 className="text-base font-semibold">No matching roles</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Try another role name, description, or permission.
              </p>
              <Button
                variant="outline"
                className="mt-4 h-11 sm:h-9"
                onClick={() => setQuery("")}
              >
                Clear search
              </Button>
            </div>
          )}
        </section>
      </div>

      <Sheet
        open={Boolean(selectedRole)}
        onOpenChange={(open) => {
          if (!open) setSelectedRoleId(null);
        }}
      >
        <SheetContent
          className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg motion-reduce:animate-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            detailsTrigger.current?.focus();
          }}
        >
          {selectedRole ? (
            <>
              <SheetHeader className="border-b border-border p-6 pr-12">
                <SheetTitle>{selectedRole.name}</SheetTitle>
                <SheetDescription>
                  {selectedRole.description ||
                    "Review the access granted by this role."}
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-6">
                <p className="text-sm text-muted-foreground">
                  {userCounts.get(selectedRole.id) ?? 0} members ·{" "}
                  {selectedRole.permissions.length} permissions
                </p>
                {selectedRole.system ? (
                  <p className="text-sm text-muted-foreground">
                    Built-in roles cannot be edited, moved, or deleted.
                  </p>
                ) : !authority.canGrant(selectedRole) ? (
                  <p className="text-sm text-muted-foreground">
                    You can only manage roles below your highest role.
                  </p>
                ) : (userCounts.get(selectedRole.id) ?? 0) > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Reassign this role&apos;s members before deleting it.
                  </p>
                ) : null}
                {["Servers", "Community", "Organization"].map((group) => (
                  <section key={group}>
                    <h3 className="mb-2 font-medium">{group}</h3>
                    <ul className="divide-y divide-border">
                      {permissionDefinitions
                        .filter((permission) => permission.group === group)
                        .map((permission) => {
                          const granted = selectedRole.permissions.includes(
                            permission.id,
                          );
                          return (
                            <li
                              key={permission.id}
                              className="flex items-start gap-3 py-3"
                            >
                              {granted ? (
                                <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                              ) : (
                                <MinusIcon className="mt-0.5 size-4 shrink-0 text-text-muted" />
                              )}
                              <div>
                                <p>
                                  {permission.label}
                                  <span className="sr-only">
                                    {granted ? ": Granted" : ": Not granted"}
                                  </span>
                                </p>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                  {permission.description}
                                </p>
                              </div>
                            </li>
                          );
                        })}
                    </ul>
                  </section>
                ))}
              </div>
              <SheetFooter className="border-t border-border p-6">
                <Button
                  disabled={
                    saving ||
                    selectedRole.system ||
                    !authority.canGrant(selectedRole)
                  }
                  onClick={() => {
                    setSelectedRoleId(null);
                    openRoleDialog(selectedRole);
                  }}
                >
                  Edit role
                </Button>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit role" : "Add role"}</DialogTitle>
            <DialogDescription>
              Choose the permissions granted to this role. Saving changes access
              for every member assigned to it. Organization management controls
              users and roles. Other permissions apply as their features become
              available.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <p className="text-sm text-muted-foreground">
              Changes affect {userCounts.get(editing.id) ?? 0} members.
              {editing.system
                ? " Built-in roles cannot be edited."
                : !authority.canGrant(editing)
                  ? " You can only manage roles below your highest role."
                  : ""}
            </p>
          ) : null}
          <RoleFields
            draft={draft}
            error={formError || storageError}
            errorField={formErrorField}
            editingSystemRole={Boolean(editing?.system)}
            lockPermissions={Boolean(
              editing && (editing.system || !authority.canGrant(editing)),
            )}
            onChange={(nextDraft) => {
              setDraft(nextDraft);
              setFormError("");
              setFormErrorField(null);
            }}
          />
          <DialogFooter className="sticky -bottom-6 border-t border-border bg-popover py-4">
            <DialogClose asChild>
              <Button variant="outline" className="h-11 sm:h-9">
                Cancel
              </Button>
            </DialogClose>
            <Button
              className="h-11 sm:h-9"
              disabled={
                saving ||
                Boolean(
                  editing && (editing.system || !authority.canGrant(editing)),
                )
              }
              onClick={saveRole}
            >
              {editing ? "Save role" : "Create role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setDeleteError("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the role from the organization. Reassign its users
              before deleting it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError || storageError ? (
            <Alert variant="destructive">
              <AlertDescription>{deleteError || storageError}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep role</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={saving}
              onClick={deleteRole}
            >
              Delete role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
