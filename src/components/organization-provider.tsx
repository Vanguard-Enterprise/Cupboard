"use client";

import { usePreviewStorage } from "./preview-storage";

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
  const storage = usePreviewStorage(
    organizationProfileKey,
    "cupboard-profile-saved",
  );
  const { subscribe: subscribe, snapshot: snapshot } = storage;
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
        storage.set(JSON.stringify(next));
      },
    };
  }, [raw, storage]);
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
