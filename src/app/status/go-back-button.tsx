"use client";

import { useSyncExternalStore } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { statusMessageButton } from "./status-message";

const subscribeNothing = () => () => {};

/**
 * Returns visitors to the page that linked here. It renders only when the
 * browser has somewhere to go back to, so a pasted address shows no dead
 * button.
 */
export function GoBackButton() {
  const canGoBack = useSyncExternalStore(
    subscribeNothing,
    () => document.referrer !== "" && window.history.length > 1,
    () => false,
  );
  if (!canGoBack) return null;
  return (
    <button
      type="button"
      onClick={() => window.history.back()}
      className={statusMessageButton}
    >
      <ArrowLeftIcon aria-hidden="true" className="size-4" />
      Go back
    </button>
  );
}
