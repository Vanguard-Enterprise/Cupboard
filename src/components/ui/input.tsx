import * as React from "react";
import { cn } from "cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-lg any-pointer-coarse:min-h-11 border border-input hover:border-input-hover bg-input-background px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-input-background file:text-sm file:font-medium file:text-foreground placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-elevated disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input-background dark:disabled:bg-surface-elevated dark:aria-invalid:border-destructive dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A field box that holds a bare input beside an icon, prefix, or swatch: the
 * TimeField's clock, the public address's "/status/", the accent's swatch.
 * It draws the field edge, hover, focus ring, and invalid edge, is 40 pixels
 * tall (44 on touch), and a press anywhere in it that isn't on a control
 * puts the caret in its input.
 */
function InputFrame({
  className,
  onMouseDown,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-frame"
      className={cn(
        "flex h-10 w-full min-w-0 cursor-text items-center gap-2 rounded-lg border border-input bg-input-background px-3 transition-colors hover:border-input-hover focus-within:border-ring focus-within:ring-2 focus-within:ring-ring has-aria-invalid:border-destructive [@media(any-pointer:coarse)]:h-11",
        className,
      )}
      onMouseDown={(event) => {
        onMouseDown?.(event);
        const target = event.target as HTMLElement;
        if (
          event.defaultPrevented ||
          target.closest("input, textarea, button, a, [role=button]")
        )
          return;
        const input = event.currentTarget.querySelector("input");
        if (!input || input.disabled) return;
        // Keep the press from blurring the input it is about to focus.
        event.preventDefault();
        input.focus();
      }}
      {...props}
    />
  );
}

/**
 * The input inside an InputFrame. It covers the frame's edge too, so its own
 * box is the full 40 or 44 pixels rather than 2 pixels short. Its text is
 * 16 pixels below 768 like `Input`, so phones don't zoom in on focus.
 */
function InputFrameControl({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input-frame-control"
      className={cn(
        "-my-px h-[calc(100%+2px)] min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-text-muted md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Input, InputFrame, InputFrameControl };
