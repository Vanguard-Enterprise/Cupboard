"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  defaultOrganizationTeam,
  organizationTeamChangedEvent,
  organizationTeamKey,
  parseOrganizationTeam,
  type OrganizationTeamSettings,
} from "@/lib/organization-team";

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === organizationTeamKey) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(organizationTeamChangedEvent, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(organizationTeamChangedEvent, callback);
  };
}

function snapshot() {
  try {
    return window.localStorage.getItem(organizationTeamKey) ?? "";
  } catch {
    return "storage-unavailable";
  }
}

const serverSnapshot = () => null;

export function useOrganizationTeam() {
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [saveError, setSaveError] = useState("");
  const loaded = useMemo(() => {
    let settings = defaultOrganizationTeam;
    let loadError = "";
    if (raw === "storage-unavailable") {
      loadError = "Team settings cannot use browser storage.";
    } else if (raw) {
      try {
        settings = parseOrganizationTeam(raw);
      } catch {
        loadError =
          "Saved team settings could not be loaded. Your next change will replace the local copy.";
      }
    }
    return { settings, loadError };
  }, [raw]);

  function save(settings: OrganizationTeamSettings) {
    try {
      window.localStorage.setItem(
        organizationTeamKey,
        JSON.stringify(settings),
      );
      window.dispatchEvent(new Event(organizationTeamChangedEvent));
      setSaveError("");
      return true;
    } catch {
      setSaveError("Could not save team settings in this browser.");
      return false;
    }
  }

  return {
    ready: raw !== null,
    settings: loaded.settings,
    storageError: saveError || loaded.loadError,
    clearStorageError: () => setSaveError(""),
    save,
  };
}
