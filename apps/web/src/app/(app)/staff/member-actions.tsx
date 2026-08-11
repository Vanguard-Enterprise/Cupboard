"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  EyeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  UserRoundMinusIcon,
  UserRoundPlusIcon,
} from "lucide-react";
import { updateMemberNicknameAction, updateMemberRolesAction, removeMemberAction } from "@/lib/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

type Role = { id: string; name: string };

export function MemberActions({
  member,
  roles,
}: {
  member: {
    membership_id: string;
    display_name: string;
    nickname?: string | null;
    email: string | null;
    status: string;
    roles: string[];
  };
  roles: Role[];
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"profile" | "roles" | "nickname" | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [nickname, setNickname] = useState(member.nickname ?? "");
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>(() =>
    roles.filter((role) => member.roles.includes(role.name)).map((role) => role.id),
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(action: typeof updateMemberRolesAction | typeof updateMemberNicknameAction | typeof removeMemberAction, fields: Record<string, string | string[]>) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) value.forEach((item) => form.append(key, item));
      else form.set(key, value);
    }
    setError(null);
    startTransition(async () => {
      const result = await action({}, form);
      if (result.error) {
        setError(result.error);
        return;
      }
      setDialog(null);
      setRemoveOpen(false);
      router.refresh();
    });
  }

  function toggleRole(id: string, checked: boolean | "indeterminate") {
    setSelectedRoleIds((current) =>
      checked === true ? [...new Set([...current, id])] : current.filter((value) => value !== id),
    );
  }

  function openDialog(nextDialog: "profile" | "roles" | "nickname") {
    setError(null);
    setNickname(member.nickname ?? "");
    setSelectedRoleIds(
      roles.filter((role) => member.roles.includes(role.name)).map((role) => role.id),
    );
    setDialog(nextDialog);
  }

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.display_name}`}>
                <MoreHorizontalIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Member actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openDialog("profile")}>
            <EyeIcon aria-hidden="true" /> View profile
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog("roles")}>
            <PencilIcon aria-hidden="true" /> Edit roles
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog("nickname")}>
            <UserRoundPlusIcon aria-hidden="true" /> {member.nickname ? "Edit nickname" : "Add nickname"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => { setError(null); setRemoveOpen(true); }}>
            <UserRoundMinusIcon aria-hidden="true" /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog === "profile"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{member.nickname || member.display_name}</DialogTitle>
            <DialogDescription>Organization membership profile</DialogDescription>
          </DialogHeader>
          <dl className="grid gap-3 text-sm">
            <div><dt className="text-muted-foreground">Account name</dt><dd>{member.display_name}</dd></div>
            <div><dt className="text-muted-foreground">Email</dt><dd>{member.email ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">Status</dt><dd className="mt-1"><Badge variant="outline" className="capitalize">{member.status}</Badge></dd></div>
            <div><dt className="text-muted-foreground">Roles</dt><dd className="mt-1 flex flex-wrap gap-1.5">{member.roles.length ? member.roles.map((role) => <Badge key={role} variant="secondary">{role}</Badge>) : "No role"}</dd></div>
          </dl>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "roles"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit roles</DialogTitle>
            <DialogDescription>Choose the roles this member has in the organization.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-2">
            {roles.length > 0 ? roles.map((role) => (
              <Field key={role.id} orientation="horizontal">
                <Checkbox
                  id={`member-${member.membership_id}-role-${role.id}`}
                  checked={selectedRoleIds.includes(role.id)}
                  onCheckedChange={(checked) => toggleRole(role.id, checked)}
                />
                <FieldLabel htmlFor={`member-${member.membership_id}-role-${role.id}`}>
                  {role.name}
                </FieldLabel>
              </Field>
            )) : <FieldDescription>No roles are available.</FieldDescription>}
          </FieldGroup>
          {error && <Alert variant="destructive" aria-live="assertive"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={isPending}>Cancel</Button>
            <Button disabled={isPending} onClick={() => submit(updateMemberRolesAction, { membership_id: member.membership_id, role_id: selectedRoleIds })}>
              {isPending && <Spinner />}
              {isPending ? "Saving roles…" : "Save roles"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "nickname"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{member.nickname ? "Edit nickname" : "Add nickname"}</DialogTitle>
            <DialogDescription>This nickname is visible only in this organization.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`nickname-${member.membership_id}`}>Organization nickname</FieldLabel>
            <Input id={`nickname-${member.membership_id}`} value={nickname} maxLength={80} onChange={(event) => setNickname(event.target.value)} placeholder={member.display_name} />
            <FieldDescription>Leave blank to use their account name.</FieldDescription>
          </Field>
          {error && <Alert variant="destructive" aria-live="assertive"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={isPending}>Cancel</Button>
            <Button disabled={isPending} onClick={() => submit(updateMemberNicknameAction, { membership_id: member.membership_id, nickname })}>
              {isPending && <Spinner />}
              {isPending ? "Saving nickname…" : "Save nickname"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this member?</AlertDialogTitle>
            <AlertDialogDescription>{member.display_name} will lose access to this organization. This does not delete their account.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <Alert variant="destructive" aria-live="assertive"><AlertDescription>{error}</AlertDescription></Alert>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={isPending} onClick={(event) => { event.preventDefault(); submit(removeMemberAction, { membership_id: member.membership_id }); }}>
              {isPending && <Spinner />}
              {isPending ? "Removing member…" : "Remove member"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
