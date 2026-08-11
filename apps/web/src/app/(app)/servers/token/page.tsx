import Link from "next/link";
import { ArrowLeftIcon, KeyRoundIcon, ServerIcon } from "lucide-react";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IngestToken } from "../ingest-token";

type ServerSummary = {
  id: string;
  name: string;
  rcon_host: string;
  info_hostname: string | null;
  has_ingest_token: boolean;
};

async function fetchServers(): Promise<ServerSummary[]> {
  const res = await apiFetch("/fleet/servers");
  if (!res.ok) return [];
  return res.json();
}

export default async function ServerTokenPage({
  searchParams,
}: {
  searchParams: Promise<{ server?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.ServersManage)) {
    return <p className="text-sm text-muted-foreground">You don&apos;t have access to manage server tokens.</p>;
  }

  const { server: serverId } = await searchParams;
  const server = serverId ? (await fetchServers()).find((item) => item.id === serverId) : null;
  if (!server) {
    return <p className="text-sm text-muted-foreground">That server could not be found.</p>;
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <Button asChild variant="ghost" className="-ms-3 w-fit text-muted-foreground">
        <Link href="/servers"><ArrowLeftIcon data-icon="inline-start" />Back to servers</Link>
      </Button>

      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><ServerIcon className="size-4" aria-hidden="true" />{server.name}</div>
        <h1 className="text-3xl font-semibold tracking-tight">Ingest token</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">Issue or rotate the push-ingest token used by the Cupboard plugin for this server.</p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2"><KeyRoundIcon className="size-4" />Push ingest access</CardTitle>
          <CardDescription>Tokens are shown exactly once. Store the new token in the server plugin configuration.</CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <IngestToken serverId={server.id} hasToken={server.has_ingest_token} />
        </CardContent>
      </Card>
    </div>
  );
}
