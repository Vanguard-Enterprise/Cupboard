import { redirect } from "next/navigation";
import { getSession } from "@/lib/api";
import { appPath } from "@/lib/paths";

// Entry point: bounce to the dashboard when signed in, otherwise to login.
export default async function Home() {
  const session = await getSession();
  redirect(appPath(session ? "/dashboard" : "/login"));
}
