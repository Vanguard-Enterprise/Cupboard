"use client";

import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDirection } from "@/components/ui/direction";

export function DirectionToggle({ compact = false }: { compact?: boolean }) {
  const direction = useDirection();
  const next = direction === "rtl" ? "ltr" : "rtl";

  return (
    <Button
      type="button"
      variant="ghost"
      size={compact ? "icon-sm" : "sm"}
      className={compact ? "shrink-0" : "w-full justify-start"}
      onClick={() => {
        document.cookie = `cb_direction=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
        window.location.reload();
      }}
      aria-label={`Switch to ${next.toUpperCase()} layout`}
    >
      <Languages />
      {!compact && (direction === "rtl" ? "Left-to-right" : "Right-to-left")}
    </Button>
  );
}
