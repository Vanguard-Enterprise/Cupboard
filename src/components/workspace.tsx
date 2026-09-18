"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { OrganizationProvider } from "@/components/organization-provider";
import { OrganizationSearch } from "@/components/organization-search";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  accessPath,
  auditLogPath,
  connectionsPath,
  credentialsPath,
  notificationsDataPath,
  profilePath,
  rolesPath,
  securityAlertsPath,
  usagePath,
  usersPath,
} from "@/lib/dashboard-navigation";

export function Workspace({
  children,
  defaultOpen,
}: {
  children: React.ReactNode;
  defaultOpen: boolean;
}) {
  const pathname = usePathname();
  const currentPage =
    pathname === profilePath
      ? {
          activeSection: "organization",
          crumbs: ["Organization", "Settings", "Profile"],
        }
      : pathname === usagePath
        ? {
            activeSection: "billing",
            crumbs: ["Organization", "Settings", "Usage"],
          }
        : pathname === connectionsPath
          ? {
              activeSection: "connections",
              crumbs: ["Organization", "Integrations", "Connections"],
            }
          : pathname === credentialsPath
            ? {
                activeSection: "credentials",
                crumbs: [
                  "Organization",
                  "Integrations",
                  "Credentials & webhooks",
                ],
              }
            : pathname === securityAlertsPath
              ? {
                  activeSection: "security-alerts",
                  crumbs: ["Organization", "Security", "Alerts"],
                }
              : pathname === auditLogPath
                ? {
                    activeSection: "audit-log",
                    crumbs: ["Organization", "Security", "Audit log"],
                  }
                : pathname === accessPath
                  ? {
                      activeSection: "access",
                      crumbs: ["Organization", "Security", "Approvals"],
                    }
                  : pathname === notificationsDataPath
                    ? {
                        activeSection: "preferences",
                        crumbs: [
                          "Organization",
                          "Settings",
                          "Notifications & data",
                        ],
                      }
                    : undefined;
  const teamPage =
    pathname === usersPath
      ? {
          activeSection: "team-users",
          crumbs: ["Organization", "Members & teams", "Users"],
        }
      : pathname === rolesPath
        ? {
            activeSection: "team-roles",
            crumbs: ["Organization", "Members & teams", "Roles"],
          }
        : undefined;
  const page = currentPage ?? teamPage;
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <OrganizationProvider>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar
          activeSection={page?.activeSection}
          onSearch={() => setSearchOpen(true)}
        />
        <SidebarInset>
          <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 py-3">
            <SidebarTrigger />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  {page ? (
                    <BreadcrumbLink asChild>
                      <Link href="/dashboard">Dashboard</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>Dashboard</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {page?.crumbs.map((crumb, index) => (
                  <Fragment key={crumb}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      {index === page.crumbs.length - 1 ? (
                        <BreadcrumbPage>{crumb}</BreadcrumbPage>
                      ) : (
                        <span>{crumb}</span>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          </header>
          {children}
        </SidebarInset>
        <OrganizationSearch open={searchOpen} setOpen={setSearchOpen} />
      </SidebarProvider>
    </OrganizationProvider>
  );
}
