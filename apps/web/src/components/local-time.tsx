"use client"

import { useEffect, useState } from "react"
import { CalendarClockIcon } from "lucide-react"

const formatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

export function LocalTime() {
  const [value, setValue] = useState("")

  useEffect(() => {
    const update = () => setValue(formatter.format(new Date()))
    update()
    const timer = window.setInterval(update, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex" aria-label="Your local time">
      <CalendarClockIcon className="size-3.5" aria-hidden="true" />
      {value || "—"}
    </span>
  )
}
