import { OrganizationIntegrations } from "@/components/organization-integrations";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InfoIcon } from "lucide-react";

export const metadata = { title: "Credentials and webhooks | Cupboard" };

export default function CredentialsAndWebhooksPage() {
  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-6 md:px-6 md:py-8">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Credentials &amp; webhooks
        </h1>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="About sample data"
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-surface-elevated px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:border-border-strong hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <InfoIcon className="size-3" aria-hidden="true" />
              Sample data
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 leading-5" sideOffset={6}>
            This preview stores changes in this browser. Use sample values until
            shared storage is connected.
          </TooltipContent>
        </Tooltip>
      </div>
      <OrganizationIntegrations />
    </div>
  );
}
