"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Image from "next/image";
import { formatDistance } from "date-fns";
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  InfoIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  OctagonAlertIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { toast } from "sonner";
import { apiRequest, type Identity } from "@/lib/api-client";
import {
  alertGroups,
  channelRouteCount,
  exportFileName,
  normalizeRoutes,
  rebaseRoutes,
  retentionOptions,
  sameRoutes,
  type AlertChannel,
  type AlertEvent,
  type AlertRoutes,
  type AlertSeverity,
  type AlertState,
} from "@/lib/alerts";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed.";

// The export includes data other pages protect with their own permissions.
const exportPermissions = [
  "servers.view",
  "infrastructure.view",
  "integrations.manage",
];

type Draft = { routes: AlertRoutes; retentionDays: number };
type ChannelForm = {
  channel: AlertChannel | null;
  kind: AlertChannel["kind"];
  name: string;
  url: string;
  error: string;
};

function draftOf(state: AlertState): Draft {
  return {
    routes: normalizeRoutes(
      state.routes,
      state.channels.map((c) => c.id),
    ),
    retentionDays: state.retentionDays,
  };
}

function Section({
  title,
  description,
  action,
  children,
  id,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
  id: string;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 md:px-6">
        <div className="min-w-0 space-y-1">
          <h2 id={`${id}-heading`} className="text-base font-semibold">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ChannelIcon({ kind }: { kind: AlertChannel["kind"] }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated">
      {kind === "discord" ? (
        <Image
          src="/images/integrations/discord.svg"
          alt=""
          width={20}
          height={20}
          className="size-5 object-contain"
        />
      ) : (
        <WebhookIcon aria-hidden="true" className="size-5 text-foreground" />
      )}
    </span>
  );
}

const severityLabel: Record<AlertSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  if (severity === "info") return null;
  return (
    <Badge
      variant="outline"
      className={
        severity === "critical"
          ? "border-destructive/40 text-destructive"
          : "border-warning/40 text-warning"
      }
    >
      {severity === "critical" ? (
        <OctagonAlertIcon aria-hidden="true" />
      ) : (
        <AlertTriangleIcon aria-hidden="true" />
      )}
      {severityLabel[severity]}
    </Badge>
  );
}

function SeverityIcon({ severity }: { severity: AlertSeverity }) {
  const Icon =
    severity === "critical"
      ? OctagonAlertIcon
      : severity === "warning"
        ? AlertTriangleIcon
        : InfoIcon;
  return (
    <span
      className={cn(
        "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated",
        severity === "critical"
          ? "text-destructive"
          : severity === "warning"
            ? "text-warning"
            : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
      <span className="sr-only">{severityLabel[severity]}</span>
    </span>
  );
}

function Relative({ at, now }: { at: number; now: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          tabIndex={0}
          dateTime={new Date(at).toISOString()}
          className="rounded-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {formatDistance(at, Math.max(now, at), { addSuffix: true })}
        </time>
      </TooltipTrigger>
      <TooltipContent>{new Date(at).toLocaleString()}</TooltipContent>
    </Tooltip>
  );
}

function ChannelStatus({
  channel,
  now,
}: {
  channel: AlertChannel;
  now: number;
}) {
  if (channel.lastDeliveryAt === null)
    return <span className="text-muted-foreground">No deliveries yet</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        channel.lastDeliveryOk ? "text-muted-foreground" : "text-destructive",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          channel.lastDeliveryOk ? "bg-primary" : "bg-destructive",
        )}
      />
      {channel.lastDeliveryOk ? "Delivered" : "Last delivery failed"}{" "}
      <Relative at={channel.lastDeliveryAt} now={now} />
    </span>
  );
}

function DeliveryBadge({
  status,
  attempts,
  error,
  name,
}: {
  status: AlertEvent["deliveries"][number]["status"];
  attempts: number;
  error: string | null;
  name: string;
}) {
  const label =
    status === "sent"
      ? "Sent"
      : status === "failed"
        ? "Failed"
        : attempts === 0
          ? "Queued"
          : "Retrying";
  const badge = (
    <Badge
      variant="outline"
      tabIndex={error ? 0 : undefined}
      className={cn(
        "max-w-full",
        status === "sent" && "border-primary/30 text-primary",
        status === "failed" && "border-destructive/40 text-destructive",
        status === "pending" && "border-warning/40 text-warning",
      )}
    >
      {status === "sent" && <CheckIcon aria-hidden="true" />}
      <span className="truncate">{name}</span>
      <span className="text-muted-foreground">·</span>
      {label}
    </Badge>
  );
  if (!error) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{error}</TooltipContent>
    </Tooltip>
  );
}

