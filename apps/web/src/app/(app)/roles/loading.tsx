import { Skeleton } from "@/components/ui/skeleton";

export default function RolesLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6" aria-busy="true" aria-label="Loading roles">
      <div className="space-y-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-4 w-44" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-9 w-full max-w-xs" />
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="border-b border-border bg-muted/30 p-3"><Skeleton className="h-4 w-full" /></div>
        <div className="space-y-px p-3">
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-14 w-full" />)}
        </div>
      </div>
    </div>
  );
}
