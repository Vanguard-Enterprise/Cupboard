import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";
import { OrganizationConnections } from "@/components/organization-connections";

export const metadata = { title: "Connections | Cupboard" };

export default async function OrganizationConnectionsPage() {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 md:px-6 md:py-8">
      <OrganizationConnections
        key={`${identity.user.id}:${identity.organization.id}`}
        identity={identity}
      />
    </div>
  );
}
