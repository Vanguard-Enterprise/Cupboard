"use client"

import * as React from "react"

import { NavSecondary } from "@/components/nav-secondary"
import { SidebarSearch } from "@/components/sidebar-search"
import { TeamSwitcher } from "@/components/team-switcher"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarRail,
} from "@/components/ui/sidebar"
import {
  ActivityIcon,
  AudioLinesIcon,
  BanIcon,
  BlocksIcon,
  CreditCardIcon,
  GaugeIcon,
  HomeIcon,
  KeyRoundIcon,
  MessageCircleQuestionIcon,
  NetworkIcon,
  PlugIcon,
  Settings2Icon,
  ShieldCheckIcon,
  StoreIcon,
  TerminalIcon,
  TicketIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"

// This is sample data.
const data = {
  teams: [
    {
      id: "acme",
      name: "Acme Inc",
      logo: (
        <TerminalIcon
        />
      ),
      plan: "Enterprise",
    },
    {
      id: "acme-corp",
      name: "Acme Corp.",
      logo: (
        <AudioLinesIcon
        />
      ),
      plan: "Startup",
    },
    {
      id: "evil",
      name: "Evil Corp.",
      logo: (
        <TerminalIcon
        />
      ),
      plan: "Free",
    },
  ],
  navSecondary: [
    { title: "Overview", url: "/dashboard", icon: <HomeIcon /> },
    { title: "Servers", url: "/servers", icon: <NetworkIcon />, permission: "servers.view" },
    { title: "Performance", url: "/perf", icon: <GaugeIcon />, permission: "servers.view" },
    { title: "Players", url: "/players", icon: <UsersIcon />, permission: "players.view" },
    { title: "Chat", url: "/chat", icon: <MessageCircleQuestionIcon />, permission: "players.view" },
    { title: "Reports", url: "/reports", icon: <ActivityIcon />, permission: "players.view" },
    { title: "Bans", url: "/bans", icon: <BanIcon />, permission: "bans.view" },
    { title: "Evasion alerts", url: "/evasion", icon: <ShieldCheckIcon />, permission: "bans.view" },
    { title: "Tickets", url: "/tickets", icon: <TicketIcon />, permission: "support.respond" },
    { title: "Integrations", url: "/integrations/battlemetrics", icon: <PlugIcon />, permission: "integrations.manage" },
    { title: "Site", url: "/site", icon: <BlocksIcon />, permission: "sites.edit" },
    { title: "Store", url: "/store", icon: <StoreIcon />, permission: "store.manage" },
    { title: "Members", url: "/staff", icon: <UsersIcon />, permission: "staff.manage" },
    { title: "Roles", url: "/roles", icon: <ShieldCheckIcon />, permission: "roles.manage" },
    { title: "API keys", url: "/api-keys", icon: <KeyRoundIcon />, permission: "api.manage" },
    { title: "Privacy", url: "/privacy", icon: <ShieldCheckIcon />, permission: "players.erase" },
    { title: "Billing", url: "/billing", icon: <CreditCardIcon />, permission: "billing.manage" },
    {
      title: "Settings",
      url: "#",
      icon: (
        <Settings2Icon
        />
      ),
    },
    {
      title: "Trash",
      url: "#",
      icon: (
        <Trash2Icon
        />
      ),
    },
    {
      title: "Help",
      url: "#",
      icon: (
        <MessageCircleQuestionIcon
        />
      ),
    },
  ],
  favorites: [
    {
      name: "Project Management & Task Tracking",
      url: "#",
      emoji: "📊",
    },
    {
      name: "Family Recipe Collection & Meal Planning",
      url: "#",
      emoji: "🍳",
    },
    {
      name: "Fitness Tracker & Workout Routines",
      url: "#",
      emoji: "💪",
    },
    {
      name: "Book Notes & Reading List",
      url: "#",
      emoji: "📚",
    },
    {
      name: "Sustainable Gardening Tips & Plant Care",
      url: "#",
      emoji: "🌱",
    },
    {
      name: "Language Learning Progress & Resources",
      url: "#",
      emoji: "🗣️",
    },
    {
      name: "Home Renovation Ideas & Budget Tracker",
      url: "#",
      emoji: "🏠",
    },
    {
      name: "Personal Finance & Investment Portfolio",
      url: "#",
      emoji: "💰",
    },
    {
      name: "Movie & TV Show Watchlist with Reviews",
      url: "#",
      emoji: "🎬",
    },
    {
      name: "Daily Habit Tracker & Goal Setting",
      url: "#",
      emoji: "✅",
    },
  ],
  workspaces: [
    {
      name: "Personal Life Management",
      emoji: "🏠",
      pages: [
        {
          name: "Daily Journal & Reflection",
          url: "#",
          emoji: "📔",
        },
        {
          name: "Health & Wellness Tracker",
          url: "#",
          emoji: "🍏",
        },
        {
          name: "Personal Growth & Learning Goals",
          url: "#",
          emoji: "🌟",
        },
      ],
    },
    {
      name: "Professional Development",
      emoji: "💼",
      pages: [
        {
          name: "Career Objectives & Milestones",
          url: "#",
          emoji: "🎯",
        },
        {
          name: "Skill Acquisition & Training Log",
          url: "#",
          emoji: "🧠",
        },
        {
          name: "Networking Contacts & Events",
          url: "#",
          emoji: "🤝",
        },
      ],
    },
    {
      name: "Creative Projects",
      emoji: "🎨",
      pages: [
        {
          name: "Writing Ideas & Story Outlines",
          url: "#",
          emoji: "✍️",
        },
        {
          name: "Art & Design Portfolio",
          url: "#",
          emoji: "🖼️",
        },
        {
          name: "Music Composition & Practice Log",
          url: "#",
          emoji: "🎵",
        },
      ],
    },
    {
      name: "Home Management",
      emoji: "🏡",
      pages: [
        {
          name: "Household Budget & Expense Tracking",
          url: "#",
          emoji: "💰",
        },
        {
          name: "Home Maintenance Schedule & Tasks",
          url: "#",
          emoji: "🔧",
        },
        {
          name: "Family Calendar & Event Planning",
          url: "#",
          emoji: "📅",
        },
      ],
    },
    {
      name: "Travel & Adventure",
      emoji: "🧳",
      pages: [
        {
          name: "Trip Planning & Itineraries",
          url: "#",
          emoji: "🗺️",
        },
        {
          name: "Travel Bucket List & Inspiration",
          url: "#",
          emoji: "🌎",
        },
        {
          name: "Travel Journal & Photo Gallery",
          url: "#",
          emoji: "📸",
        },
      ],
    },
  ],
}

export function SidebarLeft({
  teams = [
    { id: "acme", name: "Acme Inc", plan: "Enterprise" },
    { id: "acme-corp", name: "Acme Corp.", plan: "Startup" },
    { id: "evil", name: "Evil Corp.", plan: "Free" },
  ],
  permissions = [],
  user = { name: "Cupboard user", email: "", avatar: "" },
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  teams?: { id: string; name: string; plan: string }[]
  permissions?: string[]
  user?: { name: string; email: string; avatar: string }
}) {
  const visiblePages = data.navSecondary.filter(
    (item) => !("permission" in item) || !item.permission || permissions?.includes(item.permission),
  )
  const sections = [
    { label: "Overview", titles: ["Overview"] },
    { label: "Fleet Management", titles: ["Servers", "Performance"] },
    { label: "Operations", titles: ["Players", "Chat", "Reports", "Bans", "Evasion alerts", "Tickets"] },
    { label: "Commerce & sites", titles: ["Integrations", "Site", "Store", "Billing"] },
    { label: "Administration", titles: ["Members", "Roles", "API keys", "Privacy", "Settings"] },
    { label: "Tools", titles: ["Help"] },
  ].map((section) => ({
    label: section.label,
    items: visiblePages.filter((item) => section.titles.includes(item.title)),
  })).filter((section) => section.items.length > 0)
  return (
    <Sidebar className="border-e-0 bg-sidebar" {...props}>
      <SidebarHeader className="gap-3 border-b border-sidebar-border p-3">
        <TeamSwitcher teams={teams} />
        <SidebarSearch items={visiblePages.filter((item) => item.url !== "#")} />
      </SidebarHeader>
      <SidebarContent className="px-2 py-2">
        {sections.map((section) => (
          <NavSecondary
            key={section.label}
            label={section.label}
            items={section.items}
            className={section.label === "Tools" ? "mt-auto py-1" : "py-1"}
          />
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-2">
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