export function OrganizationAlerts({ identity }: { identity: Identity }) {
  const organization = identity.organization!;
  const canManage = identity.permissions.includes("organization.manage");
  const canExport = exportPermissions.every((permission) =>
    identity.permissions.includes(permission),
  );
  // The saved state and the operator's draft change together on every refresh.
  const [data, setData] = useState<{ state: AlertState; draft: Draft } | null>(
    null,
  );
  const state = data?.state ?? null;
  const draft = data?.draft ?? null;
  const setDraft = useCallback(
    (update: (draft: Draft, state: AlertState) => Draft) =>
      setData((current) =>
        current
          ? { ...current, draft: update(current.draft, current.state) }
          : current,
      ),
    [],
  );
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [form, setForm] = useState<ChannelForm | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [removing, setRemoving] = useState<AlertChannel | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [rotating, setRotating] = useState<AlertChannel | null>(null);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  // Apply a newer saved state while keeping the operator's unsaved edits.
  const adopt = useCallback((next: AlertState) => {
    setData((current) => {
      if (!current) return { state: next, draft: draftOf(next) };
      const ids = next.channels.map((c) => c.id);
      return {
        state: next,
        draft: {
          routes: rebaseRoutes(
            normalizeRoutes(current.state.routes, ids),
            current.draft.routes,
            next.routes,
            ids,
          ),
          retentionDays:
            current.draft.retentionDays === current.state.retentionDays
              ? next.retentionDays
              : current.draft.retentionDays,
        },
      };
    });
  }, []);

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      adopt(await apiRequest<AlertState>("alerts", undefined, organization.id));
      setLoadError("");
    } catch (cause) {
      setLoadError(message(cause));
    }
  }, [adopt, canManage, organization.id]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  if (!canManage) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 md:p-6">
        <h2 className="text-base font-semibold">
          Organization management required
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask an owner or administrator to change alert channels, alert routing,
          or data exports for {organization.name}.
        </p>
      </div>
    );
  }

  if (!state || !draft) {
    return loadError ? (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-5 text-sm text-destructive"
      >
        <p>{loadError}</p>
        <Button variant="outline" onClick={() => void load()}>
          Reload alerts
        </Button>
      </div>
    ) : (
      <div aria-label="Loading alerts" className="space-y-6">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  const saved = draftOf(state);
  const dirty =
    draft.retentionDays !== saved.retentionDays ||
    !sameRoutes(draft.routes, saved.routes);

  function toggle(event: string, channel: string, checked: boolean) {
    setSaveError("");
    setDraft((current, saved) => {
      const ids = new Set(current.routes[event] ?? []);
      if (checked) ids.add(channel);
      else ids.delete(channel);
      return {
        ...current,
        routes: normalizeRoutes(
          { ...current.routes, [event]: [...ids] },
          saved.channels.map((c) => c.id),
        ),
      };
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || saving || !state || !draft) return;
    setSaving(true);
    setSaveError("");
    try {
      const next = await apiRequest<AlertState>(
        "alerts/settings",
        {
          revision: state.revision,
          routes: draft.routes,
          retentionDays: draft.retentionDays,
        },
        organization.id,
      );
      setData({ state: next, draft: draftOf(next) });
      toast.success("Alert settings saved.");
    } catch (cause) {
      setSaveError(message(cause));
      // Pick up the newer revision; unsaved edits are reapplied on top of it.
      void load();
    } finally {
      setSaving(false);
    }
  }

  function openForm(channel: AlertChannel | null) {
    setForm({
      channel,
      kind: channel?.kind ?? "discord",
      name: channel?.name ?? "",
      url: "",
      error: "",
    });
  }

  async function submitForm(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!form || formBusy || !state) return;
    const name = form.name.trim();
    if (!name) {
      setForm({ ...form, error: "Enter a channel name." });
      nameRef.current?.focus();
      return;
    }
    if (!form.channel && !form.url.trim()) {
      setForm({ ...form, error: "Enter the destination URL." });
      urlRef.current?.focus();
      return;
    }
    setFormBusy(true);
    try {
      if (form.channel) {
        adopt(
          await apiRequest<AlertState>(
            `alerts/channels/${form.channel.id}`,
            {
              revision: state.revision,
              name,
              url: form.url.trim() || null,
            },
            organization.id,
          ),
        );
        toast.success(`${name} updated.`);
      } else {
        const result = await apiRequest<{
          alerts: AlertState;
          signingSecret: string | null;
        }>(
          "alerts/channels",
          {
            revision: state.revision,
            kind: form.kind,
            name,
            url: form.url.trim(),
          },
          organization.id,
        );
        adopt(result.alerts);
        if (result.signingSecret) {
          setCopied(false);
          setSecret({ name, value: result.signingSecret });
        } else toast.success(`${name} added.`);
      }
      setForm(null);
    } catch (cause) {
      setForm({ ...form, error: message(cause) });
      urlRef.current?.focus();
    } finally {
      setFormBusy(false);
    }
  }

  async function remove() {
    if (!removing || removeBusy || !state) return;
    setRemoveBusy(true);
    try {
      adopt(
        await apiRequest<AlertState>(
          `alerts/channels/${removing.id}/remove`,
          { revision: state.revision },
          organization.id,
        ),
      );
      toast.success(`${removing.name} removed.`);
      setRemoving(null);
    } catch (cause) {
      toast.error(message(cause));
      void load();
    } finally {
      setRemoveBusy(false);
    }
  }

  async function rotate() {
    if (!rotating || rotateBusy || !state) return;
    setRotateBusy(true);
    try {
      const result = await apiRequest<{
        alerts: AlertState;
        signingSecret: string;
      }>(
        `alerts/channels/${rotating.id}/rotate`,
        { revision: state.revision },
        organization.id,
      );
      adopt(result.alerts);
      setCopied(false);
      setSecret({ name: rotating.name, value: result.signingSecret });
      setRotating(null);
    } catch (cause) {
      toast.error(message(cause));
      void load();
    } finally {
      setRotateBusy(false);
    }
  }

  async function test(channel: AlertChannel) {
    if (testing) return;
    setTesting(channel.id);
    try {
      const result = await apiRequest<{
        alerts: AlertState;
        delivered: boolean;
        error: string | null;
      }>(`alerts/channels/${channel.id}/test`, {}, organization.id);
      adopt(result.alerts);
      setNow(Date.now());
      if (result.delivered)
        toast.success(`Test alert delivered to ${channel.name}.`);
      else
        toast.error(
          `${channel.name} did not accept the test alert. ${result.error ?? ""}`.trim(),
        );
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setTesting(null);
    }
  }

  async function download() {
    if (exporting) return;
    setExporting(true);
    try {
      const data = await apiRequest<unknown>(
        "organization/export",
        undefined,
        organization.id,
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFileName(organization.name, new Date());
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Export downloaded.");
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setExporting(false);
    }
  }

  const channels = state.channels;

  return (
    <div className="pb-4">
      <form onSubmit={save} className="space-y-6">
        {loadError && (
          <p role="alert" className="text-sm text-destructive">
            {loadError} Showing the last loaded alerts.
          </p>
        )}

        <Section
          id="alert-channels"
          title="Delivery channels"
          description="Where Cupboard sends alerts. Test a channel after adding it."
          action={
            <Button
              type="button"
              variant="outline"
              className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
              disabled={channels.length >= 10}
              onClick={() => openForm(null)}
            >
              <PlusIcon aria-hidden="true" />
              Add channel
            </Button>
          }
        >
          {channels.length === 0 ? (
            <div className="border-t border-border px-5 py-8 text-center md:px-6">
              <p className="text-sm font-medium">No channels yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Add a Discord channel or a webhook to hear about outages before
                your players do.
              </p>
            </div>
          ) : (
            <ul className="border-t border-border">
              {channels.map((channel) => {
                const routed = channelRouteCount(saved.routes, channel.id);
                return (
                  <li
                    key={channel.id}
                    className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-border px-5 py-4 last:border-b-0 md:px-6"
                  >
                    <ChannelIcon kind={channel.kind} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-medium">
                          {channel.name}
                        </h3>
                        <Badge
                          variant="outline"
                          className="text-muted-foreground"
                        >
                          {channel.kind === "discord" ? "Discord" : "Webhook"}
                        </Badge>
                      </div>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-mono">{channel.destination}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {routed === 0
                            ? "No alerts routed"
                            : `${routed} ${routed === 1 ? "alert" : "alerts"} routed`}
                        </span>
                        <span aria-hidden="true">·</span>
                        <ChannelStatus channel={channel} now={now} />
                      </p>
                      {channel.lastDeliveryOk === false &&
                        channel.lastError && (
                          <p className="mt-1 text-xs text-destructive">
                            {channel.lastError}
                          </p>
                        )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        className="hidden h-9 px-3 sm:inline-flex"
                        disabled={testing !== null}
                        onClick={() => void test(channel)}
                      >
                        <SendIcon aria-hidden="true" />
                        {testing === channel.id ? "Sending..." : "Send test"}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            className="size-11"
                            aria-label={`${channel.name} actions`}
                          >
                            <MoreHorizontalIcon aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="sm:hidden"
                            disabled={testing !== null}
                            onSelect={() => void test(channel)}
                          >
                            <SendIcon aria-hidden="true" />
                            Send test
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => openForm(channel)}>
                            <PencilIcon aria-hidden="true" />
                            Edit
                          </DropdownMenuItem>
                          {channel.kind === "webhook" && (
                            <DropdownMenuItem
                              onSelect={() => setRotating(channel)}
                            >
                              <KeyRoundIcon aria-hidden="true" />
                              Rotate signing secret
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setRemoving(channel)}
                          >
                            <Trash2Icon aria-hidden="true" />
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section
          id="alert-routing"
          title="Alert routing"
          description={
            channels.length
              ? "Choose which channels receive each alert."
              : "Alerts Cupboard can send. Add a channel to route them."
          }
        >
          <ScrollArea type="auto" horizontal className="border-t border-border">
            <table
              className="w-full border-collapse text-sm"
              style={{ minWidth: `${220 + channels.length * 88}px` }}
            >
              {channels.length > 0 && (
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th
                      scope="col"
                      className="sticky left-0 z-10 bg-card px-5 py-2.5 font-medium md:px-6"
                    >
                      Alert
                    </th>
                    {channels.map((channel) => (
                      <th
                        key={channel.id}
                        scope="col"
                        className="w-22 px-2 py-2.5 text-center font-medium last:pr-5 md:last:pr-6"
                      >
                        <span className="mx-auto block max-w-20 truncate">
                          {channel.name}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              {alertGroups.map((group) => (
                <tbody
                  key={group.title}
                  className="border-b border-border last:border-b-0"
                >
                  <tr className="border-b border-border bg-surface-elevated">
                    <th
                      scope="colgroup"
                      colSpan={channels.length + 1}
                      className="px-5 py-2 text-left text-xs font-medium text-muted-foreground md:px-6"
                    >
                      <span className="sticky left-5 md:left-6">
                        {group.title}
                      </span>
                    </th>
                  </tr>
                  {group.events.map((event) => (
                    <tr
                      key={event.key}
                      className="border-b border-border last:border-b-0"
                    >
                      <th
                        scope="row"
                        className="sticky left-0 z-10 bg-card px-5 py-3 text-left font-normal md:px-6"
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{event.title}</span>
                          <SeverityBadge severity={event.severity} />
                        </span>
                        <span
                          id={`${event.key}-description`}
                          className="mt-1 block text-xs leading-5 text-muted-foreground"
                        >
                          {event.description}
                        </span>
                      </th>
                      {channels.map((channel) => (
                        <td
                          key={channel.id}
                          className="px-2 py-3 text-center last:pr-5 md:last:pr-6"
                        >
                          <Checkbox
                            className="mx-auto size-5"
                            checked={(draft.routes[event.key] ?? []).includes(
                              channel.id,
                            )}
                            onCheckedChange={(checked) =>
                              toggle(event.key, channel.id, checked === true)
                            }
                            aria-label={`Send ${event.title} to ${channel.name}`}
                            aria-describedby={`${event.key}-description`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </ScrollArea>
        </Section>

        <Section
          id="alert-history"
          title="Recent alerts"
          description={`The latest alerts and where they were delivered. Cupboard keeps alert history for ${saved.retentionDays} days.`}
        >
          {state.events.length === 0 ? (
            <div className="border-t border-border px-5 py-8 text-center md:px-6">
              <p className="text-sm font-medium">No alerts yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Alerts appear here when a server or machine goes offline or
                recovers, a Pelican check fails, or a member joins or leaves.
              </p>
            </div>
          ) : (
            <ScrollArea
              type="auto"
              className="border-t border-border [&>[data-slot=scroll-area-viewport]]:max-h-[32rem]"
            >
              <ol>
                {state.events.map((event) => (
                  <li
                    key={event.id}
                    className="flex gap-3 border-b border-border px-5 py-3.5 last:border-b-0 md:px-6"
                  >
                    <SeverityIcon severity={event.severity} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <p className="text-sm font-medium">{event.title}</p>
                        <span className="text-xs text-muted-foreground">
                          <Relative at={event.createdAt} now={now} />
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                        {event.detail}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {event.deliveries.length === 0 ? (
                          <span className="text-xs text-text-muted">
                            Not routed to a channel
                          </span>
                        ) : (
                          event.deliveries.map((delivery) => (
                            <DeliveryBadge
                              key={delivery.channelId}
                              status={delivery.status}
                              attempts={delivery.attempts}
                              error={delivery.error}
                              name={delivery.channelName}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          )}
        </Section>

        <Section
          id="organization-data"
          title="Data"
          description="Control what Cupboard keeps and take a copy of your configuration."
        >
          <div className="divide-y divide-border border-t border-border">
            <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between md:px-6">
              <div className="min-w-0">
                <Label
                  htmlFor="alert-retention"
                  className="text-sm font-medium"
                >
                  Alert history
                </Label>
                <p
                  id="alert-retention-description"
                  className="mt-1 text-xs leading-5 text-muted-foreground"
                >
                  Alerts older than this are deleted automatically.
                </p>
              </div>
              <Select
                value={String(draft.retentionDays)}
                onValueChange={(value) => {
                  setSaveError("");
                  setDraft((current) => ({
                    ...current,
                    retentionDays: Number(value),
                  }));
                }}
              >
                <SelectTrigger
                  id="alert-retention"
                  aria-describedby="alert-retention-description"
                  className="w-full border-border bg-input-background data-[size=default]:h-11 sm:w-40 sm:data-[size=default]:h-10 dark:bg-input-background"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {retentionOptions.map((days) => (
                    <SelectItem
                      key={days}
                      value={String(days)}
                      className="min-h-11 sm:min-h-8"
                    >
                      {days} days
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between md:px-6">
              <div className="min-w-0">
                <h3 className="text-sm font-medium">
                  Export organization data
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  A JSON file with members, roles, servers, machines, the
                  Pelican connection, and alert settings. Passwords, API keys,
                  tokens, webhook URLs, and file contents are not included.
                </p>
                {!canExport && (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Exporting also needs permission to view servers and
                    infrastructure and to manage integrations.
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-10 shrink-0 px-4 [@media(any-pointer:coarse)]:min-h-11"
                disabled={exporting || !canExport}
                onClick={() => void download()}
              >
                <DownloadIcon aria-hidden="true" />
                {exporting ? "Preparing export..." : "Download export"}
              </Button>
            </div>
          </div>
        </Section>

        {(dirty || saveError) && (
          <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border-strong bg-surface-elevated px-4 py-3 shadow-lg">
            <p
              role={saveError ? "alert" : "status"}
              className={cn(
                "mr-auto text-sm",
                saveError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {saveError || "Unsaved changes"}
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
              disabled={saving || !dirty}
              onClick={() => {
                setDraft((_, current) => draftOf(current));
                setSaveError("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
              disabled={saving || !dirty}
            >
              {saving ? "Saving changes..." : "Save changes"}
            </Button>
          </div>
        )}
      </form>

      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open && !formBusy) setForm(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {form && (
            <form onSubmit={submitForm} className="grid gap-5" noValidate>
              <DialogHeader>
                <DialogTitle>
                  {form.channel ? `Edit ${form.channel.name}` : "Add channel"}
                </DialogTitle>
                <DialogDescription>
                  {form.channel
                    ? "Rename the channel or replace its URL."
                    : "New channels receive server offline, machine offline, and Pelican failure alerts. You can change this in Alert routing."}
                </DialogDescription>
              </DialogHeader>
              {!form.channel && (
                <fieldset className="grid gap-2">
                  <legend className="mb-2 text-sm font-medium">Type</legend>
                  <RadioGroup
                    value={form.kind}
                    onValueChange={(kind) =>
                      setForm({
                        ...form,
                        kind: kind as AlertChannel["kind"],
                        error: "",
                      })
                    }
                    className="grid-cols-2"
                  >
                    {(["discord", "webhook"] as const).map((kind) => (
                      <Label
                        key={kind}
                        htmlFor={`channel-kind-${kind}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-input-background px-3 py-3 font-normal transition-colors hover:border-border-strong",
                          form.kind === kind && "border-primary/60",
                        )}
                      >
                        <RadioGroupItem
                          id={`channel-kind-${kind}`}
                          value={kind}
                        />
                        <span className="grid gap-0.5">
                          <span className="text-sm font-medium">
                            {kind === "discord" ? "Discord" : "Webhook"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {kind === "discord"
                              ? "Post to a Discord channel"
                              : "Signed JSON over HTTPS"}
                          </span>
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                </fieldset>
              )}
              <div className="grid gap-2">
                <Label htmlFor="channel-name">Name</Label>
                <Input
                  id="channel-name"
                  ref={nameRef}
                  value={form.name}
                  maxLength={80}
                  placeholder={
                    form.kind === "discord" ? "#server-alerts" : "On-call pager"
                  }
                  className="h-10 bg-input-background"
                  onChange={(event) =>
                    setForm({ ...form, name: event.target.value, error: "" })
                  }
                  autoFocus
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="channel-url">
                  {form.kind === "discord" ? "Webhook URL" : "Endpoint URL"}
                </Label>
                <Input
                  id="channel-url"
                  ref={urlRef}
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.url}
                  placeholder={
                    form.channel
                      ? "Leave blank to keep the current URL"
                      : form.kind === "discord"
                        ? "https://discord.com/api/webhooks/..."
                        : "https://alerts.example.com/cupboard"
                  }
                  aria-describedby="channel-url-help"
                  aria-invalid={form.error ? true : undefined}
                  className="h-10 bg-input-background font-mono text-xs"
                  onChange={(event) =>
                    setForm({ ...form, url: event.target.value, error: "" })
                  }
                />
                <p
                  id="channel-url-help"
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {form.kind === "discord"
                    ? "In Discord, open Server settings, Integrations, Webhooks, then copy the webhook URL. Cupboard stores it encrypted."
                    : "Cupboard sends a JSON POST to this HTTPS address on port 443 and signs it with a secret you see once after saving."}
                </p>
              </div>
              {form.error && (
                <p role="alert" className="text-sm text-destructive">
                  {form.error}
                </p>
              )}
              <DialogFooter>
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 px-4"
                    disabled={formBusy}
                  >
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" className="h-10 px-4" disabled={formBusy}>
                  {form.channel
                    ? formBusy
                      ? "Saving changes..."
                      : "Save changes"
                    : formBusy
                      ? "Adding channel..."
                      : "Add channel"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={secret !== null}
        onOpenChange={(open) => {
          if (!open) setSecret(null);
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Save the signing secret</DialogTitle>
            <DialogDescription>
              {secret?.name} is ready. Use this secret to verify the
              X-Cupboard-Signature header on each request. Cupboard will not
              show it again, but you can rotate it from the channel menu.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              readOnly
              aria-label="Signing secret"
              value={secret?.value ?? ""}
              className="h-10 bg-input-background font-mono text-xs"
              onFocus={(event) => event.target.select()}
            />
            <Button
              type="button"
              variant="outline"
              className="h-10 px-3"
              onClick={() => {
                if (!secret) return;
                if (!navigator.clipboard) {
                  toast.error("Copy is unavailable here. Select the secret.");
                  return;
                }
                void navigator.clipboard
                  .writeText(secret.value)
                  .then(() => setCopied(true))
                  .catch(() => toast.error("Copy failed. Select the secret."));
              }}
            >
              {copied ? (
                <CheckIcon aria-hidden="true" />
              ) : (
                <CopyIcon aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            The header has the form{" "}
            <code className="font-mono">t=timestamp,v1=signature</code>, where
            the signature is the hex HMAC-SHA256 of the timestamp, a period, and
            the raw request body.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" className="h-10 px-4">
                Done
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={rotating !== null}
        onOpenChange={(open) => {
          if (!open && !rotateBusy) setRotating(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Rotate the secret for {rotating?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Alerts are signed with the new secret right away. Requests fail
              verification until you update your receiver.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotateBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={rotateBusy}
              onClick={(event) => {
                event.preventDefault();
                void rotate();
              }}
            >
              {rotateBusy ? "Rotating secret..." : "Rotate secret"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !removeBusy) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Cupboard stops sending alerts to this channel, removes it from
              alert routing, and cancels deliveries still waiting to be sent.
              Past deliveries stay in Recent alerts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removeBusy}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {removeBusy ? "Removing channel..." : "Remove channel"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
