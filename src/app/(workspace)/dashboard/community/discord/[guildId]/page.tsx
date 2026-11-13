import { DiscordGuild } from "@/components/discord-guild";
import { getIdentity } from "@/lib/auth-server";
import { notFound, redirect } from "next/navigation";

export const metadata = { title: "Discord | Cupboard" };

export default async function DiscordGuildPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  const { guildId } = await params;
  if (!/^[0-9]{17,20}$/.test(guildId)) notFound();
  return (
    <DiscordGuild
      key={`${identity.user.id}:${identity.organization.id}:${guildId}`}
      identity={identity}
      guildId={guildId}
    />
  );
}
