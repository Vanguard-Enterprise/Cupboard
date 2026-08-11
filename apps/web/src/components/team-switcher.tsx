"use client"

import * as React from "react"
import { switchOrgAction } from "@/lib/actions"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { ChevronDownIcon, PlusIcon } from "lucide-react"
import { TerminalIcon, AudioLinesIcon } from "lucide-react"

export function TeamSwitcher({
  teams,
}: {
  teams: {
    id: string
    name: string
    plan: string
  }[]
}) {
  const [activeTeam, setActiveTeam] = React.useState(teams[0])

  if (!activeTeam) {
    return null
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="w-full rounded-xl px-2 py-2 hover:bg-sidebar-accent">
              <div className="flex aspect-square size-7 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground shadow-[0_0_0_3px_rgb(255_255_255_/_8%)]">
                <TerminalIcon className="size-4" />
              </div>
              <span className="truncate text-sm font-semibold tracking-tight">{activeTeam.name}</span>
              <ChevronDownIcon className="ms-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-64 rounded-lg"
            align="start"
            side="bottom"
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Organizations
            </DropdownMenuLabel>
            {teams.map((team, index) => (
              <DropdownMenuItem
                key={team.id}
                onSelect={() => {
                  setActiveTeam(team)
                  const form = new FormData()
                  form.set("org_id", team.id)
                  React.startTransition(() => void switchOrgAction(form))
                }}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-xs border">
                  {index % 2 === 0 ? <TerminalIcon className="size-3.5" /> : <AudioLinesIcon className="size-3.5" />}
                </div>
                {team.name}
                <DropdownMenuShortcut>⌘{index + 1}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 p-2">
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <PlusIcon className="size-4" />
              </div>
              <div className="font-medium text-muted-foreground">Add organization</div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
