"use client";

import { StatusUnavailable } from "../status-unavailable";

export default function StatusError({ reset }: { reset: () => void }) {
  return <StatusUnavailable reset={reset} />;
}
