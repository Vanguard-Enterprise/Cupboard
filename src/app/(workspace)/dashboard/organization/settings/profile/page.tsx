import { OrganizationProfileForm } from "@/components/organization-profile-form";

import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";

export const metadata = { title: "Organization profile | Cupboard" };

export default async function OrganizationProfilePage() {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  return (
    <div className="mx-auto w-full max-w-[848px] px-4 py-6 md:px-6 md:py-8">
      <OrganizationProfileForm
        organizationId={identity.organization.id}
        canManage={identity.permissions.includes("organization.manage")}
      />
    </div>
  );
}
