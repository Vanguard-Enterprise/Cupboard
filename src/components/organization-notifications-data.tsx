"use client";

import { usePreviewStorage } from "./preview-storage";

import { useMemo, useState, useSyncExternalStore } from "react";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { organizationIntegrationsKey } from "@/lib/organization-integrations";
import { organizationProfileKey } from "@/lib/organization-profile";
import { securityAlertStorageKey } from "@/lib/security-alerts";
import {
  organizationAccessChangedEvent,
  organizationAccessKey,
} from "@/lib/organization-access";

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

const notificationsChangedEvent = "cupboard-notifications-saved";

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
  const [saveMessage, setSaveMessage] = useState("");

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
        setSaveMessage("");
        try {
          save(draft);
          setSaveMessage("Preferences saved.");
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
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Saved in this browser. Cupboard does not send notifications yet.
          </p>
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
                  setSaveMessage("");
                }}
                aria-label={option.title}
                className="data-checked:ring-1 data-checked:ring-primary/50 data-unchecked:bg-border-strong dark:data-unchecked:bg-border-strong"
              />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-6 py-4 sm:px-8">
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
          {saveMessage && (
            <Alert
              role="status"
              className="mr-auto w-auto max-w-full border-primary/25 bg-primary/5"
            >
              <AlertDescription className="text-primary">
                {saveMessage}
              </AlertDescription>
            </Alert>
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
              setSaveMessage("");
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
  const profileStorage = usePreviewStorage(
    organizationProfileKey,
    "cupboard-profile-saved",
  );
  const notificationStorage = usePreviewStorage(
    organizationNotificationsKey,
    notificationsChangedEvent,
  );
  const integrationsStorage = usePreviewStorage(
    organizationIntegrationsKey,
    "cupboard-integrations-saved",
  );
  const accessStorage = usePreviewStorage(
    organizationAccessKey,
    organizationAccessChangedEvent,
  );
  const alertsStorage = usePreviewStorage(
    securityAlertStorageKey,
    "cupboard-security-alerts-saved",
  );
  const { preferences, ready, save, storageError, needsReplacement } =
    useSavedNotifications();
  const [clearError, setClearError] = useState("");
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
    try {
      profileStorage.remove();
      notificationStorage.remove();
      integrationsStorage.remove();
      accessStorage.remove();
      alertsStorage.remove();
      setEditorGeneration((value) => value + 1);
      toast.success("Local data cleared.");
    } catch {
      setClearError("Could not clear local data. Please try again.");
    }
  }

  return (
    <div className="space-y-6">
      {storageError && (
        <Alert variant="destructive">
          <AlertDescription>{storageError}</AlertDescription>
        </Alert>
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
              Your saved profile, notification, approval, credential, webhook,
              and alert settings for this organization in this browser.
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                className="h-11 shrink-0 border border-destructive/15 bg-transparent text-destructive/75 hover:border-destructive/50 hover:bg-destructive/15 hover:text-destructive sm:h-9 dark:bg-transparent dark:hover:bg-destructive/15"
                onClick={() => {
                  setClearError("");
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
                  This removes your saved profile, notification, approval,
                  credential, webhook, and alert settings for this organization
                  in this browser. Your account, memberships, and roles stay
                  unchanged. You cannot undo this action.
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
        {clearError && (
          <div className="border-t border-border px-6 py-3 sm:px-8">
            <Alert variant="destructive">
              <AlertDescription>{clearError}</AlertDescription>
            </Alert>
          </div>
        )}
      </section>
    </div>
  );
}
