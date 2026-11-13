import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

// A guild's logo on a blurred copy of itself, so a logo with a transparent
// background still sits on its own colors rather than on a dark square.
export function DiscordGuildIcon({
  guild,
  className,
}: {
  guild: { id: string; name: string; iconHash: string | null };
  className?: string;
}) {
  const src = guild.iconHash
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.iconHash}.png?size=160`
    : undefined;
  return (
    <span
      className={cn(
        "relative isolate block shrink-0 overflow-hidden rounded-xl",
        className,
      )}
    >
      {src && (
        <span
          aria-hidden="true"
          data-slot="guild-icon-blur"
          className="absolute inset-0 -z-10 scale-150 bg-cover bg-center opacity-70 blur-xl"
          style={{ backgroundImage: `url(${src})` }}
        />
      )}
      <Avatar className="size-full rounded-xl after:rounded-xl">
        <AvatarImage src={src} alt="" className="rounded-xl" />
        <AvatarFallback className="rounded-xl text-base font-medium">
          {initials(guild.name)}
        </AvatarFallback>
      </Avatar>
    </span>
  );
}
