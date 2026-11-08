import { SearchXIcon } from "lucide-react";
import { StatusMessage } from "../status-message";
import { GoBackButton } from "../go-back-button";

export const metadata = { title: "Status page not found" };

/** Missing and unpublished pages read the same, so nothing about either leaks. */
export default function StatusNotFound() {
  return (
    <StatusMessage
      title="This status page isn't available"
      icon={SearchXIcon}
      action={<GoBackButton />}
    >
      <p>
        The address may be mistyped, the page may have moved, or it isn&apos;t
        public yet.
      </p>
      <p>Check the link with the community or server that shared it.</p>
    </StatusMessage>
  );
}
