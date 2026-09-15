"use client";

import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  defaultOrganizationProfile,
  organizationProfileKey,
  parseProfile,
  validateProfile,
  type OrganizationProfile,
} from "@/lib/organization-profile";

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === organizationProfileKey) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("cupboard-profile-saved", callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("cupboard-profile-saved", callback);
  };
}
function snapshot() {
  try {
    return window.localStorage.getItem(organizationProfileKey) ?? "";
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
          organizationProfileKey,
          JSON.stringify(next),
        );
        window.dispatchEvent(new Event("cupboard-profile-saved"));
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
