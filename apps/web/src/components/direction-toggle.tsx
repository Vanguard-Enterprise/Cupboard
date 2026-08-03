"use client";

import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDirection } from "@/components/ui/direction";

export function DirectionToggle() {
  const direction = useDirection();
  const next = direction === "rtl" ? "ltr" : "rtl";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="w-full justify-start"
      onClick={() => {
        document.cookie = `cb_direction=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
        window.location.reload();
      }}
      aria-label={`Switch to ${next.toUpperCase()} layout`}
    >
      <Languages />
      {direction === "rtl" ? "Left-to-right" : "Right-to-left"}
    </Button>
  );
}
