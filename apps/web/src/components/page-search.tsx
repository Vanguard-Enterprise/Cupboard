"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { CommandIcon, SearchIcon } from "lucide-react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export type PageSearchItem = {
  title: string
  url: string
  icon: ReactNode
  description?: string
}

export function PageSearch({
  items,
  enableShortcut = true,
  trigger = "button",
  label = "Quick actions",
}: {
  items: PageSearchItem[]
  enableShortcut?: boolean
  trigger?: "sidebar" | "button"
  label?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!enableShortcut) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enableShortcut])

  return (
    <>
      {trigger === "sidebar" ? (
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground"
              aria-label="Search pages"
            >
              <SearchIcon />
              <span>Search</span>
              <SidebarMenuBadge>⌘K</SidebarMenuBadge>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <CommandIcon aria-hidden="true" />
          {label}
        </Button>
      )}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search pages"
        description="Find a Cupboard page to open. Command actions will be added later."
      >
        <Command>
          <CommandInput placeholder="Search pages..." />
          <CommandList>
            <CommandEmpty>No matching pages.</CommandEmpty>
            <CommandGroup heading="Suggested pages">
              {items.map((item) => (
                <CommandItem
                  key={`${item.url}-${item.title}`}
                  value={`${item.title} ${item.description ?? ""} ${item.url}`}
                  onSelect={() => {
                    setOpen(false)
                    router.push(item.url)
                  }}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.description && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{item.description}</span>}
                  <CommandShortcut>↵</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
