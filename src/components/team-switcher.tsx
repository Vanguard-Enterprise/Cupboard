"use client";

import * as React from "react";
import { OrganizationLogo } from "./organization-logo";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Building2Icon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";

export function TeamSwitcher({
  teams,
  activeId,
  disabled,
  onChange,
}: {
  activeId: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  teams: {
    id: string;
    name: string;
    logo: React.ReactNode;
    plan: string;
  }[];
}) {
  const [creating, setCreating] = React.useState(false);
  const { isMobile } = useSidebar();
  const activeTeam = teams.find((team) => team.id === activeId) ?? {
    name: "Cupboard",
    plan: "No organization",
    logo: <Building2Icon />,
  };

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                disabled={disabled}
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-surface-elevated text-foreground">
                  {activeId ? (
                    <OrganizationLogo
                      key={activeId}
                      organizationId={activeId}
                    />
                  ) : (
                    activeTeam.logo
                  )}
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">
                    {activeTeam.name}
                  </span>
                  <span className="truncate text-xs">{activeTeam.plan}</span>
                </div>
                <ChevronsUpDownIcon className="ml-auto" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-fit"
              align="start"
              side={isMobile ? "bottom" : "right"}
              sideOffset={4}
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Organizations
              </DropdownMenuLabel>
              {teams.map((team) => (
                <DropdownMenuItem
                  key={team.id}
                  onClick={() => onChange(team.id)}
                  className="gap-2 p-2"
                >
                  <div className="flex size-6 items-center justify-center rounded-md border">
                    {team.logo}
                  </div>
                  {team.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setCreating(true)}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <PlusIcon className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">
                  Create organization
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <CreateOrganizationDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
