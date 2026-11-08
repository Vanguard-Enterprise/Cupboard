import { StatusPageAdmin } from "@/components/status-page";
import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";

export const metadata = { title: "Status page | Cupboard" };

export default async function StatusPagePage() {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 md:py-8">
      <StatusPageAdmin
        key={`${identity.user.id}:${identity.organization.id}`}
        identity={identity}
      />
    </div>
  );
}
