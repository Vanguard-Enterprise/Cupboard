import { redirect } from "next/navigation";
import { getSession, listOrgs } from "@/lib/api";
import { appPath } from "@/lib/paths";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { SidebarLeft } from "@/components/sidebar-left";
import { DashboardBreadcrumb } from "./dashboard-breadcrumb";
import { LocalTime } from "@/components/local-time";

// Protected shell. Requires a session; routes the user to onboarding when they have no
// active org. Nav links are RBAC-gated (the backend also enforces every action).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect(appPath("/login"));
  if (!session.org) redirect(appPath("/onboarding"));
  const orgs = await listOrgs();
  return (
    <SidebarProvider>
      <SidebarLeft
        teams={orgs.map((org) => ({ id: org.id, name: org.name, plan: "Cupboard" }))}
        activeOrgId={session.org}
        permissions={session.permissions}
        user={{
          name: session.user.display_name,
          email: session.user.email ?? "",
          avatar: "",
        }}
      />
      <SidebarInset className="bg-background">
        <div className="min-h-svh bg-background p-2 md:p-3 lg:p-4">
          <div className="app-workspace mx-auto flex min-h-[calc(100svh-1rem)] w-full max-w-[1560px] flex-col overflow-hidden rounded-2xl border border-border bg-workspace md:min-h-[calc(100svh-1.5rem)]">
            <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border bg-workspace/95 px-4 md:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <SidebarTrigger className="-ms-1" />
                <DashboardBreadcrumb />
                <span className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
                <LocalTime />
              </div>
            </header>
            <main className="min-w-0 flex-1 p-4 md:p-6 lg:p-8">{children}</main>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
