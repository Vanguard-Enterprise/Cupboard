import { implementedPages } from "@/lib/implemented-pages";
import { OrganizationAccess } from "@/components/organization-access";

export const metadata = { title: implementedPages["access"].metadataTitle };

export default function OrganizationAccessPage() {
  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 py-6 md:px-6 md:py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Access &amp; approvals
      </h1>
      <OrganizationAccess />
    </div>
  );
}
