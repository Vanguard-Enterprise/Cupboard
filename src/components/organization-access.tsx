"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  KeyRoundIcon,
  RotateCcwIcon,
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
import { Switch } from "@/components/ui/switch";
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
      toast.success("Approval settings saved.");
    } catch {
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
          <div className="flex items-start gap-3">
            <ShieldCheckIcon
              className="mt-0.5 size-5 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div>
              <h2 id="approval-heading" className="text-lg font-semibold">
                Approval rules
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Choose which sensitive actions need approval and how many people
                must approve them.
              </p>
            </div>
          </div>
        </div>
        <div className="divide-y divide-border">
          {draft.rules.map((rule) => {
            const Icon = ruleIcons[rule.id];
            return (
              <div
                key={rule.id}
                data-testid={`approval-rule-${rule.id}`}
                className="grid gap-5 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_13rem] sm:items-start sm:px-6"
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
                <div className="grid gap-3">
                  <div className="flex min-h-11 items-center justify-between gap-4 rounded-lg border border-border bg-input-background px-3">
                    <Label
                      htmlFor={`${rule.id}-enabled`}
                      className="cursor-pointer text-sm font-normal"
                    >
                      Require approval
                    </Label>
                    <Switch
                      id={`${rule.id}-enabled`}
                      checked={rule.enabled}
                      onCheckedChange={(enabled) =>
                        updateRule(rule.id, { enabled })
                      }
                      aria-label={`Require approval for ${rule.title}`}
                      className="data-checked:ring-1 data-checked:ring-primary/35"
                    />
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border bg-input-background px-3 py-2">
                    <Label
                      htmlFor={`${rule.id}-approvers`}
                      className="text-sm font-normal"
                    >
                      Approvers
                    </Label>
                    <Select
                      value={String(rule.approvals)}
                      disabled={!rule.enabled}
                      onValueChange={(value) =>
                        updateRule(rule.id, {
                          approvals: Number(value) as 1 | 2,
                        })
                      }
                    >
                      <SelectTrigger
                        id={`${rule.id}-approvers`}
                        aria-label={`Approvers for ${rule.title}`}
                        className="h-9 w-32 border-border bg-surface-elevated disabled:opacity-40"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper" align="end">
                        <SelectItem value="1">1 person</SelectItem>
                        <SelectItem value="2">2 people</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-3 border-t border-border px-4 py-4 sm:flex sm:flex-wrap sm:items-center sm:justify-end sm:px-6">
          {conflict && (
            <Alert
              variant="destructive"
              className="col-span-2 sm:mr-auto sm:w-auto sm:max-w-full"
            >
              <AlertDescription>
                Approval settings changed in another tab. Cancel to load the
                latest version.
              </AlertDescription>
            </Alert>
          )}
          <Button
            type="button"
            variant="secondary"
            className="h-11 w-full px-4 sm:h-9 sm:w-auto"
            disabled={!dirty && !conflict}
            onClick={() => {
              setDraft(saved);
              setConflict(false);
            }}
          >
            <RotateCcwIcon /> Cancel
          </Button>
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
