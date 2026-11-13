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
  type NavigationGroup,
  type NavigationItem,
  type NavigationSection,
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
/** An area with one page: a plain button, no dropdown. */
function NavLink({
  item,
  id,
  activeSection,
  disabled,
}: {
  item: NavigationItem;
  id: string;
  activeSection?: string;
  disabled?: boolean;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const Icon = icons[item.icon];
  const href = navigationHref(id);
  const active = id === activeSection;
  return (
    <SidebarMenuItem>
      {!disabled && href ? (
        <SidebarMenuButton asChild tooltip={item.title} isActive={active}>
          <Link
            href={href}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
            }}
          >
            <Icon />
            <span>{item.title}</span>
          </Link>
        </SidebarMenuButton>
      ) : (
        // Not built yet, or no organization: shown, but not a link.
        <SidebarMenuButton
          tooltip={item.title}
          aria-disabled="true"
          className="text-muted-foreground/60"
        >
          <Icon />
          <span>{item.title}</span>
        </SidebarMenuButton>
      )}
    </SidebarMenuItem>
  );
}

function NavSection({
  item,
  sections,
  activeSection,
  disabled,
}: {
  item: NavigationItem;
  sections: NavigationSection[];
  activeSection?: string;
  disabled?: boolean;
}) {
  const active = sections.some((section) => section.id === activeSection);
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
          <SidebarMenuButton
            tooltip={item.title}
            isActive={active}
            disabled={disabled}
          >
            <Icon />
            <span>{item.title}</span>
            <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sections.map((section) => (
              <SidebarMenuSubItem key={section.id}>
                {!disabled && navigationHref(section.id) ? (
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
  disabled,
}: {
  group: NavigationGroup;
  activeSection?: string;
  disabled?: boolean;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
      <SidebarMenu>
        {group.items.map((item) =>
          item.sections ? (
            <NavSection
              key={`${item.title}-${activeSection ?? "overview"}`}
              item={item}
              sections={item.sections}
              activeSection={activeSection}
              disabled={disabled}
            />
          ) : (
            <NavLink
              key={item.title}
              item={item}
              id={item.id}
              activeSection={activeSection}
              disabled={disabled}
            />
          ),
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
