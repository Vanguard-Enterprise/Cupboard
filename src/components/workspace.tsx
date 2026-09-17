"use client";

import {
  implementedPages,
  implementedPageEntries,
  type OrganizationPageEntry,
} from "@/lib/implemented-pages";
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

export function Workspace({
  children,
  defaultOpen,
}: {
  children: React.ReactNode;
  defaultOpen: boolean;
}) {
  const pathname = usePathname();
  const entry = implementedPageEntries.find(
    (entry): entry is OrganizationPageEntry =>
      entry[1].kind === "organization" && entry[1].href === pathname,
  );
  const currentPage = entry
    ? { activeSection: entry[0], crumbs: entry[1].breadcrumbs }
    : undefined;
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <OrganizationProvider>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar
          activeSection={currentPage?.activeSection}
          onSearch={() => setSearchOpen(true)}
        />
        <SidebarInset>
          <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 py-3">
            <SidebarTrigger />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  {currentPage ? (
                    <BreadcrumbLink asChild>
                      <Link href={implementedPages.dashboard.href}>
                        Dashboard
                      </Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>Dashboard</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {currentPage?.crumbs.map((crumb, index) => (
                  <Fragment key={crumb}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      {index === currentPage.crumbs.length - 1 ? (
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
