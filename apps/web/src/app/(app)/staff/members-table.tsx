"use client";

import { useEffect, useMemo, useState } from "react";
import {
  MailPlusIcon,
  MailCheckIcon,
  Rows3Icon,
  SearchIcon,
  ShieldCheckIcon,
  UserCheckIcon,
  UsersIcon,
  UserRoundPlusIcon,
  XIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
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
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InviteForm } from "./invite-form";
import { MemberActions } from "./member-actions";
import { PendingInvitesDialog, type PendingInvite } from "./pending-invites-dialog";

export type StaffMember = {
  membership_id: string;
  display_name: string;
  nickname?: string | null;
  email: string | null;
  status: string;
  roles: string[];
};

type Role = { id: string; name: string };

function initialsFor(member: StaffMember) {
  const name = member.nickname || member.display_name;
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function statusClass(status: string) {
  return status.toLowerCase() === "active"
    ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
    : "border-amber-300/25 bg-amber-300/10 text-amber-200";
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: number;
  detail: string;
  icon: typeof UsersIcon;
}) {
  return (
    <Card className="border border-border bg-card shadow-none ring-0">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4" aria-hidden="true" />
          </span>
        </div>
        <div>
          <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function MembersTable({
  members,
  roles,
  invites,
}: {
  members: StaffMember[];
  roles: Role[];
  invites: PendingInvite[];
}) {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("auto");
  const [autoPageSize, setAutoPageSize] = useState(10);

  useEffect(() => {
    const updateAutoPageSize = () => {
      setAutoPageSize(Math.max(5, Math.min(50, Math.floor((window.innerHeight - 560) / 56))));
    };
    updateAutoPageSize();
    window.addEventListener("resize", updateAutoPageSize);
    return () => window.removeEventListener("resize", updateAutoPageSize);
  }, []);

  const filteredMembers = useMemo(() => {
    const query = search.trim().toLowerCase();
    const selectedRoleName = roles.find((role) => role.id === roleFilter)?.name;
    return members.filter((member) => {
      const matchesQuery =
        !query ||
        [member.display_name, member.nickname ?? "", member.email ?? "", ...member.roles].some(
          (value) => value.toLowerCase().includes(query),
        );
      const matchesRole = roleFilter === "all" || Boolean(selectedRoleName && member.roles.includes(selectedRoleName));
      return matchesQuery && matchesRole;
    });
  }, [members, roleFilter, roles, search]);

  const pageSizeNumber = pageSize === "auto" ? autoPageSize : Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(filteredMembers.length / pageSizeNumber));
  const currentPage = Math.min(page, pageCount);
  const pageMembers = filteredMembers.slice(
    (currentPage - 1) * pageSizeNumber,
    currentPage * pageSizeNumber,
  );
  const filtersActive = search.trim().length > 0 || roleFilter !== "all";

  function clearFilters() {
    setSearch("");
    setRoleFilter("all");
    setPage(1);
  }

  function memberRoles(member: StaffMember) {
    return member.roles.length > 0 ? (
      member.roles.map((role) => (
        <Badge key={role} variant="outline" className="border-primary/20 bg-primary/5 text-primary/90">
          {role}
        </Badge>
      ))
    ) : (
      <span className="text-sm text-muted-foreground">No role assigned</span>
    );
  }

  return (
    <div className="space-y-5">
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Member metrics">
        <MetricCard label="Total members" value={members.length} detail="Current organization" icon={UsersIcon} />
        <MetricCard label="Active members" value={members.filter((member) => member.status.toLowerCase() === "active").length} detail="Access enabled" icon={UserCheckIcon} />
        <MetricCard label="Pending invites" value={invites.length} detail="Awaiting response" icon={MailCheckIcon} />
        <MetricCard label="Available roles" value={roles.length} detail="Reusable access policies" icon={ShieldCheckIcon} />
      </section>

      <Card className="gap-0 overflow-hidden border border-border bg-card shadow-none ring-0">
        <CardContent className="border-b border-border bg-surface-subtle p-4">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <InputGroup className="lg:max-w-xl lg:flex-1">
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Search by name, email, or role"
                aria-label="Search members"
              />
              {search && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    onClick={() => {
                      setSearch("");
                    }}
                    aria-label="Clear search"
                  >
                    <XIcon aria-hidden="true" />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            <Select
              value={roleFilter}
              onValueChange={(value) => {
                setRoleFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full lg:w-44" aria-label="Filter members by role">
                <SelectValue placeholder="All roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {filtersActive && (
              <Button type="button" variant="ghost" onClick={clearFilters}>
                <XIcon aria-hidden="true" />
                Clear filters
              </Button>
            )}
            <div className="flex items-center gap-2 lg:ms-auto">
              <PendingInvitesDialog invites={invites} roles={roles} />
              <Dialog>
                <DialogTrigger asChild>
                  <Button>
                    <UserRoundPlusIcon aria-hidden="true" />
                    <span className="hidden sm:inline">Invite member</span>
                    <span className="sm:hidden">Invite</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Invite a member</DialogTitle>
                    <DialogDescription>Give a teammate access now. You can change their roles at any time.</DialogDescription>
                  </DialogHeader>
                  <InviteForm roles={roles} />
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardContent>

        {filteredMembers.length === 0 ? (
          <CardContent className="p-6">
            <Empty className="min-h-56 border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">{filtersActive ? <SearchIcon aria-hidden="true" /> : <MailPlusIcon aria-hidden="true" />}</EmptyMedia>
                <EmptyTitle>{filtersActive ? "No matching members" : "No members yet"}</EmptyTitle>
                <EmptyDescription>{filtersActive ? "Try a different name, email address, or role filter." : "Invite your first teammate to start collaborating."}</EmptyDescription>
              </EmptyHeader>
              {filtersActive && <Button type="button" variant="outline" onClick={clearFilters}>Clear filters</Button>}
            </Empty>
          </CardContent>
        ) : (
          <>
            <CardContent className="hidden p-0 md:block">
            <Table>
                <TableHeader>
                  <TableRow className="bg-surface-subtle hover:bg-surface-subtle">
                    <TableHead>Member</TableHead>
                    <TableHead>Roles</TableHead>
                    <TableHead className="w-24">Status</TableHead>
                    <TableHead className="w-14 pe-5 text-end"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageMembers.map((member) => (
                    <TableRow key={member.membership_id} className="hover:bg-muted/30">
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar className="size-9"><AvatarFallback className="text-xs">{initialsFor(member)}</AvatarFallback></Avatar>
                          <div className="min-w-0"><div className="truncate font-medium">{member.nickname || member.display_name}</div><div className="truncate text-xs text-muted-foreground">{member.nickname ? `${member.display_name} · ` : ""}{member.email ?? "No email address"}</div></div>
                        </div>
                      </TableCell>
                      <TableCell><div className="flex flex-wrap gap-1.5">{memberRoles(member)}</div></TableCell>
                      <TableCell><Badge variant="outline" className={`capitalize ${statusClass(member.status)}`}>{member.status}</Badge></TableCell>
                      <TableCell className="pe-5 text-end"><MemberActions member={member} roles={roles} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
            <CardContent className="p-4 md:hidden">
              <ItemGroup className="gap-2">
                {pageMembers.map((member) => (
                    <Item key={member.membership_id} role="listitem" variant="outline" className="border-border bg-surface-subtle/50">
                    <ItemMedia><Avatar className="size-9"><AvatarFallback className="text-xs">{initialsFor(member)}</AvatarFallback></Avatar></ItemMedia>
                    <ItemContent className="min-w-0"><ItemTitle className="max-w-full"><span className="truncate">{member.nickname || member.display_name}</span><Badge variant="outline" className={`capitalize ${statusClass(member.status)}`}>{member.status}</Badge></ItemTitle><ItemDescription className="truncate">{member.email ?? "No email address"}</ItemDescription></ItemContent>
                    <ItemActions><MemberActions member={member} roles={roles} /></ItemActions>
                    <ItemFooter className="justify-start ps-16"><div className="flex flex-wrap gap-1.5">{memberRoles(member)}</div></ItemFooter>
                  </Item>
                ))}
              </ItemGroup>
            </CardContent>
          </>
        )}

        {filteredMembers.length > 0 && (
          <CardFooter className="relative flex-col gap-3 border-t border-border bg-surface-subtle py-3 sm:flex-row sm:justify-center">
            <div className="flex w-full items-center justify-between gap-3 sm:absolute sm:start-4 sm:w-auto sm:justify-start">
              <Field orientation="horizontal" className="w-auto gap-2">
                <FieldLabel htmlFor="members-page-size" className="sr-only">Rows per page</FieldLabel>
                <Select value={pageSize} onValueChange={(value) => { setPageSize(value); setPage(1); }}>
                  <SelectTrigger id="members-page-size" className="w-20" aria-label="Rows per page"><Rows3Icon className="text-muted-foreground" aria-hidden="true" /><SelectValue /></SelectTrigger>
                  <SelectContent className="w-20" position="popper" align="start"><SelectItem value="auto">{autoPageSize}</SelectItem><SelectItem value="10">10</SelectItem><SelectItem value="25">25</SelectItem><SelectItem value="50">50</SelectItem></SelectContent>
                </Select>
              </Field>
            </div>
            <Pagination className="mx-0 w-auto justify-center"><PaginationContent><PaginationItem><PaginationPrevious href="#" aria-disabled={currentPage === 1} tabIndex={currentPage === 1 ? -1 : undefined} className={currentPage === 1 ? "pointer-events-none opacity-50" : undefined} onClick={(event) => { event.preventDefault(); if (currentPage > 1) setPage(currentPage - 1); }} /></PaginationItem><PaginationItem><span className="px-2 text-sm text-muted-foreground" aria-live="polite">Page {currentPage} of {pageCount}</span></PaginationItem><PaginationItem><PaginationNext href="#" aria-disabled={currentPage === pageCount} tabIndex={currentPage === pageCount ? -1 : undefined} className={currentPage === pageCount ? "pointer-events-none opacity-50" : undefined} onClick={(event) => { event.preventDefault(); if (currentPage < pageCount) setPage(currentPage + 1); }} /></PaginationItem></PaginationContent></Pagination>
          </CardFooter>
        )}
      </Card>

    </div>
  );
}
