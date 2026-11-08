"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { statusMessageButton } from "./status-message";

/** Retries now on request and again every minute while the page is open. */
export function RetryButton({ reset }: { reset?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const retryNow = () =>
    startTransition(() => {
      router.refresh();
      reset?.();
    });
  // The interval reads the latest retry without restarting on every render.
  const retry = useRef(retryNow);
  useEffect(() => {
    retry.current = retryNow;
  });
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") retry.current();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={retryNow}
      className={statusMessageButton}
    >
      <RefreshCwIcon
        aria-hidden="true"
        className={cn("size-4", pending && "motion-safe:animate-spin")}
      />
      {pending ? "Trying again..." : "Try again"}
    </button>
  );
}
