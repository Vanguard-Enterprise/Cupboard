import { AuditLog } from "@/components/audit-log";

export const metadata = { title: "Audit log | Cupboard" };

export default function AuditLogPage() {
  return (
    <main className="mx-auto w-[calc(100%-2rem)] max-w-[1240px] py-5 md:w-[calc(100%-4rem)] md:py-6">
      <div className="mb-4 flex items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <span className="rounded-full border border-border/40 px-2 py-0.5 text-[11px] font-medium text-text-muted/70">
          Sample data
        </span>
      </div>
      <AuditLog />
    </main>
  );
}
