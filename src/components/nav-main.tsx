"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ServerIcon,
  HardDriveIcon,
  ChartNoAxesCombinedIcon,
  FolderIcon,
  UsersIcon,
  GavelIcon,
  LifeBuoyIcon,
  ShoppingBagIcon,
  MessageSquareIcon,
  UsersRoundIcon,
  ListTodoIcon,
  PlugIcon,
  ShieldCheckIcon,
  Settings2Icon,
  ChevronRightIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  navigationHref,
  dashboardNavigation,
} from "@/lib/dashboard-navigation";

const icons: Record<string, LucideIcon> = {
  servers: ServerIcon,
  infrastructure: HardDriveIcon,
  metrics: ChartNoAxesCombinedIcon,
  files: FolderIcon,
  players: UsersIcon,
  moderation: GavelIcon,
  support: LifeBuoyIcon,
  store: ShoppingBagIcon,
  discord: MessageSquareIcon,
  members: UsersRoundIcon,
  projects: ListTodoIcon,
  integrations: PlugIcon,
  security: ShieldCheckIcon,
  settings: Settings2Icon,
};
type NavigationGroup = (typeof dashboardNavigation)[number];

function NavSection({
  item,
  activeSection,
}: {
  item: NavigationGroup["items"][number];
  activeSection?: string;
}) {
  const active = item.sections.some((section) => section.id === activeSection);
  const [open, setOpen] = useState(active);
  const {
    state,
    setOpen: setSidebarOpen,
    isMobile,
    setOpenMobile,
  } = useSidebar();
  const Icon = icons[item.icon];

  return (
    <Collapsible
      asChild
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isMobile && state === "collapsed") {
          setSidebarOpen(true);
          setOpen(true);
        } else {
          setOpen(nextOpen);
        }
      }}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title} isActive={active}>
            <Icon />
            <span>{item.title}</span>
            <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.sections.map((section) => (
              <SidebarMenuSubItem key={section.id}>
                {navigationHref(section.id) ? (
                  <SidebarMenuSubButton
                    asChild
                    isActive={section.id === activeSection}
                  >
                    <Link
                      href={navigationHref(section.id)!}
                      aria-current={
                        section.id === activeSection ? "page" : undefined
                      }
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                    >
                      <span>{section.title}</span>
                    </Link>
                  </SidebarMenuSubButton>
                ) : (
                  <span
                    aria-disabled="true"
                    className="flex h-7 items-center px-2 text-xs text-muted-foreground/60"
                  >
                    {section.title}
                  </span>
                )}
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

export function NavMain({
  group,
  activeSection,
}: {
  group: NavigationGroup;
  activeSection?: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
      <SidebarMenu>
        {group.items.map((item) => (
          <NavSection
            key={`${item.title}-${activeSection ?? "overview"}`}
            item={item}
            activeSection={activeSection}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
