import { MachineInventory } from "@/components/machine-inventory";
import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";
export const metadata = { title: "Machines | Cupboard" };
export default async function MachinesPage() {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  return (
    <MachineInventory
      key={`${identity.user.id}:${identity.organization.id}`}
      identity={identity}
    />
  );
}
