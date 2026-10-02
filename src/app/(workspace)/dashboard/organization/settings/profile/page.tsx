import { OrganizationProfileForm } from "@/components/organization-profile-form";

export const metadata = { title: "Organization profile | Cupboard" };

export default function OrganizationProfilePage() {
  return (
    <div className="mx-auto w-full max-w-[848px] px-4 py-6 md:px-6 md:py-8">
      <div className="mb-10 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Organization profile
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage your organization details and contact information.
        </p>
      </div>
      <OrganizationProfileForm />
    </div>
  );
}
