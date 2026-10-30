import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";
import { OrganizationAlerts } from "@/components/organization-alerts";

export const metadata = { title: "Alerts and data | Cupboard" };

export default async function OrganizationAlertsPage() {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  return (
    <div className="mx-auto w-full max-w-[848px] px-4 py-6 md:px-6 md:py-8">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">
        Alerts &amp; data
      </h1>
      <OrganizationAlerts
        key={`${identity.user.id}:${identity.organization.id}`}
        identity={identity}
      />
    </div>
  );
}
