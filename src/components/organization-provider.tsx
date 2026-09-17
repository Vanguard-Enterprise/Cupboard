"use client";

import { organizationPreviewStorage } from "@/lib/organization-preview-storage";
import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  defaultOrganizationProfile,
  parseProfile,
  validateProfile,
  type OrganizationProfile,
} from "@/lib/organization-profile";

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === organizationPreviewStorage.profile.key)
      callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(
    organizationPreviewStorage.profile.changedEvent,
    callback,
  );
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(
      organizationPreviewStorage.profile.changedEvent,
      callback,
    );
  };
}
function snapshot() {
  try {
    return (
      window.localStorage.getItem(organizationPreviewStorage.profile.key) ?? ""
    );
  } catch {
    return "storage-unavailable";
  }
}
const serverSnapshot = () => null;
const OrganizationContext = createContext<{
  profile: OrganizationProfile;
  ready: boolean;
  storageError: string;
  save: (profile: OrganizationProfile) => void;
} | null>(null);

export function OrganizationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const value = useMemo(() => {
    let profile = defaultOrganizationProfile;
    let storageError = "";
    if (raw) {
      try {
        profile = parseProfile(raw);
      } catch {
        storageError =
          "Saved organization details could not be loaded. Saving will replace the local copy.";
      }
    }
    return {
      profile,
      ready: raw !== null,
      storageError,
      save: (next: OrganizationProfile) => {
        if (Object.keys(validateProfile(next)).length)
          throw new Error("Check the highlighted fields.");
        window.localStorage.setItem(
          organizationPreviewStorage.profile.key,
          JSON.stringify(next),
        );
        window.dispatchEvent(
          new Event(organizationPreviewStorage.profile.changedEvent),
        );
      },
    };
  }, [raw]);
  return (
    <OrganizationContext.Provider value={value}>
      {children}
    </OrganizationContext.Provider>
  );
}
export function useOrganization() {
  const context = useContext(OrganizationContext);
  if (!context) throw new Error("OrganizationProvider is required");
  return context;
}
