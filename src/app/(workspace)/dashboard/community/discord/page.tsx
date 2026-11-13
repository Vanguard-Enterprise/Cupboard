import { DiscordGuilds } from "@/components/discord-guilds";
import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";

export const metadata = { title: "Discord | Cupboard" };

export default async function DiscordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  const { added } = await searchParams;
  return (
    <DiscordGuilds
      key={`${identity.user.id}:${identity.organization.id}`}
      identity={identity}
      added={typeof added === "string" ? added : undefined}
    />
  );
}
