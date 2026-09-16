"use client";

import Link from "next/link";
import { useState } from "react";
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
  credentialsPath,
  notificationsDataPath,
  profilePath,
  usagePath,
} from "@/lib/dashboard-navigation";

export function Workspace({
  children,
  defaultOpen,
}: {
  children: React.ReactNode;
  defaultOpen: boolean;
}) {
  const pathname = usePathname();
  const isProfile = pathname === profilePath;
  const isUsage = pathname === usagePath;
  const isCredentials = pathname === credentialsPath;
  const isNotificationsData = pathname === notificationsDataPath;
  const isOrganizationSettings = isProfile || isUsage || isNotificationsData;
  const isOrganizationPage = isOrganizationSettings || isCredentials;
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <OrganizationProvider>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar
          activeSection={
            isProfile
              ? "organization"
              : isUsage
                ? "billing"
                : isCredentials
                  ? "credentials"
                  : isNotificationsData
                    ? "preferences"
                    : undefined
          }
          onSearch={() => setSearchOpen(true)}
        />
        <SidebarInset>
          <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 py-3">
            <SidebarTrigger />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  {isOrganizationPage ? (
                    <BreadcrumbLink asChild>
                      <Link href="/dashboard">Dashboard</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>Dashboard</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {isOrganizationPage && (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <span>Organization</span>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <span>{isCredentials ? "Integrations" : "Settings"}</span>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>
                        {isProfile
                          ? "Profile"
                          : isUsage
                            ? "Usage"
                            : isCredentials
                              ? "Credentials & webhooks"
                              : "Notifications & data"}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                )}
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
