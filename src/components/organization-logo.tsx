"use client";

import { Building2Icon } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useOrganizationLogo } from "@/hooks/use-organization-logo";

export function OrganizationLogo({
  organizationId,
}: {
  organizationId: string;
}) {
  const logo = useOrganizationLogo(organizationId, true);
  return (
    <Avatar className="size-8 rounded-lg after:rounded-lg">
      <AvatarImage
        src={logo.preview || undefined}
        alt="Organization logo"
        className="rounded-lg object-contain"
      />
      <AvatarFallback className="rounded-lg bg-surface-elevated">
        <Building2Icon className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}
