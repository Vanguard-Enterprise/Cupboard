"use client";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  webhookEvents,
  type WebhookEndpoint,
} from "@/lib/organization-integrations";

export function WebhookDetailsSheet({
  webhook,
  storageUnreadable,
  retryUnavailable,
  onOpenChange,
  onRetry,
  onEdit,
  onDelete,
}: {
  webhook: WebhookEndpoint | undefined;
  storageUnreadable: boolean;
  retryUnavailable: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onEdit: (webhook: WebhookEndpoint) => void;
  onDelete: (webhook: WebhookEndpoint) => void;
}) {
  return (
    <Sheet open={Boolean(webhook)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-[452px]">
        {webhook && (
          <>
            <SheetHeader className="border-b px-6 py-5 pr-14">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="text-lg">{webhook.name}</SheetTitle>
                <Badge
                  variant={
                    webhook.lastDelivery && webhook.lastDelivery.status >= 400
                      ? "destructive"
                      : webhook.enabled
                        ? "success"
                        : "outline"
                  }
                  className={
                    webhook.lastDelivery && webhook.lastDelivery.status >= 400
                      ? undefined
                      : webhook.enabled
                        ? undefined
                        : "text-muted-foreground"
                  }
                >
                  {webhook.lastDelivery && webhook.lastDelivery.status >= 400
                    ? "Delivery failed"
                    : webhook.enabled
                      ? "Active"
                      : "Paused"}
                </Badge>
              </div>
              <SheetDescription className="sr-only">
                Webhook details and recent delivery activity
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <dl className="grid gap-5">
                <div>
                  <dt className="text-xs text-text-muted">Endpoint URL</dt>
                  <dd className="mt-2 break-all rounded-lg border bg-input-background px-3 py-2 font-mono text-xs text-muted-foreground">
                    {webhook.url}
                  </dd>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-text-muted">Signing secret</dt>
                    <dd className="mt-1.5 text-sm text-muted-foreground">
                      Not configured
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">Created</dt>
                    <dd className="mt-1.5 text-sm text-muted-foreground">
                      {webhook.createdAt}
                    </dd>
                  </div>
                </div>
                <div>
                  <dt className="text-xs text-text-muted">Subscribed events</dt>
                  <dd className="mt-2 flex flex-wrap gap-2">
                    {webhook.events.map((event) => (
                      <Badge key={event} variant="secondary">
                        {webhookEvents.find((item) => item.id === event)
                          ?.label ?? event}
                      </Badge>
                    ))}
                  </dd>
                </div>
              </dl>

              <section aria-labelledby="recent-deliveries" className="mt-7">
                <h3 id="recent-deliveries" className="text-sm font-medium">
                  Recent deliveries
                </h3>
                <div className="mt-3 overflow-hidden rounded-xl border">
                  {webhook.lastDelivery ? (
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        {webhook.lastDelivery.status >= 400 ? (
                          <CircleAlertIcon
                            className="size-4 shrink-0 text-destructive"
                            aria-hidden="true"
                          />
                        ) : (
                          <CheckCircle2Icon
                            className="size-4 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                        )}
                        <div>
                          <p className="text-sm">
                            {webhook.lastDelivery.status >= 400
                              ? "Delivery failed"
                              : "Delivered"}
                          </p>
                          <p className="mt-1 text-xs text-text-muted">
                            {webhook.lastDelivery.deliveredAt}
                          </p>
                        </div>
                      </div>
                      <code className="rounded-md bg-surface-elevated px-2 py-1 font-mono text-xs text-muted-foreground">
                        HTTP {webhook.lastDelivery.status}
                      </code>
                    </div>
                  ) : (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                      No deliveries yet
                    </p>
                  )}
                </div>
                {retryUnavailable && (
                  <p role="status" className="mt-3 text-xs text-destructive">
                    Retry delivery isn&apos;t available in this sample-data
                    preview.
                  </p>
                )}
              </section>
            </div>

            <SheetFooter className="border-t px-6 py-4 sm:flex-row">
              {webhook.lastDelivery && webhook.lastDelivery.status >= 400 && (
                <Button
                  variant="outline"
                  className="h-10 [@media(any-pointer:coarse)]:min-h-11"
                  onClick={onRetry}
                >
                  <RefreshCwIcon aria-hidden="true" />
                  Retry delivery
                </Button>
              )}
              <Button
                variant="outline"
                className="h-10 [@media(any-pointer:coarse)]:min-h-11"
                onClick={() => onEdit(webhook)}
                disabled={storageUnreadable}
              >
                <PencilIcon aria-hidden="true" />
                Edit
              </Button>
              <Button
                variant="destructive"
                className="h-10 [@media(any-pointer:coarse)]:min-h-11 sm:ml-auto"
                onClick={() => onDelete(webhook)}
                disabled={storageUnreadable}
              >
                <Trash2Icon aria-hidden="true" />
                Delete
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
