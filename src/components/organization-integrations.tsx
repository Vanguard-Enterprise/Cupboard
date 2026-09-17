"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ClipboardIcon,
  EyeIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
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
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  createCredentialSecret,
  defaultOrganizationIntegrations,
  organizationIntegrationsKey,
  parseOrganizationIntegrations,
  validateWebhookUrl,
  webhookEvents,
  type ApiCredential,
  type OrganizationIntegrations,
  type WebhookEndpoint,
  type WebhookEvent,
} from "@/lib/organization-integrations";

type Feedback = { kind: "status" | "alert"; message: string } | null;

function subscribeToIntegrations(callback: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === organizationIntegrationsKey) callback();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener("cupboard-integrations-saved", callback);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener("cupboard-integrations-saved", callback);
  };
}

function integrationsSnapshot(): string | null {
  try {
    return localStorage.getItem(organizationIntegrationsKey);
  } catch {
    return "storage-unavailable";
  }
}

const integrationsServerSnapshot = () => null;

type IntegrationViewState = {
  raw: string | null;
  data: OrganizationIntegrations;
  storageUnreadable: boolean;
};

function integrationViewState(
  raw: string | null,
  lastValidData: OrganizationIntegrations,
): IntegrationViewState {
  if (raw === null) {
    return {
      raw,
      data: structuredClone(defaultOrganizationIntegrations),
      storageUnreadable: false,
    };
  }
  try {
    return {
      raw,
      data: parseOrganizationIntegrations(raw),
      storageUnreadable: false,
    };
  } catch {
    return {
      raw,
      data: lastValidData,
      storageUnreadable: true,
    };
  }
}

function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function today(): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

function editableWebhookSnapshot(webhook: WebhookEndpoint): string {
  return JSON.stringify({
    name: webhook.name,
    url: webhook.url,
    events: [...webhook.events].sort(),
  });
}

