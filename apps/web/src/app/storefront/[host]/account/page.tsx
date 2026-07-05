// Storefront player account page. The layout has verified the host and wrapped this in the
// theme Shell (--sf-* variables). Requires a player session; unauthenticated visitors are
// sent to login. Shows the player's Steam identity and a sign-out form.
import { redirect } from "next/navigation";
import { getPlayer } from "@/lib/player";
import { logoutPlayer } from "@/lib/player-actions";
import { safeHttpUrl } from "@/themes/registry";

export default async function AccountPage() {
  const player = await getPlayer();
  if (!player) redirect("/login");

  const avatar = safeHttpUrl(player.avatar_url);
  const name = player.display_name?.trim() || `Player ${player.steam_id.slice(-4)}`;

  return (
    <div className="mx-auto max-w-md py-12">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-8">
        <div className="flex items-center gap-4">
          {avatar ? (
            // Steam-supplied remote avatar URL: a plain <img> (next/image would need the
            // host allow-listed in next.config, which is impossible per tenant).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar}
              alt={name}
              className="h-16 w-16 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div
              aria-hidden
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[var(--sf-primary)] text-xl font-bold text-black/80"
            >
              {name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">{name}</h1>
            <p className="mt-1 font-mono text-xs text-[var(--sf-fg)]/60">{player.steam_id}</p>
          </div>
        </div>

        <form action={logoutPlayer} className="mt-8">
          <button
            type="submit"
            className="w-full rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium transition-colors hover:border-[var(--sf-primary)] hover:text-[var(--sf-primary)]"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
