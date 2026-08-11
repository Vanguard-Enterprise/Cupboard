"use client";

import { useActionState } from "react";
import { KeyRoundIcon, LoaderCircleIcon, RotateCwIcon, XIcon } from "lucide-react";
import { issueIngestTokenAction, revokeIngestTokenAction } from "@/lib/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function IngestToken({ serverId, hasToken }: { serverId: string; hasToken: boolean }) {
  const [state, action, pending] = useActionState(issueIngestTokenAction, {});
  const tokenExists = hasToken || Boolean(state.token);

  return (
    <div className="flex min-w-48 flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-1">
        <form action={action}>
          <input type="hidden" name="server_id" value={serverId} />
          <Button type="submit" variant="outline" size="xs" disabled={pending}>
            {pending ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : tokenExists ? <RotateCwIcon data-icon="inline-start" /> : <KeyRoundIcon data-icon="inline-start" />}
            {pending ? "Working…" : tokenExists ? "Rotate" : "Issue token"}
          </Button>
        </form>
        {tokenExists && <form action={revokeIngestTokenAction}><input type="hidden" name="server_id" value={serverId} /><Button type="submit" variant="ghost" size="icon-xs" aria-label="Revoke ingest token"><XIcon /></Button></form>}
      </div>
      {state.token && <Alert className="max-w-72 border-emerald-500/20 bg-emerald-500/5 py-2"><AlertDescription className="break-all font-mono text-xs text-emerald-400">{state.token}</AlertDescription></Alert>}
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}
    </div>
  );
}
