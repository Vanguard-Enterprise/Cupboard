"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MailIcon, PencilIcon, SearchIcon, XIcon } from "lucide-react";
import { cancelInviteAction, updateInviteRolesAction } from "@/lib/actions";
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
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type PendingInvite = {
  id: string;
  email: string;
  status: string;
  expires_at?: string;
  role_ids?: string[];
  roles?: string[];
};

type Role = { id: string; name: string };

export function PendingInvitesDialog({
  invites,
  roles,
}: {
  invites: PendingInvite[];
  roles: Role[];
}) {
  const [pendingOpen, setPendingOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [roleDialogInvite, setRoleDialogInvite] = useState<PendingInvite | null>(null);
  const [roleSelection, setRoleSelection] = useState("none");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [cancelTargets, setCancelTargets] = useState<PendingInvite[]>([]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelPending, startCancelTransition] = useTransition();
  const [rolePending, startRoleTransition] = useTransition();
  const router = useRouter();

  const filteredInvites = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return invites;
    return invites.filter((invite) =>
      [invite.email, ...(invite.roles ?? [])].some((value) => value.toLowerCase().includes(query)),
    );
  }, [invites, search]);

  const visibleIds = useMemo(() => filteredInvites.map((invite) => invite.id), [filteredInvites]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someSelected = visibleIds.some((id) => selectedIds.has(id)) && !allSelected;
  const selectedInvites = useMemo(() => {
    return invites.filter((invite) => selectedIds.has(invite.id));
  }, [invites, selectedIds]);

  function selectAll(checked: boolean | "indeterminate") {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (checked === true) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function selectInvite(id: string, checked: boolean | "indeterminate") {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked === true) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function openRoleDialog(invite: PendingInvite) {
    setRoleError(null);
    setRoleSelection(invite.role_ids?.[0] ?? "none");
    setPendingOpen(false);
    setRoleDialogInvite(invite);
  }

  function openCancelDialog(targets: PendingInvite[]) {
    setCancelError(null);
    setPendingOpen(false);
    setCancelTargets(targets);
  }

  function saveRole() {
    if (!roleDialogInvite) return;
    const form = new FormData();
    form.set("invite_id", roleDialogInvite.id);
    form.set("role_id", roleSelection);
    setRoleError(null);
    startRoleTransition(async () => {
      const result = await updateInviteRolesAction({}, form);
      if (result.error) {
        setRoleError(result.error);
        return;
      }
      setRoleDialogInvite(null);
      router.refresh();
    });
  }

  function cancelInvites() {
    if (cancelTargets.length === 0) return;
    const form = new FormData();
    cancelTargets.forEach((invite) => form.append("invite_id", invite.id));
    setCancelError(null);
    startCancelTransition(async () => {
      const result = await cancelInviteAction({}, form);
      if (result.error) {
        setCancelError(result.error);
        return;
      }
      setSelectedIds(new Set());
      setCancelTargets([]);
      router.refresh();
    });
  }

  return (
    <>
      <Dialog open={pendingOpen} onOpenChange={setPendingOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" aria-label={`${invites.length} pending invitations`}>
            <MailIcon aria-hidden="true" />
            <span className="hidden lg:inline">Pending</span>
            {invites.length > 0 && <Badge variant="secondary">{invites.length}</Badge>}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Pending invitations</DialogTitle>
            <DialogDescription>
              Review invitations that have not been accepted yet, update access, or cancel them.
            </DialogDescription>
          </DialogHeader>

          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelectedIds(new Set());
              }}
              placeholder="Search by email or role"
              aria-label="Search pending invitations"
            />
            {search && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  onClick={() => {
                    setSearch("");
                    setSelectedIds(new Set());
                  }}
                  aria-label="Clear search"
                >
                  <XIcon aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>

          {filteredInvites.length === 0 ? (
            <Empty className="min-h-56 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {search ? <SearchIcon aria-hidden="true" /> : <MailIcon aria-hidden="true" />}
                </EmptyMedia>
                <EmptyTitle>{search ? "No matching invitations" : "No pending invitations"}</EmptyTitle>
                <EmptyDescription>
                  {search
                    ? "Try searching with a different email address or role."
                    : "New invitations will appear here until they are accepted or cancelled."}
                </EmptyDescription>
              </EmptyHeader>
              {search && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSearch("");
                    setSelectedIds(new Set());
                  }}
                >
                  Clear search
                </Button>
              )}
            </Empty>
          ) : (
            <div className="max-h-[min(28rem,60vh)] overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12 ps-4">
                      <Checkbox
                        aria-label="Select all visible pending invitations"
                        checked={someSelected ? "indeterminate" : allSelected}
                        onCheckedChange={selectAll}
                      />
                    </TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="hidden sm:table-cell">Role</TableHead>
                    <TableHead className="w-24 pe-4 text-end">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInvites.map((invite) => (
                    <TableRow
                      key={invite.id}
                      data-state={selectedIds.has(invite.id) ? "selected" : undefined}
                    >
                      <TableCell className="ps-4">
                        <Checkbox
                          aria-label={`Select invitation for ${invite.email}`}
                          checked={selectedIds.has(invite.id)}
                          onCheckedChange={(checked) => selectInvite(invite.id, checked)}
                        />
                      </TableCell>
                      <TableCell className="max-w-48 truncate font-medium sm:max-w-none">
                        {invite.email}
                        <div className="mt-1 sm:hidden">
                          <Badge variant="secondary">{invite.roles?.[0] ?? "No role"}</Badge>
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="secondary">{invite.roles?.[0] ?? "No role"}</Badge>
                      </TableCell>
                      <TableCell className="pe-4 text-end">
                        <div className="flex items-center justify-end gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Edit role for ${invite.email}`}
                                onClick={() => openRoleDialog(invite)}
                              >
                                <PencilIcon aria-hidden="true" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Edit invited role</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                aria-label={`Cancel invitation for ${invite.email}`}
                                disabled={cancelPending}
                                onClick={() => openCancelDialog([invite])}
                              >
                                <XIcon aria-hidden="true" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Cancel invitation</TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <DialogFooter showCloseButton>
            <Button
              type="button"
              variant="destructive"
              disabled={selectedInvites.length === 0 || cancelPending}
              onClick={() => openCancelDialog(selectedInvites)}
            >
              Cancel selected ({selectedInvites.length})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={roleDialogInvite !== null}
        onOpenChange={(open) => {
          if (!open && !rolePending) {
            setRoleDialogInvite(null);
            setRoleError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit invited role</DialogTitle>
            <DialogDescription>{roleDialogInvite?.email}</DialogDescription>
          </DialogHeader>
          <Select value={roleSelection} onValueChange={setRoleSelection} disabled={rolePending}>
            <SelectTrigger aria-label="Invited role">
              <SelectValue placeholder="No role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No role</SelectItem>
              {roles.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  {role.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {roleError && (
            <Alert variant="destructive" aria-live="assertive">
              <AlertDescription>{roleError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialogInvite(null)} disabled={rolePending}>
              Cancel
            </Button>
            <Button onClick={saveRole} disabled={rolePending}>
              {rolePending && <Spinner />}
              {rolePending ? "Saving role…" : "Save role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={cancelTargets.length > 0}
        onOpenChange={(open) => {
          if (!open && !cancelPending) {
            setCancelTargets([]);
            setCancelError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Cancel {cancelTargets.length === 1 ? "this invitation" : `${cancelTargets.length} invitations`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTargets.length === 1
                ? `${cancelTargets[0]?.email} will no longer be able to use this invitation link.`
                : "The selected invitation links will stop working immediately."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cancelError && (
            <Alert variant="destructive" aria-live="assertive">
              <AlertDescription>{cancelError}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelPending}>Keep invitations</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={cancelPending}
              onClick={(event) => {
                event.preventDefault();
                cancelInvites();
              }}
            >
              {cancelPending && <Spinner />}
              {cancelPending ? "Cancelling…" : "Cancel invitations"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
