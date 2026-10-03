import { AuditLog } from "@/components/audit-log";

export const metadata = { title: "Audit log | Cupboard" };

export default function AuditLogPage() {
  return (
    <div className="mx-auto w-[calc(100%-2rem)] max-w-[1600px] py-5 md:w-[calc(100%-4rem)] md:py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
      <p className="mt-2 mb-6 text-sm text-muted-foreground">
        Review organization activity, access changes, and server actions.
      </p>
      <AuditLog />
    </div>
  );
}
