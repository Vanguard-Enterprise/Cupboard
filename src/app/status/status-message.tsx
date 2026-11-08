import type { ComponentType, ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

const focus =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground";

/**
 * A full-page message for status addresses that cannot show a page: the
 * page is missing, unpublished, or could not load. The page's own branding
 * is unknown here, so it follows the visitor's device theme.
 */
export function StatusMessage({
  title,
  icon: Icon,
  children,
  action,
}: {
  title: string;
  /** A muted glyph above the heading that names the case at a glance. */
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      data-status-page=""
      className="theme-system flex min-h-screen flex-col bg-background text-foreground supports-[min-height:100svh]:min-h-svh"
    >
      {/* The bar every status page starts with. The page's own accent is
          unknown here, so it is Cupboard's. */}
      <div aria-hidden="true" className="h-1 shrink-0 bg-primary" />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
        <span className="mb-5 flex size-11 items-center justify-center rounded-xl border border-border-strong bg-card text-muted-foreground">
          <Icon aria-hidden className="size-5" />
        </span>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight text-balance">
          {title}
        </h1>
        <div className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
          {children}
        </div>
        {action && <div className="mt-6 empty:hidden">{action}</div>}
      </main>
      {/* Like the status page: a rule across the window, one line centered
          under it, its link's hit box reaching into the padding. */}
      <footer className="border-t border-border">
        <p className="flex items-center justify-center gap-1 px-4 py-5 text-[0.8125rem] leading-5 text-muted-foreground">
          <span>Status pages by</span>
          <Link
            href="/"
            className={cn(
              "-my-1.5 inline-flex min-h-8 items-center gap-1.5 rounded-md px-1.5 font-medium text-foreground underline-offset-4 hover:underline [@media(any-pointer:coarse)]:-my-3 [@media(any-pointer:coarse)]:min-h-11",
              focus,
            )}
          >
            <Image
              src="/images/cupboard-logo.png"
              alt=""
              width={16}
              height={16}
              className="size-4"
            />
            Cupboard
          </Link>
        </p>
      </footer>
    </div>
  );
}

export const statusMessageButton = cn(
  "inline-flex h-10 items-center gap-2 rounded-lg border border-border-strong bg-card px-4 text-sm font-medium transition-[background-color] hover:bg-surface-elevated disabled:opacity-70 [@media(any-pointer:coarse)]:min-h-11",
  focus,
);
