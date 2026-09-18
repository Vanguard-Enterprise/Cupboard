"use client";

import { useMemo, useState } from "react";
import {
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

type RoleSort = "name" | "users" | "permissions";
type RoleDraft = Pick<OrganizationRole, "name" | "description" | "permissions">;

const emptyDraft: RoleDraft = {
  name: "",
  description: "",
  permissions: [],
};

function PermissionBadges({ permissions }: { permissions: PermissionId[] }) {
  const definitions = permissionDefinitions.filter(({ id }) =>
    permissions.includes(id),
  );
  return (
    <div className="flex max-w-lg flex-wrap gap-1.5">
      {definitions.slice(0, 3).map((permission) => (
        <Badge key={permission.id} variant="secondary">
          {permission.label}
        </Badge>
      ))}
      {definitions.length > 3 ? (
        <Badge variant="outline">+{definitions.length - 3}</Badge>
      ) : null}
    </div>
  );
}

function RoleFields({
  draft,
  error,
  editingSystemRole,
  lockPermissions,
  onChange,
}: {
  draft: RoleDraft;
  error: string;
  editingSystemRole: boolean;
  lockPermissions: boolean;
  onChange: (draft: RoleDraft) => void;
}) {
  const groups = ["Servers", "Community", "Organization"] as const;
  return (
    <div className="grid gap-5">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="role-name">Role name</Label>
        <Input
          id="role-name"
          value={draft.name}
          disabled={editingSystemRole}
          className="h-11 sm:h-10"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          autoFocus={!editingSystemRole}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="role-description">Description</Label>
        <Textarea
          id="role-description"
          value={draft.description}
          className="min-h-[88px] resize-none"
          onChange={(event) =>
            onChange({ ...draft, description: event.target.value })
          }
        />
      </div>
      <fieldset disabled={lockPermissions} className="grid gap-4">
        <legend className="text-sm font-medium">Permissions</legend>
        {groups.map((group) => (
          <div key={group} className="grid gap-2">
            <p className="text-xs font-medium text-text-muted">{group}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {permissionDefinitions
                .filter((permission) => permission.group === group)
                .map((permission) => {
                  const checked = draft.permissions.includes(permission.id);
                  return (
                    <label
                      key={permission.id}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-input-background p-3 has-disabled:cursor-not-allowed has-disabled:opacity-60"
                    >
                      <Checkbox
                        disabled={lockPermissions}
                        checked={checked}
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
      </fieldset>
      {lockPermissions ? (
        <p className="text-xs leading-5 text-muted-foreground">
          The Owner role always has every permission.
        </p>
      ) : null}
    </div>
  );
}

export function OrganizationRoles() {
  const { ready, settings, storageError, clearStorageError, save } =
    useOrganizationTeam();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RoleSort>("name");
  const [direction, setDirection] = useState<SortDirection>("asc");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<OrganizationRole | null>(null);
  const [draft, setDraft] = useState<RoleDraft>(emptyDraft);
  const [formError, setFormError] = useState("");
  const [deleting, setDeleting] = useState<OrganizationRole | null>(null);
  const userCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const user of settings.users)
      counts.set(user.roleId, (counts.get(user.roleId) ?? 0) + 1);
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
      if (sort === "name") result = left.name.localeCompare(right.name);
      if (sort === "users")
        result =
          (userCounts.get(left.id) ?? 0) - (userCounts.get(right.id) ?? 0);
      if (sort === "permissions")
        result = left.permissions.length - right.permissions.length;
      return direction === "asc" ? result : -result;
    });
  }, [direction, query, settings.roles, sort, userCounts]);

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

  function saveRole() {
    const normalizedName = draft.name.trim();
    if (!normalizedName) {
      setFormError("Enter a role name.");
      return;
    }
    if (!draft.description.trim()) {
      setFormError("Describe what this role is for.");
      return;
    }
    if (!draft.permissions.length) {
      setFormError("Choose at least one permission.");
      return;
    }
    if (
      settings.roles.some(
        (role) =>
          role.id !== editing?.id &&
          role.name.toLowerCase() === normalizedName.toLowerCase(),
      )
    ) {
      setFormError("A role with this name already exists.");
      return;
    }

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
        };
    const nextRoles = editing
      ? settings.roles.map((role) => (role.id === editing.id ? nextRole : role))
      : [...settings.roles, nextRole];
    if (save({ ...settings, roles: nextRoles })) {
      setDialogOpen(false);
      toast.success(editing ? "Role updated." : "Role created.");
    }
  }

  function duplicateRole(role: OrganizationRole) {
    clearStorageError();
    setEditing(null);
    setFormError("");
    setDraft({
      name: `${role.name} copy`,
      description: role.description,
      permissions: [...role.permissions],
    });
    setDialogOpen(true);
  }

  function deleteRole() {
    if (!deleting || deleting.system || (userCounts.get(deleting.id) ?? 0) > 0)
      return;
    if (
      save({
        ...settings,
        roles: settings.roles.filter((role) => role.id !== deleting.id),
      })
    ) {
      toast.success(`${deleting.name} deleted.`);
      setDeleting(null);
    }
  }

  const resultLabel = `${roles.length} ${roles.length === 1 ? "role" : "roles"}`;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Roles</h1>
        <Button className="h-11 sm:h-9" onClick={() => openRoleDialog()}>
          <PlusIcon /> Add role
        </Button>
      </div>
      <div className="space-y-4">
        {storageError ? (
          <Alert variant="destructive">
            <AlertDescription>{storageError}</AlertDescription>
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
                className="h-11 w-full bg-input-background md:hidden"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
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

          {roles.length ? (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableCaption className="sr-only">
                    Organization roles and permissions
                  </TableCaption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
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
                          label="Users"
                          active={sort === "users"}
                          direction={direction}
                          onClick={() => changeSort("users")}
                        />
                      </TableHead>
                      <TableHead>
                        <SortButton
                          label="Permissions"
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
                        <TableRow key={role.id}>
                          <TableCell className="max-w-sm px-4 py-3 whitespace-normal">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{role.name}</span>
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
                                  variant="destructive"
                                  disabled={role.system || count > 0}
                                  onSelect={() => setDeleting(role)}
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

              <ul className="divide-y divide-border md:hidden">
                {roles.map((role) => (
                  <li key={role.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{role.name}</p>
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
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-11"
                        aria-label={`Edit ${role.name}`}
                        onClick={() => openRoleDialog(role)}
                      >
                        <PencilIcon />
                      </Button>
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
              Choose what this role can see and change.
            </DialogDescription>
          </DialogHeader>
          <RoleFields
            draft={draft}
            error={formError || storageError}
            editingSystemRole={Boolean(editing?.system)}
            lockPermissions={editing?.id === "owner"}
            onChange={(nextDraft) => {
              setDraft(nextDraft);
              setFormError("");
            }}
          />
          <DialogFooter className="sticky bottom-0">
            <DialogClose asChild>
              <Button variant="outline" className="h-11 sm:h-9">
                Cancel
              </Button>
            </DialogClose>
            <Button className="h-11 sm:h-9" onClick={saveRole}>
              {editing ? "Save role" : "Create role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the role from this browser-local preview. You cannot
              undo this action.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep role</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteRole}>
              Delete role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
