import Link from "next/link";
import { ArrowLeftIcon, ServerIcon } from "lucide-react";
import { getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ServerForm } from "../server-form";

export default async function NewServerPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.ServersManage)) {
    return <p className="text-sm text-muted-foreground">You don&apos;t have access to add servers.</p>;
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <Button asChild variant="ghost" className="-ms-3 w-fit text-muted-foreground">
        <Link href="/servers"><ArrowLeftIcon data-icon="inline-start" />Back to servers</Link>
      </Button>

      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><ServerIcon className="size-4" aria-hidden="true" />Fleet onboarding</div>
        <h1 className="text-3xl font-semibold tracking-tight">Add a new server</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">Connect a game server to Cupboard using its RCON credentials and optional query endpoint.</p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Connection details</CardTitle>
          <CardDescription>Credentials are encrypted at rest and are only used to connect to this server.</CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <ServerForm />
        </CardContent>
      </Card>
    </div>
  );
}
