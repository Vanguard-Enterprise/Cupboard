import { OrganizationAccess } from "@/components/organization-access";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InfoIcon } from "lucide-react";

export const metadata = { title: "Access and approvals | Cupboard" };

export default function OrganizationAccessPage() {
  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 py-6 md:px-6 md:py-8">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Access &amp; approvals
        </h1>
        <Tooltip disableHoverableContent>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              tabIndex={0}
              className="gap-1.5 border-border/60 bg-transparent text-text-muted/80"
            >
              Sample data
              <InfoIcon aria-hidden="true" />
            </Badge>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            sideOffset={8}
            className="max-w-64 border border-border bg-popover text-foreground shadow-lg"
          >
            This browser stores the sample. It does not grant access or send
            invitations.
          </TooltipContent>
        </Tooltip>
      </div>
      <OrganizationAccess />
    </div>
  );
}
