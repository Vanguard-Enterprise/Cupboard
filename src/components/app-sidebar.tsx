"use client";

import * as React from "react";

import { OrganizationSearchButton } from "@/components/organization-search";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Building2Icon } from "lucide-react";
import { navigateAfterAuth, apiRequest, type Identity } from "@/lib/api-client";
import { toast } from "sonner";
import { dashboardNavigation } from "@/lib/dashboard-navigation";

export function AppSidebar({
  activeSection,
  onSearch,
  identity,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  activeSection?: string;
  onSearch: () => void;
  identity: Identity;
}) {
  const [switching, setSwitching] = React.useState(false);
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher
          activeId={identity.organization?.id ?? ""}
          disabled={switching}
          teams={identity.organizations.map((org) => ({
            id: org.id,
            name: org.name,
            logo: <Building2Icon />,
            plan: "Organization",
          }))}
          onChange={async (id) => {
            setSwitching(true);
            try {
              await apiRequest("auth/organization", { id });
              navigateAfterAuth("/dashboard");
            } catch (error) {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Could not switch organization.",
              );
              setSwitching(false);
            }
          }}
        />
        <OrganizationSearchButton
          onOpen={onSearch}
          disabled={!identity.organization}
        />
      </SidebarHeader>
      <SidebarContent>
        {dashboardNavigation.map((group) => (
          <NavMain
            key={group.title}
            group={group}
            disabled={!identity.organization}
            activeSection={activeSection}
          />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={identity.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
