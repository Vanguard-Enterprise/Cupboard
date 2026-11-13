"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { flushSync } from "react-dom";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";

/** Phones, where a top toast spans the screen over the page header. */
const PHONE = "(max-width: 639px)";
/**
 * Tablets, where the top-right corner holds the breadcrumb and, just below
 * it, the page title's own pills (a11y D-78). From 1280 that corner is free.
 */
const TABLET = "(min-width: 640px) and (max-width: 1279px)";
type Position = NonNullable<ToasterProps["position"]>;
const useMedia = (media: string) =>
  React.useSyncExternalStore(
    (change) => {
      const query = window.matchMedia(media);
      query.addEventListener("change", change);
      return () => query.removeEventListener("change", change);
    },
    () => window.matchMedia(media).matches,
    () => false,
  );

/** Space below bottom toasts: clear of the home indicator, plus a gap. */
const bottomGap = (gap: number) =>
  `calc(env(safe-area-inset-bottom, 0px) + ${gap}px)`;

const shown = () => [
  ...document.querySelectorAll<HTMLElement>(
    "[data-sonner-toast][data-visible=true]:not([data-removed=true])",
  ),
];
/**
 * Where a toast comes to rest: its box without the slide Sonner is still
 * running, so the place is decided before the toast has finished arriving.
 */
function restingBox(toast: HTMLElement) {
  const box = toast.getBoundingClientRect();
  const { transform } = getComputedStyle(toast);
  if (
    !transform ||
    transform === "none" ||
    typeof DOMMatrixReadOnly !== "function"
  )
    return box;
  const { m41, m42 } = new DOMMatrixReadOnly(transform);
  return new DOMRect(box.x - m41, box.y - m42, box.width, box.height);
}

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The control in focus, unless focus is on the page or in a toast. */
function focusedBox() {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || target === document.body) return null;
  if (target.closest("[data-sonner-toaster]")) return null;
  return target.getBoundingClientRect();
}

/**
 * Where toasts sit while they show: Sonner's position (fixed for their
 * whole life, since a new one remounts them and screen readers say them
 * again) and, when their home would have hidden the control in focus, the
 * offset that puts them at the other end of the same edge.
 */
type Placement = { position: Position; gap: number; offset?: Offset };
type Offset = { top?: string; bottom?: string };

/**
 * Decides where toasts go once, when the first one appears (a11y D-R8-01,
 * D-R8-02, claude D-95, codex D-49): at home, unless home would hide the
 * control in focus and the other end of the same edge would not. Bottom
 * center goes to top center, bottom right to top right, top right to bottom
 * right. Toasts that arrive while others show join them. Nothing moves a
 * toast after that: not focus, scrolling, resizing, or another control;
 * Escape and its close button dismiss it. Once every toast has gone, the
 * next one starts from home again.
 */
function usePlacement(home: Placement) {
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const homeRef = React.useRef(home);
  React.useEffect(() => {
    homeRef.current = home;
  }, [home]);
  React.useEffect(() => {
    let decided = false;
    const region = document.querySelector(
      'section[aria-label^="Notifications"]',
    );
    const decide = () => {
      if (!region) return;
      if (decided) {
        // Leaving toasts keep their place until they are gone.
        if (region.querySelector("[data-sonner-toast]")) return;
        decided = false;
        setPlacement(null);
        return;
      }
      const toasts = shown();
      if (!toasts.length) return;
      decided = true;
      const at = homeRef.current;
      const boxes = toasts.map(restingBox);
      const top = Math.min(...boxes.map((box) => box.top));
      const height = Math.max(...boxes.map((box) => box.height));
      const box = new DOMRect(boxes[0]!.left, top, boxes[0]!.width, height);
      const focused = focusedBox();
      let offset: Offset | undefined;
      if (focused && overlaps(box, focused)) {
        // A toast can ask for its own place (Machines' refresh failures sit
        // top right on every width): its list's edge is the one that counts.
        const list = toasts[0]!.closest<HTMLElement>("[data-sonner-toaster]");
        const fromTop = list?.dataset.yPosition
          ? list.dataset.yPosition === "top"
          : at.position.startsWith("top");
        const otherTop = fromTop
          ? window.innerHeight - at.gap - height
          : at.gap;
        const other = new DOMRect(box.left, otherTop, box.width, height);
        if (otherTop >= 0 && !overlaps(other, focused))
          offset = fromTop
            ? { top: `${Math.round(otherTop)}px` }
            : {
                bottom: `${Math.round(window.innerHeight - at.gap - height)}px`,
              };
      }
      // Applied before the toast is first painted, so it appears in place.
      flushSync(() => setPlacement({ ...at, offset }));
    };
    const observer = new MutationObserver(decide);
    if (region)
      observer.observe(region, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-removed", "data-visible"],
      });
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (shown().length === 0) return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]',
        )
      )
        return;
      toast.dismiss();
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", keyDown);
    };
  }, []);
  return placement ?? home;
}

/**
 * Toasts are for events the operator didn't just trigger in view (a
 * refresh failing, a session expiring). Each width has one home: top right
 * from 1280 pixels, bottom right on tablets (the top corner holds the
 * breadcrumb and title pills), and bottom center on phones; pass `position` to choose another. A toast never moves after it
 * appears (see `usePlacement`). Every toast has a close button, a countdown
 * line, and swipes away; Escape closes them.
 */
const Toaster = ({ position, style, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const phone = useMedia(PHONE);
  const tablet = useMedia(TABLET);
  const place: Position =
    position ??
    (phone ? "bottom-center" : tablet ? "bottom-right" : "top-right");
  const gap = phone ? 16 : 24;
  const home = React.useMemo<Placement>(
    () => ({ position: place, gap }),
    [place, gap],
  );
  const at = usePlacement(home);
  const offset = {
    top: at.offset?.top ?? `${at.gap}px`,
    bottom: at.offset?.bottom ?? bottomGap(at.gap),
  };

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position={at.position}
      offset={offset}
      mobileOffset={offset}
      // Matches the countdown line in globals.css.
      duration={4000}
      // Any direction swipes a toast away, sideways included at the top
      // center, where Sonner alone would only take an upward swipe.
      swipeDirections={["left", "right", "top", "bottom"]}
      closeButton
      toastOptions={{
        closeButtonAriaLabel: "Dismiss notification",
        classNames: {
          toast: "cn-toast",
          // Sonner colors descriptions for its own themes, not ours: dark
          // gray on our dark popover. The secondary text token reads on both.
          description: "text-muted-foreground!",
        },
      }}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
        close: <XIcon aria-hidden="true" className="size-4" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // Sonner's 356 plus room for the close button, so a one-line
          // message stays one line.
          "--width": "388px",
          ...style,
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
