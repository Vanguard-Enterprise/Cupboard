import { DiscordInstallCallback } from "@/components/discord-install-callback";
import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";

export const metadata = { title: "Discord | Cupboard" };

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export default async function DiscordCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  const query = await searchParams;
  return (
    <DiscordInstallCallback
      identity={identity}
      code={one(query.code)}
      state={one(query.state)}
      guildId={one(query.guild_id)}
      error={one(query.error)}
    />
  );
}
