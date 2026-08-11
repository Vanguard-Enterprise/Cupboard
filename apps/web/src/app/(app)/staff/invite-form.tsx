"use client";

import { useActionState, useState } from "react";
import { CheckIcon, CopyIcon, SendIcon } from "lucide-react";
import { createInviteAction } from "@/lib/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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

export function InviteForm({ roles }: { roles: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createInviteAction, {});
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copyInviteLink() {
    if (!state.acceptUrl) return;
    try {
      await navigator.clipboard.writeText(state.acceptUrl);
      setCopyError(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <form action={action} className="space-y-4">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="staff-email">Email address</FieldLabel>
          <Input
            id="staff-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="teammate@example.com"
          />
          <FieldDescription>They will use this address to accept the invitation.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="staff-role">Initial role</FieldLabel>
          <Select name="role_id" defaultValue="none">
            <SelectTrigger id="staff-role" className="w-full">
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
          <FieldDescription>You can assign or change roles after they join.</FieldDescription>
        </Field>
      </FieldGroup>

      {state.error && (
        <Alert variant="destructive" aria-live="assertive">
          <AlertTitle>Invitation wasn&apos;t sent</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.acceptUrl && (
        <Alert aria-live="polite">
          <CheckIcon aria-hidden="true" />
          <AlertTitle>Invitation created</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>Copy this secure link and send it to the teammate you invited.</p>
            <InputGroup>
              <InputGroupInput
                readOnly
                value={state.acceptUrl}
                aria-label="Invitation link"
                onFocus={(event) => event.currentTarget.select()}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={copyInviteLink} aria-label="Copy invitation link">
                  {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                  {copied ? "Copied" : "Copy"}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {copyError && (
              <p role="status">Automatic copy was blocked. Select the link above and copy it manually.</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? <Spinner /> : <SendIcon aria-hidden="true" />}
          {pending ? "Sending invitation…" : "Send invitation"}
        </Button>
      </DialogFooter>
    </form>
  );
}
