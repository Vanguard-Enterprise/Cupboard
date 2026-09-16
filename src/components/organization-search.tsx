"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
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
import { organizationSearchEntries } from "@/lib/organization-profile";
import {
  auditLogPath,
  notificationsDataPath,
} from "@/lib/dashboard-navigation";

export function OrganizationSearchButton({ onOpen }: { onOpen: () => void }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip="Search organization"
          aria-label="Search organization"
          onClick={() => {
            setOpenMobile(false);
            onOpen();
          }}
        >
          <SearchIcon />
          <span>Search organization</span>
          <kbd className="ml-auto text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            ⌘/Ctrl K
          </kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function OrganizationSearch({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { profile } = useOrganization();
  const router = useRouter();
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setOpen]);
  function navigate(href: string) {
    setOpen(false);
    router.push(href);
  }
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="overflow-hidden p-0 sm:max-w-xl"
          showCloseButton={false}
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
                  value="Dashboard overview"
                  onSelect={() => navigate("/dashboard")}
                >
                  Dashboard
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
                  Organization usage
                </CommandItem>
                <CommandItem
                  value="Organization security audit log events history access"
                  onSelect={() => navigate(auditLogPath)}
                >
                  Audit log
                </CommandItem>
                <CommandItem
                  value="Organization notifications data preferences browser storage"
                  onSelect={() => navigate(notificationsDataPath)}
                >
                  Notifications &amp; data
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
