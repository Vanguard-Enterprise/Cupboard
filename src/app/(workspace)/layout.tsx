import { redirect } from "next/navigation";
import { getIdentity } from "@/lib/auth-server";
import { cookies } from "next/headers";
import { AccountWorkspace } from "@/components/account-workspace";
import { Workspace } from "@/components/workspace";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  const cookieStore = await cookies();
  return (
    <Workspace
      identity={identity}
      defaultOpen={cookieStore.get("sidebar_state")?.value !== "false"}
    >
      {identity.organization ? (
        children
      ) : (
        <AccountWorkspace identity={identity} />
      )}
    </Workspace>
  );
}
