"use client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontalIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import type { ApiCredential } from "@/lib/organization-integrations";

export function CredentialRow({
  credential,
  onRotate,
  onRevoke,
  disabled,
}: {
  credential: ApiCredential;
  onRotate: (credential: ApiCredential) => void;
  onRevoke: (credential: ApiCredential) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-3 px-5 py-4 sm:px-6 md:grid-cols-[minmax(0,1.4fr)_10rem_10rem_auto] md:items-center">
      <div className="min-w-0">
        <p className="font-medium">{credential.name}</p>
        <code className="mt-1.5 block font-mono text-xs text-muted-foreground">
          {credential.prefix}
        </code>
      </div>
      <div className="grid grid-cols-[5rem_1fr] items-baseline gap-2 md:block">
        <p className="text-xs text-text-muted">Created</p>
        <p className="text-sm text-muted-foreground md:mt-1">
          {credential.createdAt}
        </p>
      </div>
      <div className="grid grid-cols-[5rem_1fr] items-baseline gap-2 md:block">
        <p className="text-xs text-text-muted">Last used</p>
        <p className="text-sm text-muted-foreground md:mt-1">
          {credential.lastUsed ?? "Never used"}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-9 justify-self-start text-text-muted [@media(any-pointer:coarse)]:size-11 md:justify-self-end"
            aria-label={`Credential actions for ${credential.name}`}
            disabled={disabled}
          >
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem
            className="cursor-pointer"
            onSelect={() => onRotate(credential)}
          >
            <RefreshCwIcon aria-hidden="true" />
            Rotate key
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            className="cursor-pointer"
            onSelect={() => onRevoke(credential)}
          >
            <Trash2Icon aria-hidden="true" />
            Revoke
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
