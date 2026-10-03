"use client";

import { usePreviewStorage } from "./preview-storage";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  ChevronRightIcon,
  KeyRoundIcon,
  ServerCogIcon,
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
  const storage = usePreviewStorage(
    organizationAccessKey,
    organizationAccessChangedEvent,
  );
  const [selectedId, setSelectedId] =
    useState<ApprovalRule["id"]>("server-lifecycle");
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
      storage.set(JSON.stringify(draft));
      setStorageError("");
      setSaveMessage("Approval settings saved.");
    } catch {
      setSaveMessage("");
      setStorageError("Could not save approval settings in this browser.");
    }
  }

  function cancelChanges() {
    setDraft(saved);
    setConflict(false);
    setStorageError(initialStorageError);
    setSaveMessage("");
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

      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-label="Approval rules">
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {draft.rules.map((rule) => {
              const Icon = ruleIcons[rule.id];
              const selected = selectedId === rule.id;
              return (
                <button
                  key={rule.id}
                  type="button"
                  aria-pressed={selected}
                  aria-controls="approval-detail"
                  onClick={() => setSelectedId(rule.id)}
                  data-testid={`approval-rule-${rule.id}`}
                  className={`flex min-h-20 w-full items-center gap-3 border-b border-border px-4 py-4 text-left last:border-b-0 transition-colors duration-150 hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none ${selected ? "bg-surface-elevated" : ""}`}
                >
                  <span
                    className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${selected ? "bg-primary/10 text-primary" : "bg-surface-elevated text-muted-foreground"}`}
                  >
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {rule.title}
                    </span>{" "}
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {rule.approvals === 0
                        ? "No approval required"
                        : `${rule.approvals} ${rule.approvals === 1 ? "approval" : "approvals"} required`}
                    </span>
                  </span>
                  <ChevronRightIcon
                    className={`size-4 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </section>
        <section
          id="approval-detail"
          aria-labelledby="policy-heading"
          className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
        >
          {draft.rules
            .filter((rule) => rule.id === selectedId)
            .map((rule) => {
              const Icon = ruleIcons[rule.id];
              return (
                <div key={rule.id} className="space-y-6 px-5 py-6">
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Approval rule
                      </p>
                      <h2
                        id="policy-heading"
                        className="mt-1 text-base font-semibold"
                      >
                        {rule.title}
                      </h2>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium">Applies to</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {rule.description}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-elevated p-4">
                    <Label
                      htmlFor={`${rule.id}-approvers`}
                      className="text-sm font-medium"
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
                        className="mt-3 w-full border-border bg-input-background data-[size=default]:h-11 sm:data-[size=default]:h-10"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper" align="end">
                        <SelectItem value="0">No approval required</SelectItem>
                        <SelectItem value="1">1 approval</SelectItem>
                        <SelectItem value="2">2 approvals</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                      {rule.approvals === 0
                        ? "No additional approval is configured for these actions."
                        : `These actions are configured to require ${rule.approvals === 1 ? "one approval" : "two approvals"}.`}
                    </p>
                  </div>
                </div>
              );
            })}
        </section>
      </div>
      <div className="border-t border-border pt-5">
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dirty && !conflict && (
            <p className="mr-auto text-sm text-muted-foreground">
              Unsaved changes
            </p>
          )}
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
            type="button"
            variant="outline"
            className="h-11 w-full px-4 sm:h-9 sm:w-auto"
            disabled={!dirty || conflict}
            onClick={cancelChanges}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="h-11 w-full px-4 sm:h-9 sm:w-auto"
            disabled={(!dirty && !needsReplacement) || conflict}
          >
            Save changes
          </Button>
        </div>
      </div>
    </form>
  );
}

export function OrganizationAccess() {
  const storage = usePreviewStorage(
    organizationAccessKey,
    organizationAccessChangedEvent,
  );
  const { subscribe: subscribe, snapshot: snapshot } = storage;
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
