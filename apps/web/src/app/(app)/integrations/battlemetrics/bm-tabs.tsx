import Link from "next/link";

type Tab = "setup" | "status" | "conflicts";

const TABS: { key: Tab; href: string; label: string }[] = [
  { key: "setup", href: "/integrations/battlemetrics", label: "Setup" },
  { key: "status", href: "/integrations/battlemetrics/status", label: "Status" },
  { key: "conflicts", href: "/integrations/battlemetrics/conflicts", label: "Conflicts" },
];

// Sub-nav shared by the three BattleMetrics routes; mirrors the perf page's tab row.
// `unresolved` badges the Conflicts tab when there are conflicts awaiting review.
export function BmTabs({ active, unresolved = 0 }: { active: Tab; unresolved?: number }) {
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`flex items-center gap-2 rounded px-2 py-1 ${active === t.key ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900"}`}
        >
          {t.label}
          {t.key === "conflicts" && unresolved > 0 && (
            <span className="rounded-full bg-yellow-900 px-1.5 text-xs text-yellow-300 tabular-nums">
              {unresolved}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
