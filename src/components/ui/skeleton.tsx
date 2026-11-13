import { cn } from "cn";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-muted motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A bordered list while its rows load: an icon, two lines of text, and a
 * trailing value per row, in the box the loaded list draws. `label` is what
 * screen readers hear in place of the rows.
 */
function SkeletonRows({
  label,
  rows = 3,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      data-slot="skeleton-rows"
      className={cn("divide-y overflow-hidden rounded-lg border", className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="flex min-h-16 items-center gap-3 px-4 py-3"
        >
          <Skeleton className="size-9 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-48 max-w-full" />
            <Skeleton className="h-3 w-28 max-w-full" />
          </div>
          <Skeleton className="hidden h-3.5 w-20 sm:block" />
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonRows };
