"use client";

import { useActionState } from "react";
import { AlertCircleIcon, CheckCircle2Icon, LoaderCircleIcon, PlusIcon } from "lucide-react";
import { createServerAction } from "@/lib/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function ServerForm() {
  const [state, action, pending] = useActionState(createServerAction, {});

  return (
    <form action={action} className="flex flex-col gap-5">
      <FieldGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
        <Field className="xl:col-span-3">
          <FieldLabel htmlFor="server-name">Server name</FieldLabel>
          <Input id="server-name" name="name" required placeholder="Main US" autoComplete="off" />
        </Field>
        <Field className="xl:col-span-3">
          <FieldLabel htmlFor="rcon-host">RCON host</FieldLabel>
          <Input id="rcon-host" name="rcon_host" required placeholder="10.0.0.1" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </Field>
        <Field className="xl:col-span-2">
          <FieldLabel htmlFor="rcon-port">RCON port</FieldLabel>
          <Input id="rcon-port" name="rcon_port" type="number" inputMode="numeric" required min={1} max={65535} defaultValue={28016} />
        </Field>
        <Field className="xl:col-span-2">
          <FieldLabel htmlFor="rcon-password">RCON password</FieldLabel>
          <Input id="rcon-password" name="rcon_password" type="password" required placeholder="••••••••" autoComplete="new-password" />
        </Field>
        <Field className="xl:col-span-2">
          <FieldLabel htmlFor="query-port">Query port</FieldLabel>
          <Input id="query-port" name="query_port" type="number" inputMode="numeric" min={1} max={65535} placeholder="Optional" />
        </Field>
      </FieldGroup>
      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <FieldDescription className="max-w-2xl">Credentials are encrypted at rest. Cupboard only uses them to connect to this server.</FieldDescription>
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
          {pending ? "Adding server…" : "Add server"}
        </Button>
      </div>
      {state.error && <Alert variant="destructive"><AlertCircleIcon /><AlertDescription>{state.error}</AlertDescription></Alert>}
      {state.ok && <Alert className="border-emerald-500/20 bg-emerald-500/5 text-emerald-400"><CheckCircle2Icon /><AlertDescription className="text-emerald-400">Server added successfully.</AlertDescription></Alert>}
    </form>
  );
}
