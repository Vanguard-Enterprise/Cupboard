import { ServerHealth } from "@/components/server-health";
import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";

export const metadata = { title: "Server health | Cupboard" };
export default async function DashboardPage() {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) return null;
  return <ServerHealth identity={identity} />;
}
