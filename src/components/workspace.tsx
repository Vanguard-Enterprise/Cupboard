"use client";

import { PreviewStorageProvider } from "./preview-storage";
import Link from "next/link";
import type { Identity } from "@/lib/api-client";
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
  alertsPath,
  profilePath,
  rolesPath,
  serversPath,
  machinesPath,
  filesPath,
  securityAlertsPath,
  usagePath,
  usersPath,
} from "@/lib/dashboard-navigation";

export function Workspace({
  children,
  defaultOpen,
  identity,
}: {
  children: React.ReactNode;
  defaultOpen: boolean;
  identity: Identity;
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
            crumbs: ["Organization", "Settings", "Billing & usage"],
          }
        : pathname === connectionsPath
          ? {
              activeSection: "connections",
              crumbs: ["Connections"],
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
                  : pathname === alertsPath
                    ? {
                        activeSection: "alerts-data",
                        crumbs: ["Organization", "Settings", "Alerts & data"],
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
  const serverPage =
    pathname === filesPath
      ? { activeSection: "file-library", crumbs: ["Files"] }
      : pathname === serversPath
        ? {
            activeSection: "servers",
            crumbs: ["Operations", "Game servers", "Server inventory"],
          }
        : undefined;
  const machinePage =
    pathname === machinesPath || pathname === machinesPath + "/setup"
      ? {
          activeSection: "nodes",
          crumbs: pathname.endsWith("/setup")
            ? ["Machines", "Setup"]
            : ["Machines"],
        }
      : undefined;
  const page = identity.organization
    ? (machinePage ?? serverPage ?? currentPage ?? teamPage)
    : undefined;
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <PreviewStorageProvider
      accountId={identity.user.id}
      organizationId={identity.organization?.id ?? null}
    >
      <OrganizationProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <AppSidebar
            identity={identity}
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
                        ) : crumb === "Machines" ? (
                          <BreadcrumbLink asChild>
                            <Link href={machinesPath}>{crumb}</Link>
                          </BreadcrumbLink>
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
          {identity.organization && (
            <OrganizationSearch open={searchOpen} setOpen={setSearchOpen} />
          )}
        </SidebarProvider>
      </OrganizationProvider>
    </PreviewStorageProvider>
  );
}
