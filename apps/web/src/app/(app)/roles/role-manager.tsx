"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  EllipsisIcon,
  LockKeyholeIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import {
  createRoleAction,
  deleteRoleAction,
  updateRoleAction,
} from "@/lib/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
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

export type Role = { id: string; name: string; immutable: boolean; permissions: string[] };
export type PermissionOption = { permission: string; area: string; description: string };

const AREA_LABELS: Record<string, string> = {
  api: "API",
  bans: "Bans",
  billing: "Billing",
  integrations: "Integrations",
  org: "Organization",
  players: "Players",
  roles: "Roles",
  servers: "Servers",
  sites: "Site",
  staff: "Staff",
  store: "Store",
  support: "Support",
};

function permissionGroups(role: Role, permissions: PermissionOption[]) {
  const knownAreas = new Map(permissions.map((permission) => [permission.permission, permission.area]));
  const groups = new Map<string, number>();
  for (const permission of role.permissions) {
    const area = knownAreas.get(permission) ?? permission.split(".")[0] ?? "other";
    groups.set(area, (groups.get(area) ?? 0) + 1);
  }
  return [...groups.entries()];
}

function PermissionSummary({ role, permissions }: { role: Role; permissions: PermissionOption[] }) {
  if (role.permissions.length === 0) {
    return <span className="text-sm text-muted-foreground">No permissions</span>;
  }

  const groups = permissionGroups(role, permissions);
  const visibleGroups = groups.slice(0, 4);
  const extraGroups = groups.length - visibleGroups.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5" title={role.permissions.join(", ")}>
      {visibleGroups.map(([area, count]) => (
        <Badge key={area} variant="outline" className="font-normal text-muted-foreground">
          {AREA_LABELS[area] ?? area} <span className="ms-1 text-foreground">{count}</span>
        </Badge>
      ))}
      {extraGroups > 0 && <span className="text-xs text-muted-foreground">+{extraGroups} more</span>}
      <span className="ms-1 text-xs text-muted-foreground">{role.permissions.length} total</span>
    </div>
  );
}

type SortField = "name" | "permissions";
type SortState = { field: SortField; direction: "asc" | "desc" };

function SortableHead({
  field,
  label,
  sort,
  onSort,
}: {
  field: SortField;
  label: string;
  sort: SortState;
  onSort: (field: SortField) => void;
}) {
  const active = sort.field === field;
  const Icon = !active ? ArrowUpDownIcon : sort.direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <TableHead aria-sort={active ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ms-2 h-7 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => onSort(field)}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <Icon aria-hidden="true" />
      </Button>
    </TableHead>
  );
}

