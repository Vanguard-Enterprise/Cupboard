"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Toggle as TogglePrimitive } from "radix-ui";

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-muted data-[state=on]:bg-muted dark:aria-invalid:ring-destructive/40 forced-colors:aria-pressed:bg-[Highlight] forced-colors:aria-pressed:text-[HighlightText] forced-colors:aria-pressed:forced-color-adjust-none forced-colors:data-[state=on]:bg-[Highlight] forced-colors:data-[state=on]:text-[HighlightText] forced-colors:data-[state=on]:forced-color-adjust-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent hover:bg-muted",
        /**
         * One cell of a segmented control (inside a segmented ToggleGroup).
         * The chosen cell is filled, bold, and edged in `input-hover`
         * (4.3:1 or more against the track), so the choice reads without color.
         * In forced colors (Windows contrast themes) every chosen toggle is
         * drawn in the system Highlight colors instead.
         */
        segmented:
          "min-w-0 flex-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground data-[state=on]:bg-border data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:inset-ring data-[state=on]:inset-ring-input-hover data-[state=on]:hover:bg-border [@media(any-pointer:coarse)]:min-h-11",
      },
      size: {
        default:
          "h-10 min-w-10 px-3 any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-8 min-w-8 rounded-md px-2.5 any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 min-w-11 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
