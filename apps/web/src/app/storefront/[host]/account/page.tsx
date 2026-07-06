// Storefront player account page. The layout has verified the host and wrapped this in the
// theme Shell (--sf-* variables). Requires a player session; unauthenticated visitors are
// sent to login. Shows the player's Steam identity and a sign-out form.
import { redirect } from "next/navigation";
import { getPlayer } from "@/lib/player";
import { logoutPlayer } from "@/lib/player-actions";
import { fetchPlayerEntitlements, type Entitlement } from "@/lib/entitlements";
import { safeHttpUrl } from "@/themes/registry";

/** Format an ISO timestamp as a short calendar date; falls back to the raw string if the
 * value is not a parseable date. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

export default async function AccountPage() {
  const player = await getPlayer();
  if (!player) redirect("/login");

  const entitlements = await fetchPlayerEntitlements();

  const avatar = safeHttpUrl(player.avatar_url);
  const name =
    player.display_name?.trim() ||
    (player.steam_id ? `Player ${player.steam_id.slice(-4)}` : "Player");

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
            {player.steam_id ? (
              <p className="mt-1 font-mono text-xs text-[var(--sf-fg)]/60">{player.steam_id}</p>
            ) : null}
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

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Your purchases</h2>
        {entitlements.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--sf-fg)]/70">
            No purchases yet.{" "}
            <a href="/store" className="text-[var(--sf-primary)] hover:underline">
              Browse the store
            </a>
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {entitlements.map((e, i) => (
              <PurchaseRow key={`${e.product_external_id}-${e.granted_at}-${i}`} entitlement={e} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PurchaseRow({ entitlement }: { entitlement: Entitlement }) {
  const title = entitlement.product_name?.trim() || entitlement.product_external_id;
  const isSubscription = entitlement.kind === "subscription";
  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-words font-medium leading-snug">{title}</h3>
        <span className="shrink-0 rounded-full border border-[var(--sf-primary)]/40 px-2 py-0.5 text-xs text-[var(--sf-primary)]">
          {isSubscription ? "Subscription" : "One-time"}
        </span>
      </div>
      <p className="mt-2 text-xs text-[var(--sf-fg)]/60">
        Purchased {formatDate(entitlement.granted_at)}
      </p>
      {entitlement.expires_at ? (
        <p className="mt-1 text-xs text-[var(--sf-fg)]/60">
          Expires {formatDate(entitlement.expires_at)}
        </p>
      ) : null}
    </li>
  );
}
