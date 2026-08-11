"use client"

import { PageSearch, type PageSearchItem } from "@/components/page-search"

export function SidebarSearch({ items }: { items: PageSearchItem[] }) {
  return <PageSearch items={items} trigger="sidebar" />
}
