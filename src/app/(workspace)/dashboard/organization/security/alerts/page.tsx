import { SecurityAlerts } from "@/components/security-alerts";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { InfoIcon } from "lucide-react";

export const metadata = { title: "Security alerts | Cupboard" };

export default function SecurityAlertsPage() {
  return (
    <div className="mx-auto w-[calc(100%-2rem)] max-w-[1400px] py-6 md:w-[calc(100%-4rem)] md:py-8">
      <div className="mb-4 flex items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          Security alerts
        </h1>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="About sample security alerts"
              className="inline-flex min-h-8 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Badge
                variant="outline"
                className="h-4 gap-1 border-border/40 bg-transparent px-1.5 text-[9px] font-normal text-text-muted"
              >
                Sample data
                <InfoIcon className="size-2.5" aria-hidden="true" />
              </Badge>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="bottom"
            sideOffset={4}
            className="w-auto max-w-72"
          >
            Findings are examples. Acknowledgements stay in this browser.
          </PopoverContent>
        </Popover>
      </div>
      <SecurityAlerts />
    </div>
  );
}
