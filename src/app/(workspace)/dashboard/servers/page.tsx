import { ServerInventory } from "@/components/server-inventory";
import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";
export const metadata = { title: "Server inventory | Cupboard" };
export default async function ServersPage() {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  return <ServerInventory key={identity.organization.id} identity={identity} />;
}
