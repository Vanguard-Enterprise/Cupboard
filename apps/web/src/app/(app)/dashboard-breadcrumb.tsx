"use client";

import Link from "next/link";
import { Fragment } from "react";
import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbList,
} from "@/components/ui/breadcrumb";

const labels: Record<string, string> = {
  administration: "Administration",
  dashboard: "Overview",
  fleet: "Fleet",
  servers: "Servers",
  perf: "Performance",
  players: "Players",
  chat: "Chat",
  reports: "Reports",
  bans: "Bans",
  evasion: "Evasion alerts",
  tickets: "Tickets",
  integrations: "Integrations",
  battlemetrics: "Battlemetrics",
  site: "Site",
  store: "Store",
  staff: "Members",
  roles: "Roles",
  "api-keys": "API keys",
  privacy: "Privacy",
  billing: "Billing",
  settings: "Settings",
  new: "Add server",
};

const administrationRoutes = new Set(["staff", "roles", "api-keys", "privacy", "settings"]);

function titleFor(segment: string): string {
  return labels[segment] ?? segment.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function DashboardBreadcrumb() {
  const pathname = usePathname() ?? "/dashboard";
  const segments = pathname.split("/").filter(Boolean);
  const appIndex = segments.indexOf("app");
  const appSegments = appIndex >= 0 ? segments.slice(appIndex + 1) : segments;
  const routeSegments = appSegments.length > 0 ? appSegments : ["dashboard"];
  const showAdministration = administrationRoutes.has(routeSegments[0]);
  const showFleet = routeSegments[0] === "servers" || routeSegments[0] === "perf";
  const breadcrumbSegments = showAdministration
    ? ["administration", ...routeSegments]
    : showFleet
      ? ["fleet", ...routeSegments]
    : routeSegments;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {breadcrumbSegments.map((segment, index) => {
          const isLast = index === breadcrumbSegments.length - 1;
          const routeIndex = showAdministration || showFleet ? index - 1 : index;
          const href = `/${routeSegments.slice(0, routeIndex + 1).join("/")}`;
          return (
            <Fragment key={`${segment}-${index}`}>
              {index > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
              {segment === "administration" || segment === "fleet" ? (
                <span className="text-muted-foreground">Administration</span>
              ) : isLast ? (
                <BreadcrumbPage>{titleFor(segment)}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link href={href}>{titleFor(segment)}</Link>
                </BreadcrumbLink>
              )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
