"use client";

import { toast } from "sonner";
import { usePreviewStorage } from "./preview-storage";

import { useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  defaultOrganizationNotifications,
  organizationNotificationsKey,
  parseOrganizationNotifications,
  type OrganizationNotifications,
} from "@/lib/organization-notifications";
const notificationOptions = [
  {
    key: "serverIncidents",
    title: "Server incidents",
    description: "Server outages and incidents.",
  },
  {
    key: "securityAlerts",
    title: "Security alerts",
    description: "Access and security changes.",
  },
  {
    key: "moderationActivity",
    title: "Moderation activity",
    description: "Moderation cases needing attention.",
  },
  {
    key: "weeklySummary",
    title: "Weekly summary",
    description: "A weekly organization summary.",
  },
] as const satisfies ReadonlyArray<{
  key: keyof OrganizationNotifications;
  title: string;
  description: string;
}>;

const serverSnapshot = () => null;

function useSavedNotifications() {
  const storage = usePreviewStorage(
    organizationNotificationsKey,
    "cupboard-notifications-saved",
  );
  const { subscribe: subscribe, snapshot: snapshot } = storage;
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return useMemo(() => {
    let preferences = defaultOrganizationNotifications;
    let storageError = "";
    if (raw) {
      try {
        preferences = parseOrganizationNotifications(raw);
      } catch {
        storageError =
          "Saved notification choices could not be loaded. Saving will replace the local copy.";
      }
    }

    return {
      preferences,
      ready: raw !== null,
      storageError,
      needsReplacement: Boolean(storageError),
      save(next: OrganizationNotifications) {
        storage.set(JSON.stringify(next));
      },
    };
  }, [raw, storage]);
}

function NotificationPreferencesEditor({
  saved,
  save,
  needsReplacement,
}: {
  saved: OrganizationNotifications;
  save: (next: OrganizationNotifications) => void;
  needsReplacement: boolean;
}) {
  const [draft, setDraft] = useState(saved);
  const [baseline, setBaseline] = useState(saved);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState("");

  if (saved !== baseline) {
    setBaseline(saved);
    if (JSON.stringify(draft) === JSON.stringify(baseline)) {
      setDraft(saved);
      setConflict(false);
    } else {
      setConflict(JSON.stringify(draft) !== JSON.stringify(saved));
    }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if ((!dirty && !needsReplacement) || conflict) return;
        setSaveError("");
        try {
          save(draft);
          toast.success("Preferences saved.");
        } catch {
          setSaveError("Could not save your choices. Please try again.");
        }
      }}
    >
      <section
        aria-labelledby="notification-preferences-heading"
        className="space-y-6"
      >
        <h2 id="notification-preferences-heading" className="sr-only">
          Notification preferences
        </h2>
        <div className="divide-y divide-border">
          {[
            {
              title: "Operational alerts",
              description: "Events that need your team's attention.",
              options: notificationOptions.slice(0, 3),
            },
            {
              title: "Summaries",
              description: "",
              options: notificationOptions.slice(3),
            },
          ].map((group) => (
            <fieldset key={group.title} className="min-w-0 py-8 first:pt-0">
              <legend className="float-left w-full text-base font-semibold">
                {group.title}
              </legend>
              {group.description && (
                <p className="clear-both pt-1 text-sm text-muted-foreground">
                  {group.description}
                </p>
              )}
              <div className="clear-both pt-4 space-y-1">
                {group.options.map((option) => (
                  <div
                    key={option.key}
                    className="flex items-center justify-between gap-6 py-3"
                  >
                    <label
                      htmlFor={option.key}
                      className="min-w-0 cursor-pointer pr-2"
                    >
                      <span className="block text-sm font-medium">
                        {option.title}
                      </span>
                      <span
                        id={`${option.key}-description`}
                        className="mt-1 block text-xs leading-5 text-muted-foreground"
                      >
                        {option.description}
                      </span>
                    </label>
                    <Switch
                      id={option.key}
                      size="lg"
                      checked={draft[option.key]}
                      onCheckedChange={(checked) => {
                        setDraft({ ...draft, [option.key]: checked });
                        setSaveError("");
                      }}
                      aria-label={option.title}
                      aria-describedby={`${option.key}-description`}
                      className="after:-inset-y-2.5 motion-reduce:transition-none [&_[data-slot=switch-thumb]]:motion-reduce:transition-none data-checked:ring-1 data-checked:ring-primary/50 data-unchecked:bg-border-strong dark:data-unchecked:bg-border-strong"
                    />
                  </div>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border py-4">
          {dirty && !conflict && !saveError && (
            <p className="mr-auto text-sm text-muted-foreground">
              Unsaved changes
            </p>
          )}
          {conflict && (
            <Alert variant="destructive" className="w-full">
              <AlertDescription>
                These choices changed in another tab. Cancel to load the latest
                version before editing again.
              </AlertDescription>
            </Alert>
          )}
          {saveError && (
            <Alert variant="destructive" className="mr-auto w-auto max-w-full">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
            disabled={!dirty && !conflict}
            onClick={() => {
              setDraft(saved);
              setConflict(false);
              setSaveError("");
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
            disabled={(!dirty && !needsReplacement) || conflict}
          >
            Save changes
          </Button>
        </div>
      </section>
    </form>
  );
}

export function OrganizationNotificationsData() {
  const { preferences, ready, save, storageError, needsReplacement } =
    useSavedNotifications();

  if (!ready) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading notification preferences...
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {storageError && (
        <Alert variant="destructive">
          <AlertDescription>{storageError}</AlertDescription>
        </Alert>
      )}

      <NotificationPreferencesEditor
        saved={preferences}
        save={save}
        needsReplacement={needsReplacement}
      />
    </div>
  );
}
