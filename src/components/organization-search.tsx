"use client";

import { useEffect, useRef } from "react";
import { CommandIcon, SearchIcon } from "lucide-react";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { useOrganization } from "@/components/organization-provider";
import { useGuardedNavigation } from "@/components/ui/unsaved-changes";
import { organizationSearchEntries } from "@/lib/organization-profile";
import {
  accessPath,
  auditLogPath,
  connectionsPath,
  alertsPath,
  rolesPath,
  serversPath,
  machinesPath,
  maintenancePath,
  usersPath,
} from "@/lib/dashboard-navigation";

export function OrganizationSearchButton({
  onOpen,
  disabled,
}: {
  onOpen: () => void;
  disabled?: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          disabled={disabled}
          tooltip="Search organization"
          aria-label="Search organization"
          onClick={() => {
            setOpenMobile(false);
            onOpen();
          }}
        >
          <SearchIcon />
          <span>Search organization</span>
          <kbd className="inline-flex items-center gap-0.5 font-sans ml-auto text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            <CommandIcon aria-hidden="true" className="size-3" />
            <span className="sr-only">Command or</span>/Ctrl K
          </kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * Whether a modal layer other than this search is open: a confirmation such
 * as the leave prompt, or any other modal dialog or sheet.
 */
function otherModalOpen() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="alertdialog"][data-state="open"], [role="dialog"][data-state="open"]',
    ),
  ).some((layer) => !layer.closest("[data-organization-search]"));
}

export function OrganizationSearch({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { profile } = useOrganization();
  const guard = useGuardedNavigation();
  // With unsaved edits, the leave prompt waits until this menu has closed and
  // returned focus, so Cancel lands back where the operator was.
  const afterClose = useRef<string | null>(null);
  // The menu has no trigger to return to (Ctrl+K opens it from anywhere), so
  // closing puts focus back on whatever the operator was using.
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // A confirmation or another modal dialog owns focus until it is
        // answered, so the shortcut waits instead of stacking over it.
        if (otherModalOpen()) return;
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setOpen]);
  function navigate(href: string) {
    setOpen(false);
    if (guard.dirty) afterClose.current = href;
    else guard.push(href);
  }
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-organization-search=""
          className="overflow-hidden p-0 sm:max-w-xl"
          showCloseButton={false}
          onOpenAutoFocus={() => {
            returnTo.current =
              document.activeElement instanceof HTMLElement &&
              document.activeElement !== document.body
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            const target = returnTo.current;
            returnTo.current = null;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
            const href = afterClose.current;
            afterClose.current = null;
            if (href) window.setTimeout(() => guard.push(href), 0);
          }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Search organization</DialogTitle>
            <DialogDescription>
              Search organization details, public contacts, and available pages.
            </DialogDescription>
          </DialogHeader>
          <Command>
            <CommandInput
              placeholder={`Search ${profile.name}...`}
              aria-label="Search organization information"
            />
            <CommandList className="max-h-[min(60vh,24rem)]">
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Pages">
                <CommandItem
                  value="Machines nodes infrastructure hosts"
                  onSelect={() => navigate(machinesPath)}
                >
                  Machines
                </CommandItem>
                <CommandItem
                  value="Status page maintenance uptime windows"
                  onSelect={() => navigate(maintenancePath)}
                >
                  Status page
                </CommandItem>
                <CommandItem
                  value="Dashboard overview"
                  onSelect={() => navigate("/dashboard")}
                >
                  Dashboard
                </CommandItem>
                <CommandItem
                  value="Game servers inventory Rust RCON A2S servers"
                  onSelect={() => navigate(serversPath)}
                >
                  Game servers
                </CommandItem>
                <CommandItem
                  value="Organization settings profile contacts"
                  onSelect={() =>
                    navigate("/dashboard/organization/settings/profile")
                  }
                >
                  Organization settings
                </CommandItem>
                <CommandItem
                  value="Organization usage activity capacity billing"
                  onSelect={() =>
                    navigate("/dashboard/organization/settings/usage")
                  }
                >
                  Billing &amp; usage
                </CommandItem>
                <CommandItem
                  value="Organization integrations API credentials webhooks"
                  onSelect={() =>
                    navigate("/dashboard/organization/integrations/credentials")
                  }
                >
                  Credentials &amp; webhooks
                </CommandItem>
                <CommandItem
                  value="Security alerts findings risk incidents servers"
                  onSelect={() =>
                    navigate("/dashboard/organization/security/alerts")
                  }
                >
                  Security alerts
                </CommandItem>
                <CommandItem
                  value="Organization security audit log events history access"
                  onSelect={() => navigate(auditLogPath)}
                >
                  Audit log
                </CommandItem>
                <CommandItem
                  value="Organization security approvals sensitive actions"
                  onSelect={() => navigate(accessPath)}
                >
                  Approvals
                </CommandItem>
                <CommandItem
                  value="Organization team users members invitations access"
                  onSelect={() => navigate(usersPath)}
                >
                  Users
                </CommandItem>
                <CommandItem
                  value="Organization team roles permissions access"
                  onSelect={() => navigate(rolesPath)}
                >
                  Roles
                </CommandItem>
                <CommandItem
                  value="Organization integrations connections external services"
                  onSelect={() => navigate(connectionsPath)}
                >
                  Connections
                </CommandItem>
                <CommandItem
                  value="Organization alerts notifications discord webhooks data export retention"
                  onSelect={() => navigate(alertsPath)}
                >
                  Alerts &amp; data
                </CommandItem>
              </CommandGroup>
              <CommandGroup heading="Organization information">
                {organizationSearchEntries(profile).map((entry) => (
                  <CommandItem
                    key={entry.title}
                    value={`${entry.title} ${entry.detail} ${entry.keywords}`}
                    onSelect={() => navigate(entry.href)}
                  >
                    <div className="min-w-0">
                      <p className="truncate">{entry.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {entry.detail}
                      </p>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
