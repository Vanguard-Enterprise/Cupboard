// Storefront player login. The layout has already verified the host and wrapped this in the
// theme Shell (which sets the --sf-* variables). A single "Sign in with Steam" button posts
// to the startSteamLogin server action, which resolves the tenant server-side and hands the
// browser to Steam. Already-signed-in players are sent straight to their account.
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { resolveSite } from "@/lib/site";
import { getPlayer } from "@/lib/player";
import { startSteamLogin } from "@/lib/player-actions";

type Props = { searchParams: Promise<{ error?: string }> };

export default async function PlayerLoginPage({ searchParams }: Props) {
  const host = (await headers()).get("x-cb-site-host");
  if (!host) notFound();
  const site = await resolveSite(host);
  if (!site) notFound();

  if (await getPlayer()) redirect("/account");

  const { error } = await searchParams;

  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-12">
      <div className="w-full rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-[var(--sf-fg)]/70">
          Sign in with your Steam account to manage your purchases.
        </p>

        {error ? (
          <p className="mt-6 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            Sign-in could not be completed. Please try again.
          </p>
        ) : null}

        <form action={startSteamLogin} className="mt-8">
          <button
            type="submit"
            className="w-full rounded-lg bg-[var(--sf-primary)] px-4 py-3 font-semibold text-black/90 transition-opacity hover:opacity-90"
          >
            Sign in with Steam
          </button>
        </form>
      </div>
    </div>
  );
}
