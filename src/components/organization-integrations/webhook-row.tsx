"use client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  EyeIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { WebhookEndpoint } from "@/lib/organization-integrations";

export function WebhookRow({
  webhook,
  onOpen,
  onEdit,
  onToggle,
  onDelete,
  disabled,
}: {
  webhook: WebhookEndpoint;
  onOpen: (webhook: WebhookEndpoint) => void;
  onEdit: (webhook: WebhookEndpoint) => void;
  onToggle: (webhook: WebhookEndpoint) => void;
  onDelete: (webhook: WebhookEndpoint) => void;
  disabled: boolean;
}) {
  const failed = Boolean(
    webhook.lastDelivery && webhook.lastDelivery.status >= 400,
  );
  const status = !webhook.enabled
    ? "Paused"
    : failed
      ? "Delivery failed"
      : "Active";
  const delivery = webhook.lastDelivery
    ? failed
      ? `Last delivery failed ${webhook.lastDelivery.deliveredAt}`
      : `Last delivery ${webhook.lastDelivery.deliveredAt}`
    : "No deliveries yet";
  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_auto] items-center transition-colors hover:bg-surface-elevated focus-within:bg-surface-elevated">
      <button
        type="button"
        className="min-w-0 px-5 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:px-6"
        onClick={() => onOpen(webhook)}
        disabled={disabled}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-foreground">{webhook.name}</p>
              <Badge
                variant={failed ? "destructive" : "outline"}
                className={
                  failed
                    ? undefined
                    : webhook.enabled
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "text-muted-foreground"
                }
              >
                <span
                  className={`size-1.5 rounded-full ${failed ? "bg-destructive" : webhook.enabled ? "bg-primary" : "bg-text-muted"}`}
                />
                {status}
              </Badge>
            </div>
            <p className="mt-1.5 truncate font-mono text-xs text-muted-foreground">
              {webhook.url}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <span>
                {webhook.events.length}{" "}
                {webhook.events.length === 1
                  ? "subscribed event"
                  : "subscribed events"}
              </span>
              <span aria-hidden="true">·</span>
              <span className={failed ? "text-destructive" : undefined}>
                {delivery}
              </span>
            </div>
          </div>
        </div>
      </button>
      <div className="pr-4 sm:pr-5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-muted-foreground [@media(any-pointer:coarse)]:size-11"
              aria-label={`Manage ${webhook.name}`}
              disabled={disabled}
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => onOpen(webhook)}
            >
              <EyeIcon aria-hidden="true" />
              View
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => onEdit(webhook)}
            >
              <PencilIcon aria-hidden="true" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => onToggle(webhook)}
            >
              {webhook.enabled ? (
                <PauseIcon aria-hidden="true" />
              ) : (
                <PlayIcon aria-hidden="true" />
              )}
              {webhook.enabled ? "Pause" : "Resume"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className="cursor-pointer"
              onSelect={() => onDelete(webhook)}
            >
              <Trash2Icon aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
