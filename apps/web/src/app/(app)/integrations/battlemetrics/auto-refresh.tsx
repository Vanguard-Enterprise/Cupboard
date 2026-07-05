"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Polls the server component while an import job is in flight, the last load failed,
// or inbound sync is on (so the tail/re-scan timestamps stay fresh). Stops the moment
// none of those hold. `intervalMs` defaults to the 3s job-watching cadence; callers
// pass a slower one (e.g. 15s) when the only reason to poll is sync's steady state.
export function AutoRefresh({
  active,
  intervalMs = 3000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);

  return null;
}
