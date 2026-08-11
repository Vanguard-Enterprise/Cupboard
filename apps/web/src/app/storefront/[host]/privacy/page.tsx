// Static privacy disclosure page for a tenant storefront (decision #4 and the decision
// #3 retention windows). Deliberately a product page in plain language, not a contract:
// what is collected, why, for how long, what your rights are and how to use them, what
// erasure keeps and why, and the US (CCPA/CPRA) no-sale statement. Server-rendered inside
// the theme Shell; every color reads the --sf-* variables like the other storefront pages.
import Link from "next/link";

const RETENTION_ROWS: { what: string; window: string }[] = [
  { what: "Raw IP addresses and per-session names from game sessions, plus connection signals", window: "90 days" },
  { what: "In-game chat messages", window: "180 days" },
  { what: "Player reports", window: "1 year" },
  { what: "Name history", window: "2 years" },
  { what: "Audit logs (records of staff and system actions)", window: "2 years" },
  { what: "Payment provider webhook payloads", window: "90 days" },
  { what: "Sign-in sessions for this site (removed after they expire or are revoked)", window: "90 days" },
  { what: "Internal event streams", window: "14 days" },
  { what: "Server logs", window: "7 days" },
  { what: "Request traces", window: "3 days" },
  { what: "Metric aggregates", window: "14 days" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-[var(--sf-fg)]/80">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyDisclosurePage() {
  return (
    <div className="mx-auto max-w-3xl py-8">
      <h1 className="text-3xl font-bold tracking-tight">Privacy</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--sf-muted)]">
        This community runs on Cupboard, a platform for game server communities. This page
        explains, in plain language, what data is collected when you play here or use this
        site, why, how long it is kept, and what you can do about it.
      </p>

      <Section title="What we collect">
        <ul className="list-disc space-y-1.5 ps-5">
          <li>
            <strong>Identifiers</strong>: your Steam ID, and your Discord ID if you link
            Discord, plus the display names and avatars those accounts expose.
          </li>
          <li>
            <strong>Game sessions</strong>: when you connect to a tracked game server we
            record the session, including your IP address and the name you played under.
          </li>
          <li>
            <strong>In-game chat</strong> on tracked servers.
          </li>
          <li>
            <strong>Player reports</strong>: reports you file and reports filed about you.
          </li>
          <li>
            <strong>Moderation records</strong>: bans, staff notes, and flags.
          </li>
          <li>
            <strong>Support tickets</strong> you open on this site or through Discord.
          </li>
          <li>
            <strong>Purchases and entitlements</strong>: what you bought in the store and
            which grants you hold. Payment card details go to the payment provider, never
            to us.
          </li>
          <li>
            <strong>Sign-in sessions</strong> for this site.
          </li>
        </ul>
      </Section>

      <Section title="Why we can use it (lawful bases)">
        <ul className="list-disc space-y-1.5 ps-5">
          <li>
            <strong>Contract</strong>: running your account, delivering store purchases,
            and answering your support tickets.
          </li>
          <li>
            <strong>Legitimate interest</strong>: keeping servers safe and fair, which
            covers moderation, ban enforcement, detecting ban evasion and alternate
            accounts, and securing the platform.
          </li>
          <li>
            <strong>Legal obligation</strong>: keeping audit and purchase records where
            the law requires it.
          </li>
        </ul>
      </Section>

      <Section title="How long we keep it">
        <p>
          Raw data ages out on fixed schedules; these run automatically, not on request.
        </p>
        <div className="overflow-hidden rounded-xl border border-[var(--sf-border)]">
          <table className="w-full text-start text-sm">
            <thead className="bg-[var(--sf-card)] text-[var(--sf-muted)]">
              <tr>
                <th className="px-4 py-2 font-medium">Data</th>
                <th className="px-4 py-2 font-medium">Kept for</th>
              </tr>
            </thead>
            <tbody>
              {RETENTION_ROWS.map((r) => (
                <tr key={r.what} className="border-t border-[var(--sf-border)]">
                  <td className="px-4 py-2">{r.what}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-[var(--sf-muted)]">
                    {r.window}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Support tickets are kept as support history. Account and moderation records are
          kept while your account exists, or until you ask us to delete them.
        </p>
      </Section>

      <Section title="Your rights and how to use them">
        <p>
          Wherever you live, you can get a copy of your data and you can ask us to delete
          it, and both are self-serve:
        </p>
        <ul className="list-disc space-y-1.5 ps-5">
          <li>
            <strong>Download my data</strong> and <strong>Delete my data</strong> live on
            your{" "}
            <a href="/account" className="text-[var(--sf-primary)] hover:underline">
              account page
            </a>{" "}
            once you sign in. Signing in with your Steam or Discord account is also how we
            verify the request really comes from you.
          </li>
          <li>
            Exports arrive as a single compressed file with everything grouped by area
            (game records, account, store and support). The download link works once.
          </li>
          <li>
            Deletion shows you a summary of what will be removed and asks you to confirm
            before anything happens.
          </li>
          <li>
            To correct something (for example your display name), update it at the source
            account (Steam or Discord) or open a support ticket.
          </li>
        </ul>
      </Section>

      <Section title="What deletion keeps, and why">
        <p>When you delete your data, almost everything goes. Two things remain:</p>
        <ul className="list-disc space-y-1.5 ps-5">
          <li>
            <strong>Ban enforcement fingerprints.</strong> If you were banned, we keep a
            one-way hash of the banned identifier. It cannot be turned back into who you
            are, but it keeps the ban working, so a ban cannot be dodged by deleting an
            account. This is our legitimate interest in keeping communities safe.
          </li>
          <li>
            <strong>Purchase records.</strong> Proof of what was bought and which grants
            were issued stays on record, on contract and legal grounds.
          </li>
        </ul>
        <p>
          Deletion applies to data we hold. If you later rejoin a tracked server, that is
          fresh collection under the same rules; your old history does not come back.
        </p>
      </Section>

      <Section title="Other people in your export">
        <p>
          Your export contains your own data only. Where records involve someone else,
          their side is redacted: other people&apos;s messages are left out, and other
          parties in reports appear as &quot;[third party]&quot;. The same request from
          them would protect your data the same way.
        </p>
      </Section>

      <Section title="Who is responsible for what">
        <p>
          Cupboard operates a cross-community identity graph (linking game identifiers
          across the network for ban-evasion protection) and is the data controller for
          it. Records that belong to this community, such as its chat logs, tickets, and
          purchases, are processed on behalf of this community&apos;s operator. Your
          export and deletion rights cover both at once.
        </p>
      </Section>

      <Section title="California and other US states">
        <p>
          We do not sell your personal information, and we do not share it with third
          parties for cross-context behavioral advertising. There is nothing to opt out
          of, so the &quot;Do Not Sell or Share My Personal Information&quot; right is
          satisfied automatically. The access, deletion, and correction rights above
          cover the CCPA/CPRA rights as well.
        </p>
      </Section>

      <Section title="Questions">
        <p>
          Open a{" "}
          <Link href="/tickets" className="text-[var(--sf-primary)] hover:underline">
            support ticket
          </Link>{" "}
          and we will help.
        </p>
      </Section>
    </div>
  );
}
