import { FileLibrary } from "@/components/file-library";
import { getIdentity } from "@/lib/auth-server";
import { redirect } from "next/navigation";
export const metadata = { title: "Files | Cupboard" };
export default async function FilesPage() {
  const identity = await getIdentity();
  if (!identity) redirect("/login");
  if (!identity.organization) redirect("/dashboard");
  return <FileLibrary key={identity.organization.id} identity={identity} />;
}
