"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Polls the server component while an import job is in flight, so phase/counts move
// without the user reloading. Stops the moment the job leaves queued/running.
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [active, router]);

  return null;
}
