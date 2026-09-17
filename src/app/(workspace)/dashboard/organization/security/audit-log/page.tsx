import { implementedPages } from "@/lib/implemented-pages";
import { AuditLog } from "@/components/audit-log";

export const metadata = { title: implementedPages["audit-log"].metadataTitle };

export default function AuditLogPage() {
  return (
    <div className="mx-auto w-[calc(100%-2rem)] max-w-[1240px] py-5 md:w-[calc(100%-4rem)] md:py-6">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Audit log</h1>
      <AuditLog />
    </div>
  );
}
