import { cookies } from "next/headers";
import { Workspace } from "@/components/workspace";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  return (
    <Workspace
      defaultOpen={cookieStore.get("sidebar_state")?.value !== "false"}
    >
      {children}
    </Workspace>
  );
}