function CredentialRow({
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

function WebhookRow({
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

export function OrganizationIntegrations() {
  const raw = useSyncExternalStore(
    subscribeToIntegrations,
    integrationsSnapshot,
    integrationsServerSnapshot,
  );
  const [storedViewState, setStoredViewState] = useState<IntegrationViewState>(
    () =>
      integrationViewState(
        raw,
        structuredClone(defaultOrganizationIntegrations),
      ),
  );
  let viewState = storedViewState;
  if (storedViewState.raw !== raw) {
    viewState = integrationViewState(raw, storedViewState.data);
    setStoredViewState(viewState);
  }
  const { data, storageUnreadable } = viewState;
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const [credentialName, setCredentialName] = useState("");
  const [credentialNameError, setCredentialNameError] = useState("");
  const [credentialStartedWithMissingKey, setCredentialStartedWithMissingKey] =
    useState(true);
  const [credentialStorageCleared, setCredentialStorageCleared] =
    useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [createdSecretAction, setCreatedSecretAction] = useState<
    "created" | "rotated"
  >("created");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [webhookDialogOpen, setWebhookDialogOpen] = useState(false);
  const [editingWebhookId, setEditingWebhookId] = useState<string | null>(null);
  const [editingWebhookBaseline, setEditingWebhookBaseline] = useState<
    string | null
  >(null);
  const [webhookEditConflict, setWebhookEditConflict] = useState<
    "deleted" | "changed" | null
  >(null);
  const [webhookStartedWithMissingKey, setWebhookStartedWithMissingKey] =
    useState(true);
  const [webhookStorageCleared, setWebhookStorageCleared] = useState(false);
  const [selectedWebhookId, setSelectedWebhookId] = useState<string | null>(
    null,
  );
  const [retryUnavailable, setRetryUnavailable] = useState(false);
  const [webhookName, setWebhookName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<WebhookEvent[]>([]);
  const [webhookErrors, setWebhookErrors] = useState({
    name: "",
    url: "",
    events: "",
  });
  const [credentialToRevoke, setCredentialToRevoke] =
    useState<ApiCredential | null>(null);
  const [credentialRevokeConflict, setCredentialRevokeConflict] = useState<
    "deleted" | "changed" | "cleared" | null
  >(null);
  const [
    credentialRevokeStartedWithMissingKey,
    setCredentialRevokeStartedWithMissingKey,
  ] = useState(true);
  const [credentialToRotate, setCredentialToRotate] =
    useState<ApiCredential | null>(null);
  const [credentialRotateConflict, setCredentialRotateConflict] = useState<
    "deleted" | "changed" | "cleared" | null
  >(null);
  const [
    credentialRotateStartedWithMissingKey,
    setCredentialRotateStartedWithMissingKey,
  ] = useState(true);
  const [webhookToDelete, setWebhookToDelete] =
    useState<WebhookEndpoint | null>(null);
  const [webhookDeleteConflict, setWebhookDeleteConflict] = useState<
    "deleted" | "changed" | "cleared" | null
  >(null);
  const [
    webhookDeleteStartedWithMissingKey,
    setWebhookDeleteStartedWithMissingKey,
  ] = useState(true);
  const [unreadableToReplace, setUnreadableToReplace] = useState<string | null>(
    null,
  );
  const [suspendedDraftDialog, setSuspendedDraftDialog] = useState<
    "credential" | "webhook" | null
  >(null);
  const credentialNameRef = useRef<HTMLInputElement>(null);
  const webhookNameRef = useRef<HTMLInputElement>(null);
  const webhookUrlRef = useRef<HTMLInputElement>(null);
  const selectedWebhook = data.webhooks.find(
    (webhook) => webhook.id === selectedWebhookId,
  );
  const editingWebhook = editingWebhookId
    ? data.webhooks.find((webhook) => webhook.id === editingWebhookId)
    : undefined;
  const webhookEditIssue =
    webhookEditConflict ??
    (editingWebhookId && !editingWebhook
      ? "deleted"
      : editingWebhook &&
          editingWebhookBaseline !== null &&
          editableWebhookSnapshot(editingWebhook) !== editingWebhookBaseline
        ? "changed"
        : null);
  const credentialNameValid = credentialName.trim().length > 0;
  const webhookFormValid =
    webhookName.trim().length > 0 &&
    validateWebhookUrl(webhookUrl.trim()) === null &&
    selectedEvents.length > 0;

  function persist(next: OrganizationIntegrations, success: string): boolean {
    try {
      localStorage.setItem(organizationIntegrationsKey, JSON.stringify(next));
      window.dispatchEvent(new Event("cupboard-integrations-saved"));
      setFeedback({ kind: "status", message: success });
      return true;
    } catch {
      setFeedback({
        kind: "alert",
        message: "Could not save this change in your browser. Try again.",
      });
      return false;
    }
  }

  function latestDataForMutation(
    startedWithMissingKey: boolean,
    onCleared: () => void,
  ): OrganizationIntegrations | null {
    const latestRaw = integrationsSnapshot();
    if (latestRaw === null) {
      if (!startedWithMissingKey) {
        onCleared();
        setFeedback({
          kind: "alert",
          message:
            "Integration data was cleared in another tab. Review the current preview before trying again.",
        });
        return null;
      }
      return structuredClone(defaultOrganizationIntegrations);
    }
    try {
      return parseOrganizationIntegrations(latestRaw);
    } catch {
      if (credentialDialogOpen) {
        setCredentialDialogOpen(false);
        setSuspendedDraftDialog("credential");
      } else if (webhookDialogOpen) {
        setWebhookDialogOpen(false);
        setSuspendedDraftDialog("webhook");
      }
      setCredentialToRevoke(null);
      setCredentialToRotate(null);
      setWebhookToDelete(null);
      setSelectedWebhookId(null);
      setUnreadableToReplace(latestRaw);
      setFeedback({
        kind: "alert",
        message: "Saved credential and webhook data could not be loaded.",
      });
      return null;
    }
  }

  function restoreSuspendedDraft() {
    if (suspendedDraftDialog === "credential") {
      setCredentialDialogOpen(true);
    } else if (suspendedDraftDialog === "webhook") {
      setWebhookDialogOpen(true);
    }
    setSuspendedDraftDialog(null);
  }

  function requestUnreadableReplacement() {
    const latestRaw = integrationsSnapshot();
    if (latestRaw !== null) {
      try {
        parseOrganizationIntegrations(latestRaw);
      } catch {
        setUnreadableToReplace(latestRaw);
        return;
      }
    }
    window.dispatchEvent(new Event("cupboard-integrations-saved"));
    setFeedback({
      kind: "alert",
      message: "Saved integration data changed. Review it before replacing.",
    });
  }

  function replaceUnreadableData() {
    if (unreadableToReplace === null) return;
    const latestRaw = integrationsSnapshot();
    let latestIsUnreadable = false;
    if (latestRaw !== null) {
      try {
        parseOrganizationIntegrations(latestRaw);
      } catch {
        latestIsUnreadable = true;
      }
    }
    if (latestRaw !== unreadableToReplace || !latestIsUnreadable) {
      setUnreadableToReplace(null);
      restoreSuspendedDraft();
      window.dispatchEvent(new Event("cupboard-integrations-saved"));
      setFeedback({
        kind: "alert",
        message: "Saved integration data changed. Review it before replacing.",
      });
      return;
    }
    try {
      localStorage.removeItem(organizationIntegrationsKey);
      window.dispatchEvent(new Event("cupboard-integrations-saved"));
      setUnreadableToReplace(null);
      if (suspendedDraftDialog === "credential") {
        setCredentialStartedWithMissingKey(true);
        setCredentialStorageCleared(false);
      } else if (suspendedDraftDialog === "webhook") {
        setWebhookStartedWithMissingKey(true);
        setWebhookStorageCleared(false);
      }
      restoreSuspendedDraft();
      setFeedback({
        kind: "status",
        message: "Unreadable integration data replaced with sample data.",
      });
    } catch {
      setFeedback({
        kind: "alert",
        message: "Could not replace the saved data in your browser. Try again.",
      });
    }
  }

  function openCredentialDialog() {
    setCredentialStartedWithMissingKey(integrationsSnapshot() === null);
    setCredentialStorageCleared(false);
    setCredentialName("");
    setCredentialNameError("");
    setCredentialDialogOpen(true);
  }

  function createCredential(event: React.FormEvent) {
    event.preventDefault();
    const name = credentialName.trim();
    if (!name) {
      setCredentialNameError("Enter a credential name.");
      credentialNameRef.current?.focus();
      return;
    }
    const latestData = latestDataForMutation(
      credentialStartedWithMissingKey,
      () => setCredentialStorageCleared(true),
    );
    if (!latestData) return;
    const secret = createCredentialSecret();
    const credential: ApiCredential = {
      id: newId(),
      name,
      prefix: `${secret.slice(0, 12)}...${secret.slice(-4)}`,
      createdAt: today(),
      lastUsed: null,
    };
    if (
      persist(
        {
          ...latestData,
          credentials: [credential, ...latestData.credentials],
        },
        `${name} added to preview data.`,
      )
    ) {
      setCredentialDialogOpen(false);
      setCreatedSecret(secret);
      setCreatedSecretAction("created");
      setCopyState("idle");
    }
  }

  async function copyCredential() {
    if (!createdSecret) return;
    try {
      await navigator.clipboard.writeText(createdSecret);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  function openWebhookDialog() {
    setWebhookStartedWithMissingKey(integrationsSnapshot() === null);
    setWebhookStorageCleared(false);
    setEditingWebhookId(null);
    setEditingWebhookBaseline(null);
    setWebhookEditConflict(null);
    setWebhookName("");
    setWebhookUrl("");
    setSelectedEvents([]);
    setWebhookErrors({ name: "", url: "", events: "" });
    setWebhookDialogOpen(true);
  }

  function editWebhook(webhook: WebhookEndpoint) {
    setWebhookStartedWithMissingKey(integrationsSnapshot() === null);
    setWebhookStorageCleared(false);
    setSelectedWebhookId(null);
    setEditingWebhookId(webhook.id);
    setEditingWebhookBaseline(editableWebhookSnapshot(webhook));
    setWebhookEditConflict(null);
    setWebhookName(webhook.name);
    setWebhookUrl(webhook.url);
    setSelectedEvents(webhook.events);
    setWebhookErrors({ name: "", url: "", events: "" });
    setWebhookDialogOpen(true);
  }

  function createWebhook(event: React.FormEvent) {
    event.preventDefault();
    const latestData = latestDataForMutation(webhookStartedWithMissingKey, () =>
      setWebhookStorageCleared(true),
    );
    if (!latestData) return;
    const latestEditingWebhook = editingWebhookId
      ? latestData.webhooks.find((webhook) => webhook.id === editingWebhookId)
      : undefined;
    if (editingWebhookId && !latestEditingWebhook) {
      setWebhookEditConflict("deleted");
      return;
    }
    if (
      editingWebhookId &&
      latestEditingWebhook &&
      (editingWebhookBaseline === null ||
        editableWebhookSnapshot(latestEditingWebhook) !==
          editingWebhookBaseline)
    ) {
      setWebhookEditConflict("changed");
      return;
    }
    const name = webhookName.trim();
    const url = webhookUrl.trim();
    const errors = {
      name: name ? "" : "Enter a webhook name.",
      url: validateWebhookUrl(url) ?? "",
      events: selectedEvents.length ? "" : "Choose at least one event.",
    };
    setWebhookErrors(errors);
    if (errors.name || errors.url || errors.events) {
      if (errors.name) webhookNameRef.current?.focus();
      else if (errors.url) webhookUrlRef.current?.focus();
      return;
    }
    const webhook: WebhookEndpoint = latestEditingWebhook
      ? { ...latestEditingWebhook, name, url, events: selectedEvents }
      : {
          id: newId(),
          name,
          url,
          events: selectedEvents,
          enabled: true,
          createdAt: today(),
          lastDelivery: null,
        };
    const webhooks = latestEditingWebhook
      ? latestData.webhooks.map((item) =>
          item.id === latestEditingWebhook.id ? webhook : item,
        )
      : [webhook, ...latestData.webhooks];
    if (
      persist(
        { ...latestData, webhooks },
        latestEditingWebhook ? `${name} updated.` : `${name} added.`,
      )
    ) {
      setWebhookDialogOpen(false);
      setEditingWebhookId(null);
      setEditingWebhookBaseline(null);
    }
  }

  function revokeCredential() {
    if (!credentialToRevoke) return;
    const name = credentialToRevoke.name;
    const latestData = latestDataForMutation(
      credentialRevokeStartedWithMissingKey,
      () => setCredentialRevokeConflict("cleared"),
    );
    if (!latestData) return;
    const latestCredential = latestData.credentials.find(
      (item) => item.id === credentialToRevoke.id,
    );
    if (!latestCredential) {
      setCredentialRevokeConflict("deleted");
      return;
    }
    if (
      JSON.stringify(latestCredential) !== JSON.stringify(credentialToRevoke)
    ) {
      setCredentialRevokeConflict("changed");
      return;
    }
    if (
      persist(
        {
          ...latestData,
          credentials: latestData.credentials.filter(
            (item) => item.id !== credentialToRevoke.id,
          ),
        },
        `${name} removed from preview data.`,
      )
    ) {
      setCredentialToRevoke(null);
    }
  }

  function rotateCredential() {
    if (!credentialToRotate) return;
    const latestData = latestDataForMutation(
      credentialRotateStartedWithMissingKey,
      () => setCredentialRotateConflict("cleared"),
    );
    if (!latestData) return;
    const latestCredential = latestData.credentials.find(
      (item) => item.id === credentialToRotate.id,
    );
    if (!latestCredential) {
      setCredentialRotateConflict("deleted");
      return;
    }
    if (
      JSON.stringify(latestCredential) !== JSON.stringify(credentialToRotate)
    ) {
      setCredentialRotateConflict("changed");
      return;
    }
    const secret = createCredentialSecret();
    const rotatedCredential: ApiCredential = {
      ...latestCredential,
      prefix: `${secret.slice(0, 12)}...${secret.slice(-4)}`,
      createdAt: today(),
      lastUsed: null,
    };
    if (
      persist(
        {
          ...latestData,
          credentials: latestData.credentials.map((item) =>
            item.id === latestCredential.id ? rotatedCredential : item,
          ),
        },
        `${latestCredential.name} rotated.`,
      )
    ) {
      setCredentialToRotate(null);
      setCreatedSecret(secret);
      setCreatedSecretAction("rotated");
      setCopyState("idle");
    }
  }

  function toggleWebhook(webhook: WebhookEndpoint) {
    const latestData = latestDataForMutation(
      integrationsSnapshot() === null,
      () => undefined,
    );
    if (!latestData) return;
    const latestWebhook = latestData.webhooks.find(
      (item) => item.id === webhook.id,
    );
    if (!latestWebhook) {
      setFeedback({
        kind: "alert",
        message: "This webhook no longer exists.",
      });
      return;
    }
    const enabled = !latestWebhook.enabled;
    persist(
      {
        ...latestData,
        webhooks: latestData.webhooks.map((item) =>
          item.id === latestWebhook.id ? { ...item, enabled } : item,
        ),
      },
      `${latestWebhook.name} ${enabled ? "resumed" : "paused"}.`,
    );
  }

  function deleteWebhook() {
    if (!webhookToDelete) return;
    const name = webhookToDelete.name;
    const latestData = latestDataForMutation(
      webhookDeleteStartedWithMissingKey,
      () => setWebhookDeleteConflict("cleared"),
    );
    if (!latestData) return;
    const latestWebhook = latestData.webhooks.find(
      (item) => item.id === webhookToDelete.id,
    );
    if (!latestWebhook) {
      setWebhookDeleteConflict("deleted");
      return;
    }
    if (JSON.stringify(latestWebhook) !== JSON.stringify(webhookToDelete)) {
      setWebhookDeleteConflict("changed");
      return;
    }
    if (
      persist(
        {
          ...latestData,
          webhooks: latestData.webhooks.filter(
            (item) => item.id !== webhookToDelete.id,
          ),
        },
        `${name} deleted from preview data.`,
      )
    ) {
      setWebhookToDelete(null);
      setSelectedWebhookId(null);
    }
  }

  return (
    <div className="space-y-5">
      {feedback && (
        <p
          role={feedback.kind}
          className={
            feedback.kind === "alert"
              ? "text-sm text-destructive"
              : "text-sm text-primary"
          }
        >
          {feedback.message}
        </p>
      )}

      {storageUnreadable && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <p className="text-sm text-destructive">
            Saved integration data could not be loaded. Showing the last loaded
            data; changes are disabled.
          </p>
          <Button
            variant="secondary"
            className="h-9 [@media(any-pointer:coarse)]:min-h-11"
            onClick={requestUnreadableReplacement}
          >
            Replace local data
          </Button>
        </div>
      )}

      <section
        aria-labelledby="credentials-heading"
        className="overflow-hidden rounded-xl border bg-card"
      >
        <div className="flex flex-col items-stretch gap-3 border-b px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-surface-elevated text-primary">
              <KeyRoundIcon className="size-4" aria-hidden="true" />
            </div>
            <h2 id="credentials-heading" className="text-base font-semibold">
              API credentials
            </h2>
          </div>
          <Button
            className="h-10 w-full sm:w-auto [@media(any-pointer:coarse)]:min-h-11"
            onClick={openCredentialDialog}
            disabled={storageUnreadable}
          >
            <PlusIcon aria-hidden="true" />
            Create credential
          </Button>
        </div>
        <div className="divide-y">
          {data.credentials.length ? (
            data.credentials.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                onRotate={(item) => {
                  setCredentialRotateStartedWithMissingKey(
                    integrationsSnapshot() === null,
                  );
                  setCredentialRotateConflict(null);
                  setCredentialToRotate(item);
                }}
                onRevoke={(item) => {
                  setCredentialRevokeStartedWithMissingKey(
                    integrationsSnapshot() === null,
                  );
                  setCredentialRevokeConflict(null);
                  setCredentialToRevoke(item);
                }}
                disabled={storageUnreadable}
              />
            ))
          ) : (
            <div className="px-6 py-10 text-center">
              <p className="text-sm font-medium">No API credentials</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Create a sample credential to preview this flow.
              </p>
            </div>
          )}
        </div>
      </section>

      <section
        aria-labelledby="webhooks-heading"
        className="overflow-hidden rounded-xl border bg-card"
      >
        <div className="flex flex-col items-stretch gap-3 border-b px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-surface-elevated text-primary">
              <RadioTowerIcon className="size-4" aria-hidden="true" />
            </div>
            <h2 id="webhooks-heading" className="text-base font-semibold">
              Webhooks
            </h2>
          </div>
          <Button
            variant="outline"
            className="h-10 w-full sm:w-auto [@media(any-pointer:coarse)]:min-h-11"
            onClick={openWebhookDialog}
            disabled={storageUnreadable}
          >
            <PlusIcon aria-hidden="true" />
            Add webhook
          </Button>
        </div>
        <div className="divide-y">
          {data.webhooks.length ? (
            data.webhooks.map((webhook) => (
              <WebhookRow
                key={webhook.id}
                webhook={webhook}
                onOpen={(item) => {
                  setRetryUnavailable(false);
                  setSelectedWebhookId(item.id);
                }}
                onEdit={editWebhook}
                onToggle={toggleWebhook}
                onDelete={(item) => {
                  setWebhookDeleteStartedWithMissingKey(
                    integrationsSnapshot() === null,
                  );
                  setWebhookDeleteConflict(null);
                  setWebhookToDelete(item);
                }}
                disabled={storageUnreadable}
              />
            ))
          ) : (
            <div className="px-6 py-10 text-center">
              <p className="text-sm font-medium">No webhooks</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a sample endpoint to preview this flow.
              </p>
            </div>
          )}
        </div>
      </section>

      <Dialog
        open={credentialDialogOpen}
        onOpenChange={setCredentialDialogOpen}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create API credential</DialogTitle>
            <DialogDescription>
              Name this sample credential. It is stored in this browser and
              cannot authenticate to the Cupboard API.
            </DialogDescription>
          </DialogHeader>
          {credentialStorageCleared && (
            <p role="alert" className="text-sm text-destructive">
              Integration data was cleared in another tab. Close and reopen this
              form before creating a credential.
            </p>
          )}
          <form
            id="create-credential-form"
            onSubmit={createCredential}
            className="grid gap-2 py-2"
          >
            <Label htmlFor="credential-name">Credential name</Label>
            <Input
              ref={credentialNameRef}
              id="credential-name"
              value={credentialName}
              onChange={(event) => {
                setCredentialName(event.target.value);
                if (event.target.value.trim()) setCredentialNameError("");
              }}
              aria-invalid={Boolean(credentialNameError)}
              aria-describedby={
                credentialNameError ? "credential-name-error" : undefined
              }
              className="h-10 [@media(any-pointer:coarse)]:h-11"
              autoComplete="off"
              maxLength={80}
            />
            {credentialNameError && (
              <p
                id="credential-name-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {credentialNameError}
              </p>
            )}
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              onClick={() => setCredentialDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-credential-form"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              disabled={!credentialNameValid || credentialStorageCleared}
            >
              Create credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(createdSecret)} onOpenChange={() => undefined}>
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              Credential{" "}
              {createdSecretAction === "created" ? "created" : "rotated"}
            </DialogTitle>
            <DialogDescription>
              This sample secret cannot authenticate. Copy it now if needed;
              Cupboard will not show it again.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-input-background p-3">
            <code
              data-testid="created-credential"
              tabIndex={0}
              aria-label="Credential secret"
              className="block cursor-text select-all break-all font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {createdSecret}
            </code>
          </div>
          {copyState === "error" && (
            <p role="alert" className="text-sm text-destructive">
              Couldn&apos;t copy to clipboard.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              onClick={() => setCreatedSecret(null)}
            >
              Done
            </Button>
            <Button
              variant={copyState === "error" ? "destructive" : "default"}
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              onClick={copyCredential}
            >
              <ClipboardIcon aria-hidden="true" />
              {copyState === "error"
                ? "Retry copy"
                : copyState === "copied"
                  ? "Copied"
                  : "Copy credential"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={webhookDialogOpen}
        onOpenChange={(open) => {
          setWebhookDialogOpen(open);
          if (!open) {
            setEditingWebhookId(null);
            setEditingWebhookBaseline(null);
            setWebhookEditConflict(null);
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingWebhookId ? "Edit webhook" : "Add webhook"}
            </DialogTitle>
            <DialogDescription>
              {editingWebhookId
                ? "Update the endpoint and subscribed events."
                : "Save a sample endpoint and selected events in this browser. This preview does not send webhooks."}
            </DialogDescription>
          </DialogHeader>
          {webhookEditIssue && (
            <p role="alert" className="text-sm text-destructive">
              {webhookEditIssue === "deleted"
                ? "This webhook was deleted in another tab. Close this dialog without saving."
                : "This webhook changed in another tab. Close and reopen it before editing again."}
            </p>
          )}
          {webhookStorageCleared && (
            <p role="alert" className="text-sm text-destructive">
              Integration data was cleared in another tab. Close and reopen this
              form before saving.
            </p>
          )}
          <form
            id="create-webhook-form"
            onSubmit={createWebhook}
            className="grid gap-5 py-2"
          >
            <div className="grid gap-2">
              <Label htmlFor="webhook-name">Webhook name</Label>
              <Input
                ref={webhookNameRef}
                id="webhook-name"
                value={webhookName}
                onChange={(event) => {
                  setWebhookName(event.target.value);
                  if (event.target.value.trim()) {
                    setWebhookErrors((current) => ({
                      ...current,
                      name: "",
                    }));
                  }
                }}
                aria-invalid={Boolean(webhookErrors.name)}
                className="h-10 [@media(any-pointer:coarse)]:h-11"
                autoComplete="off"
                maxLength={80}
              />
              {webhookErrors.name && (
                <p role="alert" className="text-sm text-destructive">
                  {webhookErrors.name}
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="webhook-url">Endpoint URL</Label>
              <Input
                ref={webhookUrlRef}
                id="webhook-url"
                type="url"
                placeholder="https://example.com/hooks/cupboard"
                value={webhookUrl}
                onChange={(event) => {
                  setWebhookUrl(event.target.value);
                  setWebhookErrors((current) => ({
                    ...current,
                    url: "",
                  }));
                }}
                onBlur={() =>
                  setWebhookErrors((current) => ({
                    ...current,
                    url: webhookUrl.trim()
                      ? (validateWebhookUrl(webhookUrl.trim()) ?? "")
                      : "",
                  }))
                }
                aria-invalid={Boolean(webhookErrors.url)}
                className="h-10 font-mono [@media(any-pointer:coarse)]:h-11"
                maxLength={2048}
              />
              {webhookErrors.url ? (
                <p role="alert" className="text-sm text-destructive">
                  {webhookErrors.url}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Use HTTPS. Localhost may use HTTP during development.
                </p>
              )}
            </div>
            <fieldset className="grid gap-3">
              <legend className="text-sm font-medium">Events</legend>
              {webhookEvents.map((option) => (
                <label
                  key={option.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm hover:border-border-strong hover:bg-surface-elevated"
                >
                  <Checkbox
                    checked={selectedEvents.includes(option.id)}
                    onCheckedChange={(checked) => {
                      const next =
                        checked === true
                          ? [...selectedEvents, option.id]
                          : selectedEvents.filter(
                              (event) => event !== option.id,
                            );
                      setSelectedEvents(next);
                      if (next.length) {
                        setWebhookErrors((errors) => ({
                          ...errors,
                          events: "",
                        }));
                      }
                    }}
                  />
                  {option.label}
                </label>
              ))}
              {webhookErrors.events && (
                <p role="alert" className="text-sm text-destructive">
                  {webhookErrors.events}
                </p>
              )}
            </fieldset>
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              onClick={() => setWebhookDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-webhook-form"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              disabled={
                !webhookFormValid ||
                Boolean(webhookEditIssue) ||
                webhookStorageCleared
              }
            >
              {editingWebhookId ? "Save changes" : "Add webhook"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet
        open={Boolean(selectedWebhook)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedWebhookId(null);
            setRetryUnavailable(false);
          }
        }}
      >
        <SheetContent className="w-full gap-0 sm:max-w-[452px]">
          {selectedWebhook && (
            <>
              <SheetHeader className="border-b px-6 py-5 pr-14">
                <div className="flex flex-wrap items-center gap-2">
                  <SheetTitle className="text-lg">
                    {selectedWebhook.name}
                  </SheetTitle>
                  <Badge
                    variant={
                      selectedWebhook.lastDelivery &&
                      selectedWebhook.lastDelivery.status >= 400
                        ? "destructive"
                        : "outline"
                    }
                    className={
                      selectedWebhook.lastDelivery &&
                      selectedWebhook.lastDelivery.status >= 400
                        ? undefined
                        : selectedWebhook.enabled
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "text-muted-foreground"
                    }
                  >
                    {selectedWebhook.lastDelivery &&
                    selectedWebhook.lastDelivery.status >= 400
                      ? "Delivery failed"
                      : selectedWebhook.enabled
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
                      {selectedWebhook.url}
                    </dd>
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-text-muted">
                        Signing secret
                      </dt>
                      <dd className="mt-1.5 text-sm text-muted-foreground">
                        Not configured
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-text-muted">Created</dt>
                      <dd className="mt-1.5 text-sm text-muted-foreground">
                        {selectedWebhook.createdAt}
                      </dd>
                    </div>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">
                      Subscribed events
                    </dt>
                    <dd className="mt-2 flex flex-wrap gap-2">
                      {selectedWebhook.events.map((event) => (
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
                    {selectedWebhook.lastDelivery ? (
                      <div className="flex items-center justify-between gap-4 px-4 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          {selectedWebhook.lastDelivery.status >= 400 ? (
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
                              {selectedWebhook.lastDelivery.status >= 400
                                ? "Delivery failed"
                                : "Delivered"}
                            </p>
                            <p className="mt-1 text-xs text-text-muted">
                              {selectedWebhook.lastDelivery.deliveredAt}
                            </p>
                          </div>
                        </div>
                        <code className="rounded-md bg-surface-elevated px-2 py-1 font-mono text-xs text-muted-foreground">
                          HTTP {selectedWebhook.lastDelivery.status}
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
                {selectedWebhook.lastDelivery &&
                  selectedWebhook.lastDelivery.status >= 400 && (
                    <Button
                      variant="outline"
                      className="h-10 [@media(any-pointer:coarse)]:min-h-11"
                      onClick={() => setRetryUnavailable(true)}
                    >
                      <RefreshCwIcon aria-hidden="true" />
                      Retry delivery
                    </Button>
                  )}
                <Button
                  variant="outline"
                  className="h-10 [@media(any-pointer:coarse)]:min-h-11"
                  onClick={() => editWebhook(selectedWebhook)}
                  disabled={storageUnreadable}
                >
                  <PencilIcon aria-hidden="true" />
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  className="h-10 [@media(any-pointer:coarse)]:min-h-11 sm:ml-auto"
                  onClick={() => {
                    setSelectedWebhookId(null);
                    setWebhookDeleteStartedWithMissingKey(
                      integrationsSnapshot() === null,
                    );
                    setWebhookDeleteConflict(null);
                    setWebhookToDelete(selectedWebhook);
                  }}
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

      <AlertDialog
        open={unreadableToReplace !== null}
        onOpenChange={(open) => {
          if (!open) {
            setUnreadableToReplace(null);
            restoreSuspendedDraft();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <CircleAlertIcon
                className="text-destructive"
                aria-hidden="true"
              />
            </AlertDialogMedia>
            <AlertDialogTitle>
              Replace unreadable integration data?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The saved credential and webhook preview data will be discarded
              and replaced with sample data. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              variant="secondary"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
            >
              Keep data
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              onClick={(event) => {
                event.preventDefault();
                replaceUnreadableData();
              }}
            >
              Replace local data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(credentialToRotate)}
        onOpenChange={(open) => {
          if (!open) {
            setCredentialToRotate(null);
            setCredentialRotateConflict(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <RefreshCwIcon className="text-warning" aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              Rotate {credentialToRotate?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This replaces the credential in this browser preview and shows the
              new key once. The previous preview key cannot be recovered.
            </AlertDialogDescription>
            {credentialRotateConflict && (
              <p role="alert" className="text-sm text-destructive">
                {credentialRotateConflict === "deleted"
                  ? "This credential was already removed in another tab. Close this confirmation."
                  : credentialRotateConflict === "changed"
                    ? "This credential changed in another tab. Close and reopen the confirmation before rotating it."
                    : "Integration data was cleared in another tab. Close this confirmation before trying again."}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              variant="secondary"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
            >
              Keep current key
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              onClick={(event) => {
                event.preventDefault();
                rotateCredential();
              }}
              disabled={Boolean(credentialRotateConflict)}
            >
              Rotate key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(credentialToRevoke)}
        onOpenChange={(open) => {
          if (!open) {
            setCredentialToRevoke(null);
            setCredentialRevokeConflict(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2Icon className="text-destructive" aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              Revoke {credentialToRevoke?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the credential from this browser preview. It does not
              revoke access to a live API. This cannot be undone.
            </AlertDialogDescription>
            {credentialRevokeConflict && (
              <p role="alert" className="text-sm text-destructive">
                {credentialRevokeConflict === "deleted"
                  ? "This credential was already removed in another tab. Close this confirmation."
                  : credentialRevokeConflict === "changed"
                    ? "This credential changed in another tab. Close and reopen the confirmation before revoking it."
                    : "Integration data was cleared in another tab. Close this confirmation before trying again."}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              variant="secondary"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
            >
              Keep credential
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              onClick={(event) => {
                event.preventDefault();
                revokeCredential();
              }}
              disabled={Boolean(credentialRevokeConflict)}
            >
              Revoke credential
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(webhookToDelete)}
        onOpenChange={(open) => {
          if (!open) {
            setWebhookToDelete(null);
            setWebhookDeleteConflict(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2Icon className="text-destructive" aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete {webhookToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the endpoint and its sample delivery history from
              this browser preview. This cannot be undone.
            </AlertDialogDescription>
            {webhookDeleteConflict && (
              <p role="alert" className="text-sm text-destructive">
                {webhookDeleteConflict === "deleted"
                  ? "This webhook was already deleted in another tab. Close this confirmation."
                  : webhookDeleteConflict === "changed"
                    ? "This webhook changed in another tab. Close and reopen the confirmation before deleting it."
                    : "Integration data was cleared in another tab. Close this confirmation before trying again."}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              variant="secondary"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
            >
              Keep webhook
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-10 [@media(any-pointer:coarse)]:min-h-11"
              onClick={(event) => {
                event.preventDefault();
                deleteWebhook();
              }}
              disabled={Boolean(webhookDeleteConflict)}
            >
              Delete webhook
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
