"use client";

import { CloudOffIcon } from "lucide-react";
import { StatusMessage } from "./status-message";
import { RetryButton } from "./retry-button";

/** Shown when the status service could not answer; it retries on its own. */
export function StatusUnavailable({ reset }: { reset?: () => void }) {
  return (
    <StatusMessage
      title="Status can't be shown right now"
      icon={CloudOffIcon}
      action={<RetryButton reset={reset} />}
    >
      <p>
        This page couldn&apos;t load the latest status. It tries again every
        minute.
      </p>
    </StatusMessage>
  );
}