function RoleActions({ role, onEdit, onDelete }: { role: Role; onEdit: (role: Role) => void; onDelete: (role: Role) => void }) {
  if (role.immutable) {
    return (
      <Badge variant="outline" className="border-amber-400/40 bg-amber-400/10 text-amber-200">
        <LockKeyholeIcon aria-hidden="true" />
        Protected
      </Badge>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${role.name}`}>
          <EllipsisIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit(role)}>Edit role</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(role)}>
          <Trash2Icon aria-hidden="true" />
          Delete role
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RoleRow({ role, permissions, onEdit, onDelete }: { role: Role; permissions: PermissionOption[]; onEdit: (role: Role) => void; onDelete: (role: Role) => void }) {
  return (
    <TableRow className={role.immutable ? "bg-amber-400/[0.03]" : undefined}>
      <TableCell className="min-w-56">
        <div className="flex items-center gap-2">
          {role.immutable && <LockKeyholeIcon className="size-4 shrink-0 text-amber-200" aria-hidden="true" />}
          <div className="min-w-0">
            <p className="truncate font-medium">{role.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {role.immutable ? "Full access" : `${role.permissions.length} permission${role.permissions.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell className="min-w-96 whitespace-normal">
        <PermissionSummary role={role} permissions={permissions} />
      </TableCell>
      <TableCell className="w-28 text-end">
        <RoleActions role={role} onEdit={onEdit} onDelete={onDelete} />
      </TableCell>
    </TableRow>
  );
}

function PermissionPicker({ permissions, selected, onChange }: { permissions: PermissionOption[]; selected: string[]; onChange: (permission: string, checked: boolean) => void }) {
  const groups = useMemo(() => permissions.reduce<Record<string, PermissionOption[]>>((result, permission) => {
    (result[permission.area] ??= []).push(permission);
    return result;
  }, {}), [permissions]);

  return (
    <FieldSet className="gap-3">
      <div>
        <FieldLegend>Permissions</FieldLegend>
        <FieldDescription>Select the access this role grants.</FieldDescription>
      </div>
      <FieldGroup className="grid gap-5 sm:grid-cols-2">
        {Object.entries(groups).map(([area, areaPermissions]) => (
          <FieldSet key={area} className="gap-2">
            <FieldLegend variant="label" className="text-xs uppercase tracking-wide text-muted-foreground">
              {AREA_LABELS[area] ?? area}
            </FieldLegend>
            <FieldGroup className="gap-2">
              {areaPermissions.map((permission) => {
                const id = `permission-${permission.permission.replaceAll(".", "-")}`;
                const checked = selected.includes(permission.permission);
                return (
                  <Field key={permission.permission} orientation="horizontal" className="rounded-lg border border-border px-3 py-2.5 hover:bg-muted/40">
                    <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(permission.permission, value === true)} />
                    <FieldContent>
                      <FieldLabel htmlFor={id}>{permission.permission}</FieldLabel>
                      <FieldDescription className="text-xs">{permission.description}</FieldDescription>
                    </FieldContent>
                  </Field>
                );
              })}
            </FieldGroup>
          </FieldSet>
        ))}
      </FieldGroup>
    </FieldSet>
  );
}

function RoleForm({ mode, role, permissions, onClose }: { mode: "create" | "edit"; role?: Role; permissions: PermissionOption[]; onClose: () => void }) {
  const action = mode === "create" ? createRoleAction : updateRoleAction;
  const [state, formAction, pending] = useActionState(action, {});
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? []);

  useEffect(() => {
    if (state.ok) onClose();
  }, [onClose, state.ok]);

  function togglePermission(permission: string, checked: boolean) {
    setSelected((current) => checked ? [...current, permission] : current.filter((value) => value !== permission));
  }

  return (
    <form action={formAction}>
      {mode === "edit" && <input type="hidden" name="role_id" value={role?.id} />}
      {selected.map((permission) => <input key={permission} type="hidden" name="permission" value={permission} />)}
      <div className="max-h-[min(65vh,38rem)] space-y-6 overflow-y-auto pe-1">
        <Field>
          <FieldLabel htmlFor="role-name">Role name</FieldLabel>
          <Input id="role-name" name="name" defaultValue={role?.name} placeholder="e.g. Community lead" required maxLength={80} autoFocus />
        </Field>
        <PermissionPicker permissions={permissions} selected={selected} onChange={togglePermission} />
        {state.error && <FieldError>{state.error}</FieldError>}
      </div>
      <DialogFooter className="mt-6">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner />}
          {pending ? "Saving…" : mode === "create" ? "Create role" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteRoleDialog({ role, onClose }: { role?: Role; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(deleteRoleAction, {});

  useEffect(() => {
    if (state.ok && role) onClose();
  }, [onClose, role, state.ok]);

  return (
    <AlertDialog open={Boolean(role)} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {role?.name}?</AlertDialogTitle>
          <AlertDialogDescription>This removes the role and its assignments. Anyone using it will lose that access. This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {state.error && <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>}
        <form action={formAction}>
          <input type="hidden" name="role_id" value={role?.id} />
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Keep role</AlertDialogCancel>
            <AlertDialogAction type="submit" variant="destructive" disabled={pending}>
              {pending && <Spinner />}
              {pending ? "Deleting…" : "Delete role"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RoleManager({ roles, permissions }: { roles: Role[]; permissions: PermissionOption[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<SortState>({ field: "name", direction: "asc" });
  const [dialog, setDialog] = useState<"create" | Role | null>(null);
  const [deletingRole, setDeletingRole] = useState<Role>();
  const normalizedQuery = query.trim().toLowerCase();
  const filteredRoles = useMemo(() => {
    const matchingRoles = roles.filter((role) => !normalizedQuery || role.name.toLowerCase().includes(normalizedQuery) || role.permissions.some((permission) => permission.toLowerCase().includes(normalizedQuery)));
    return [...matchingRoles].sort((a, b) => {
      const comparison = sort.field === "name"
        ? a.name.localeCompare(b.name)
        : a.permissions.length - b.permissions.length;
      return sort.direction === "asc" ? comparison : -comparison;
    });
  }, [normalizedQuery, roles, sort]);
  const totalPages = Math.max(1, Math.ceil(filteredRoles.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const firstRow = filteredRoles.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastRow = Math.min(currentPage * pageSize, filteredRoles.length);
  const pageRoles = filteredRoles.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const editingRole = dialog && dialog !== "create" ? dialog : undefined;

  function closeAndRefresh() {
    setDialog(null);
    router.refresh();
  }

  function closeDeleteAndRefresh() {
    setDeletingRole(undefined);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search roles or permissions" aria-label="Search roles or permissions" className="h-9 ps-8" />
        </div>
        <Button onClick={() => setDialog("create")}><PlusIcon aria-hidden="true" />New role</Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {filteredRoles.length === 0 ? (
          <Empty className="min-h-64 rounded-none border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ShieldCheckIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{roles.length === 0 ? "No roles yet" : "No matching roles"}</EmptyTitle>
              <EmptyDescription>{roles.length === 0 ? "Create a role to define reusable organization access." : "Try a different search."}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {roles.length === 0 ? <Button onClick={() => setDialog("create")}><PlusIcon aria-hidden="true" />New role</Button> : <Button variant="outline" onClick={() => setQuery("")}>Clear search</Button>}
            </EmptyContent>
          </Empty>
        ) : (
          <Table className="min-w-[42rem]">
            <TableCaption className="sr-only">Organization roles and their permissions</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortableHead field="name" label="Role" sort={sort} onSort={(field) => { setPage(1); setSort((current) => current.field === field ? { field, direction: current.direction === "asc" ? "desc" : "asc" } : { field, direction: "asc" }); }} />
                <SortableHead field="permissions" label="Permissions" sort={sort} onSort={(field) => { setPage(1); setSort((current) => current.field === field ? { field, direction: current.direction === "asc" ? "desc" : "asc" } : { field, direction: "asc" }); }} />
                <TableHead className="w-28 text-end">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRoles.map((role) => <RoleRow key={role.id} role={role} permissions={permissions} onEdit={setDialog} onDelete={setDeletingRole} />)}
            </TableBody>
          </Table>
        )}
      </div>

      {filteredRoles.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}>
              <SelectTrigger size="sm" className="w-16" aria-label="Rows per page"><SelectValue /></SelectTrigger>
              <SelectContent side="top">
                <SelectGroup>
                  {[10, 25, 50].map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            <span className="tabular-nums">{firstRow}–{lastRow} of {filteredRoles.length}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" onClick={() => setPage(1)} disabled={currentPage === 1} aria-label="Go to first page" className="hidden sm:inline-flex"><ChevronsLeftIcon aria-hidden="true" /></Button>
            <Button variant="outline" size="icon-sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage === 1} aria-label="Go to previous page"><ChevronLeftIcon aria-hidden="true" /></Button>
            <span className="min-w-20 text-center text-xs tabular-nums">Page {currentPage} of {totalPages}</span>
            <Button variant="outline" size="icon-sm" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={currentPage === totalPages} aria-label="Go to next page"><ChevronRightIcon aria-hidden="true" /></Button>
            <Button variant="outline" size="icon-sm" onClick={() => setPage(totalPages)} disabled={currentPage === totalPages} aria-label="Go to last page" className="hidden sm:inline-flex"><ChevronsRightIcon aria-hidden="true" /></Button>
          </div>
        </div>
      )}

      <Dialog open={Boolean(dialog)} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dialog === "create" ? "Create a role" : `Edit ${editingRole?.name}`}</DialogTitle>
            <DialogDescription>{dialog === "create" ? "Define a reusable set of permissions." : "Changes apply to everyone assigned to this role."}</DialogDescription>
          </DialogHeader>
          {dialog && <RoleForm key={dialog === "create" ? "create" : dialog.id} mode={dialog === "create" ? "create" : "edit"} role={editingRole} permissions={permissions} onClose={closeAndRefresh} />}
        </DialogContent>
      </Dialog>
      <DeleteRoleDialog role={deletingRole} onClose={closeDeleteAndRefresh} />
    </div>
  );
}
