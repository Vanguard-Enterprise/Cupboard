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
import { useOrganization } from "@/components/organization-provider";
import { dashboardNavigation } from "@/lib/dashboard-navigation";

// This is sample data.
const data = {
  user: { name: "Demo operator", email: "operator@example.com" },
};

export function AppSidebar({
  activeSection,
  onSearch,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  activeSection?: string;
  onSearch: () => void;
}) {
  const { profile } = useOrganization();
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher
          key={profile.name}
          teams={[
            {
              name: profile.name,
              logo: <Building2Icon />,
              plan: "Organization",
            },
          ]}
        />
        <OrganizationSearchButton onOpen={onSearch} />
      </SidebarHeader>
      <SidebarContent>
        {dashboardNavigation.map((group) => (
          <NavMain
            key={group.title}
            group={group}
            activeSection={activeSection}
          />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
