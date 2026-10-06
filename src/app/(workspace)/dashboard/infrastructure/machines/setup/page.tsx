import { MachineSetup } from "@/components/machine-setup";
import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";
export const metadata = { title: "Machine setup | Cupboard" };
export default async function MachineSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  const { machine } = await searchParams;
  return (
    <MachineSetup
      key={`${identity.user.id}:${identity.organization.id}:${machine ?? "new"}`}
      identity={identity}
      initialMachineId={machine ?? null}
    />
  );
}
