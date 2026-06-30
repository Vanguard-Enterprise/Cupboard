import { redirect } from "next/navigation";
import { getSession } from "@/lib/api";

// Entry point: bounce to the dashboard when signed in, otherwise to login.
export default async function Home() {
  const session = await getSession();
  redirect(session ? "/dashboard" : "/login");
}
