// Storefront player account page. The layout has verified the host and wrapped this in the
// theme Shell (--sf-* variables). Requires a player session; unauthenticated visitors are
// sent to login. Shows the player's Steam identity and a sign-out form.
import { redirect } from "next/navigation";
import Link from "next/link";
import { getPlayer } from "@/lib/player";
import { linkDiscord, logoutPlayer } from "@/lib/player-actions";
import { fetchPlayerEntitlements, type Entitlement } from "@/lib/entitlements";
import { fetchPlayerTickets } from "@/lib/tickets";
import { safeHttpUrl } from "@/themes/registry";
import { PrivacySection } from "./privacy-section";

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

// The gateway's Discord callback returns the browser here with a ?discord= flag; each maps
// to a small themed banner. Anything else (including no flag) shows nothing.
const DISCORD_NOTICES: Record<string, { tone: "success" | "error"; message: string }> = {
  linked: { tone: "success", message: "Discord linked." },
  conflict: {
    tone: "error",
    message: "That Discord account is already linked to another player.",
  },
  error: { tone: "error", message: "Could not link Discord, please try again." },
};

// The privacy server actions and the export download route return here with a ?privacy=
// flag; same shape as the Discord notices. Anything else shows nothing.
const PRIVACY_NOTICES: Record<string, { tone: "success" | "error"; message: string }> = {
  export_started: {
    tone: "success",
    message: "Export started. A download link appears below when it is ready.",
  },
  erase_started: {
    tone: "success",
    message:
      "Deletion request started. We will show you a summary of what gets deleted below, and nothing is removed until you confirm it.",
  },
  erase_confirmed: {
    tone: "success",
    message: "Deletion confirmed. It finishes shortly; after that you will be signed out.",
  },
  download_gone: {
    tone: "error",
    message:
      "That export was already downloaded or has expired. Start a new one if you need another copy.",
  },
  error: { tone: "error", message: "That did not work, please try again." },
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ discord?: string; privacy?: string }>;
}) {
  const player = await getPlayer();
  if (!player) redirect("/login");

  const [entitlements, tickets] = await Promise.all([
    fetchPlayerEntitlements(),
    fetchPlayerTickets(),
  ]);
  const openTickets = tickets.filter(
    (t) => t.status !== "resolved" && t.status !== "closed",
  ).length;
  const { discord, privacy } = await searchParams;
  const notice =
    (discord ? DISCORD_NOTICES[discord] : undefined) ??
    (privacy ? PRIVACY_NOTICES[privacy] : undefined);
  const discordIdentity = player.identities.find((i) => i.provider === "discord");

  const avatar = safeHttpUrl(player.avatar_url);
  const name =
    player.display_name?.trim() ||
    (player.steam_id ? `Player ${player.steam_id.slice(-4)}` : "Player");

  return (
    <div className="mx-auto max-w-md py-12">
      {notice ? (
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            notice.tone === "success"
              ? "border-[var(--sf-primary)] text-[var(--sf-fg)]"
              : "border-red-500/60 text-red-500"
          }`}
        >
          {notice.message}
        </div>
      ) : null}
      <div className="rounded-2xl border border-[var(--sf-border)] bg-[var(--sf-card)] p-8">
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
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[var(--sf-primary)] text-xl font-bold text-[var(--sf-on-primary)]"
            >
              {name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">{name}</h1>
            {player.steam_id ? (
              <p className="mt-1 font-mono text-xs text-[var(--sf-muted)]">{player.steam_id}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-6 border-t border-[var(--sf-border)] pt-6">
          <h2 className="text-sm font-semibold tracking-tight">Connections</h2>
          <ul className="mt-3 space-y-3 text-sm">
            <li className="flex items-center justify-between gap-3">
              <span className="text-[var(--sf-muted)]">Steam</span>
              <span className="truncate font-mono text-xs text-[var(--sf-fg)]/80">
                {player.steam_id ?? "not linked"}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-[var(--sf-muted)]">Discord</span>
              {discordIdentity ? (
                <span className="inline-flex items-center gap-1.5 text-[var(--sf-fg)]/80">
                  <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--sf-primary)]" />
                  {discordIdentity.display_name?.trim() || "linked"}
                </span>
              ) : (
                <form action={linkDiscord}>
                  <button
                    type="submit"
                    className="rounded-lg border border-[var(--sf-border)] px-3 py-1.5 text-xs font-medium transition-colors hover:border-[var(--sf-primary)] hover:text-[var(--sf-primary)]"
                  >
                    Link Discord
                  </button>
                </form>
              )}
            </li>
          </ul>
        </div>

        <form action={logoutPlayer} className="mt-8">
          <button
            type="submit"
            className="w-full rounded-lg border border-[var(--sf-border)] px-4 py-2.5 text-sm font-medium transition-colors hover:border-[var(--sf-primary)] hover:text-[var(--sf-primary)]"
          >
            Sign out
          </button>
        </form>
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Your purchases</h2>
        {entitlements.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--sf-muted)]">
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

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Your tickets</h2>
        <p className="mt-3 text-sm text-[var(--sf-muted)]">
          {openTickets > 0
            ? `${openTickets} open ticket${openTickets === 1 ? "" : "s"}. `
            : "No open tickets. "}
          <Link href="/tickets" className="text-[var(--sf-primary)] hover:underline">
            {openTickets > 0 ? "View tickets" : "Get support"}
          </Link>
        </p>
      </section>

      <PrivacySection />
    </div>
  );
}

function PurchaseRow({ entitlement }: { entitlement: Entitlement }) {
  const title = entitlement.product_name?.trim() || entitlement.product_external_id;
  const isSubscription = entitlement.kind === "subscription";
  return (
    <li className="rounded-xl border border-[var(--sf-border)] bg-[var(--sf-card)] p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-words font-medium leading-snug">{title}</h3>
        <span className="shrink-0 rounded-full border border-[var(--sf-primary)]/40 px-2 py-0.5 text-xs text-[var(--sf-primary)]">
          {isSubscription ? "Subscription" : "One-time"}
        </span>
      </div>
      {entitlement.granted_at ? (
        <p className="mt-2 text-xs text-[var(--sf-muted)]">
          Purchased {formatDate(entitlement.granted_at)}
        </p>
      ) : null}
      {entitlement.expires_at ? (
        <p className="mt-1 text-xs text-[var(--sf-muted)]">
          Expires {formatDate(entitlement.expires_at)}
        </p>
      ) : null}
    </li>
  );
}
