"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  defaultOrganizationNotifications,
  organizationNotificationsKey,
  parseOrganizationNotifications,
  type OrganizationNotifications,
} from "@/lib/organization-notifications";
import { organizationProfileKey } from "@/lib/organization-profile";

const notificationOptions = [
  {
    key: "serverIncidents",
    title: "Server incidents",
    description:
      "Does not send email yet. Preference for server outages and incidents.",
  },
  {
    key: "securityAlerts",
    title: "Security alerts",
    description:
      "Does not send email yet. Preference for access and security changes.",
  },
  {
    key: "moderationActivity",
    title: "Moderation activity",
    description:
      "Does not send email yet. Preference for moderation cases needing attention.",
  },
  {
    key: "weeklySummary",
    title: "Weekly summary",
    description:
      "Does not send email yet. Preference for a weekly organization summary.",
  },
] as const satisfies ReadonlyArray<{
  key: keyof OrganizationNotifications;
  title: string;
  description: string;
}>;

const notificationsChangedEvent = "cupboard-notifications-saved";

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === organizationNotificationsKey) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(notificationsChangedEvent, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(notificationsChangedEvent, callback);
  };
}

function snapshot() {
  try {
    return window.localStorage.getItem(organizationNotificationsKey) ?? "";
  } catch {
    return "storage-unavailable";
  }
}

const serverSnapshot = () => null;

function useSavedNotifications() {
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
        window.localStorage.setItem(
          organizationNotificationsKey,
          JSON.stringify(next),
        );
        window.dispatchEvent(new Event(notificationsChangedEvent));
      },
    };
  }, [raw]);
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
  const [savedNotice, setSavedNotice] = useState(false);

  if (saved !== baseline) {
    setBaseline(saved);
    if (JSON.stringify(draft) !== JSON.stringify(saved)) {
      setSavedNotice(false);
    }
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
        setSavedNotice(false);
        try {
          save(draft);
          setSavedNotice(true);
        } catch {
          setSaveError("Could not save your choices. Please try again.");
        }
      }}
    >
      <section
        aria-labelledby="notification-preferences-heading"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="border-b border-border px-6 py-5 sm:px-8">
          <h2
            id="notification-preferences-heading"
            className="text-lg font-semibold"
          >
            Notification preferences
          </h2>
        </div>
        <div className="divide-y divide-border/60 px-6 sm:px-8">
          {notificationOptions.map((option) => (
            <div
              key={option.key}
              className="flex items-center justify-between gap-6 py-4"
            >
              <label
                htmlFor={option.key}
                className="min-w-0 cursor-pointer pr-2"
              >
                <span className="block text-sm font-medium">
                  {option.title}
                </span>
                <span className="mt-2 block text-xs leading-5 text-muted-foreground">
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
                  setSavedNotice(false);
                }}
                aria-label={option.title}
                className="data-checked:ring-1 data-checked:ring-primary/50 data-unchecked:bg-border-strong dark:data-unchecked:bg-border-strong"
              />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-6 py-4 sm:px-8">
          {savedNotice && !dirty && (
            <p role="status" className="mr-auto text-sm text-muted-foreground">
              Preferences saved.
            </p>
          )}
          {conflict && (
            <p role="alert" className="w-full text-sm text-destructive">
              These choices changed in another tab. Cancel to load the latest
              version before editing again.
            </p>
          )}
          {saveError && (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {saveError}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-11 px-4 sm:h-9"
            disabled={!dirty && !conflict}
            onClick={() => {
              setDraft(saved);
              setConflict(false);
              setSaveError("");
              setSavedNotice(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="h-11 px-4 sm:h-9"
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
  const [clearError, setClearError] = useState("");
  const [clearedNotice, setClearedNotice] = useState(false);
  const [editorGeneration, setEditorGeneration] = useState(0);

  if (!ready) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading notification preferences...
      </p>
    );
  }

  function clearLocalData() {
    setClearError("");
    setClearedNotice(false);
    try {
      window.localStorage.removeItem(organizationProfileKey);
      window.localStorage.removeItem(organizationNotificationsKey);
      window.dispatchEvent(new Event("cupboard-profile-saved"));
      window.dispatchEvent(new Event(notificationsChangedEvent));
      setEditorGeneration((value) => value + 1);
      setClearedNotice(true);
    } catch {
      setClearError("Could not clear local data. Please try again.");
    }
  }

  return (
    <div className="space-y-6">
      {storageError && (
        <p role="alert" className="text-sm text-destructive">
          {storageError}
        </p>
      )}

      <NotificationPreferencesEditor
        key={editorGeneration}
        saved={preferences}
        save={save}
        needsReplacement={needsReplacement}
      />

      <section
        aria-labelledby="local-data-heading"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="border-b border-border px-6 py-3.5 sm:px-8">
          <h2 id="local-data-heading" className="text-lg font-semibold">
            Local data
          </h2>
        </div>
        <div className="flex flex-col gap-4 px-6 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="min-w-0">
            <p className="text-sm font-medium">Organization data</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Profile and notification preferences stored in this browser.
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                className="h-11 shrink-0 border border-destructive/15 bg-transparent text-destructive/75 hover:border-destructive/50 hover:bg-destructive/15 hover:text-destructive sm:h-9 dark:bg-transparent dark:hover:bg-destructive/15"
                onClick={() => {
                  setClearError("");
                  setClearedNotice(false);
                }}
              >
                Clear local data
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogMedia className="text-destructive">
                  <Trash2Icon />
                </AlertDialogMedia>
                <AlertDialogTitle>Clear local data?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the organization profile and notification
                  preferences saved in this browser. You cannot undo this
                  action.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep data</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={clearLocalData}
                >
                  Clear local data
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {(clearedNotice || clearError) && (
          <div className="border-t border-border px-6 py-3 sm:px-8">
            {clearedNotice && (
              <p role="status" className="text-sm text-muted-foreground">
                Local data cleared.
              </p>
            )}
            {clearError && (
              <p role="alert" className="text-sm text-destructive">
                {clearError}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
