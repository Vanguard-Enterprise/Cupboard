"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  KeyRoundIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  WalletCardsIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  defaultOrganizationAccess,
  organizationAccessChangedEvent,
  organizationAccessKey,
  parseOrganizationAccess,
  type ApprovalRule,
  type OrganizationAccessSettings,
} from "@/lib/organization-access";

const ruleIcons: Record<ApprovalRule["id"], typeof ServerCogIcon> = {
  "server-lifecycle": ServerCogIcon,
  credentials: KeyRoundIcon,
  billing: WalletCardsIcon,
};

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === organizationAccessKey) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(organizationAccessChangedEvent, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(organizationAccessChangedEvent, callback);
  };
}

function snapshot() {
  try {
    return window.localStorage.getItem(organizationAccessKey) ?? "";
  } catch {
    return "storage-unavailable";
  }
}

const serverSnapshot = () => null;

function AccessEditor({
  saved,
  sourceVersion,
  initialStorageError,
  needsReplacement,
}: {
  saved: OrganizationAccessSettings;
  sourceVersion: string;
  initialStorageError: string;
  needsReplacement: boolean;
}) {
  const [draft, setDraft] = useState<OrganizationAccessSettings>(saved);
  const [baseline, setBaseline] = useState(saved);
  const [baselineVersion, setBaselineVersion] = useState(sourceVersion);
  const [conflict, setConflict] = useState(false);
  const [storageError, setStorageError] = useState(initialStorageError);
  const [saveMessage, setSaveMessage] = useState("");

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  if (sourceVersion !== baselineVersion) {
    const wasDirty = JSON.stringify(draft) !== JSON.stringify(baseline);
    setBaselineVersion(sourceVersion);
    setBaseline(saved);
    setStorageError(initialStorageError);
    if (!wasDirty) {
      setDraft(saved);
      setConflict(false);
    } else {
      setConflict(JSON.stringify(draft) !== JSON.stringify(saved));
    }
  }

  function updateRule(id: ApprovalRule["id"], update: Partial<ApprovalRule>) {
    setSaveMessage("");
    setDraft((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === id ? { ...rule, ...update } : rule,
      ),
    }));
  }

  function saveChanges() {
    try {
      window.localStorage.setItem(organizationAccessKey, JSON.stringify(draft));
      window.dispatchEvent(new Event(organizationAccessChangedEvent));
      setStorageError("");
      setSaveMessage("Approval settings saved.");
    } catch {
      setSaveMessage("");
      setStorageError("Could not save approval settings in this browser.");
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if ((dirty || needsReplacement) && !conflict) saveChanges();
      }}
    >
      {storageError && (
        <Alert variant="destructive">
          <AlertDescription>{storageError}</AlertDescription>
        </Alert>
      )}

      <section
        aria-labelledby="approval-heading"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="border-b border-border px-4 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <ShieldCheckIcon
              className="size-5 shrink-0 text-primary"
              aria-hidden="true"
            />
            <h2 id="approval-heading" className="text-lg font-semibold">
              Approval rules
            </h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Saved in this browser. These rules do not block sensitive actions.
          </p>
        </div>
        <div className="divide-y divide-border">
          {draft.rules.map((rule) => {
            const Icon = ruleIcons[rule.id];
            return (
              <div
                key={rule.id}
                data-testid={`approval-rule-${rule.id}`}
                className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_6rem] sm:items-center sm:gap-5 sm:px-6"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated text-muted-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <h3 className="text-sm font-medium">{rule.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {rule.description}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 sm:justify-end">
                  <Label
                    htmlFor={`${rule.id}-approvers`}
                    className="text-sm font-normal text-muted-foreground sm:sr-only"
                  >
                    Approvals required
                  </Label>
                  <Select
                    value={String(rule.approvals)}
                    onValueChange={(value) =>
                      updateRule(rule.id, {
                        approvals: Number(value) as 0 | 1 | 2,
                      })
                    }
                  >
                    <SelectTrigger
                      id={`${rule.id}-approvers`}
                      aria-label={`Approvals required for ${rule.title}`}
                      className="h-11 w-24 border-border bg-input-background sm:h-10"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="end">
                      <SelectItem value="0">None</SelectItem>
                      <SelectItem value="1">1</SelectItem>
                      <SelectItem value="2">2</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-4 py-4 sm:px-6">
          {conflict && (
            <Alert
              variant="destructive"
              className="mr-auto w-full sm:w-auto sm:max-w-full"
            >
              <AlertDescription className="flex flex-wrap items-center gap-3">
                <span>Approval settings changed in another tab.</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraft(saved);
                    setConflict(false);
                  }}
                >
                  Load latest
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {saveMessage && (
            <Alert
              role="status"
              className="mr-auto w-full border-primary/25 bg-primary/5 sm:w-auto sm:max-w-full"
            >
              <AlertDescription className="text-primary">
                {saveMessage}
              </AlertDescription>
            </Alert>
          )}
          <Button
            type="submit"
            className="h-11 w-full px-4 sm:h-9 sm:w-auto"
            disabled={(!dirty && !needsReplacement) || conflict}
          >
            Save changes
          </Button>
        </div>
      </section>
    </form>
  );
}

export function OrganizationAccess() {
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const loaded = useMemo(() => {
    let saved = defaultOrganizationAccess;
    let storageError = "";
    let needsReplacement = false;
    if (raw === "storage-unavailable") {
      storageError = "Approval settings cannot use browser storage.";
    } else if (raw) {
      try {
        saved = parseOrganizationAccess(raw);
      } catch {
        storageError =
          "Saved approval settings could not be loaded. Saving will replace the local copy.";
        needsReplacement = true;
      }
    }
    return { saved, storageError, needsReplacement };
  }, [raw]);
  if (raw === null)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading approval settings...
      </p>
    );

  return (
    <AccessEditor
      saved={loaded.saved}
      sourceVersion={raw}
      initialStorageError={loaded.storageError}
      needsReplacement={loaded.needsReplacement}
    />
  );
}
