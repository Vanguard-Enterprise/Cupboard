import { OrganizationAccess } from "@/components/organization-access";

export const metadata = { title: "Approvals | Cupboard" };

export default function OrganizationAccessPage() {
  return (
    <div className="mx-auto w-full max-w-[848px] px-4 py-6 md:px-6 md:py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Configure approval requirements for sensitive organization actions.
        </p>
      </div>
      <OrganizationAccess />
    </div>
  );
}
