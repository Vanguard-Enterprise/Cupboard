"use client";

import { organizationPreviewStorage } from "@/lib/organization-preview-storage";
import { createRawPreviewStore } from "@/lib/browser-preview-store";
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

const profileStore = createRawPreviewStore(organizationPreviewStorage.profile);

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
  const raw = useSyncExternalStore(
    profileStore.subscribe,
    profileStore.getSnapshot,
    profileStore.getServerSnapshot,
  );
  const value = useMemo(() => {
    let profile = defaultOrganizationProfile;
    let status: "defaults" | "loaded" | "unreadable" | "unavailable" =
      "defaults";
    if (raw.status === "unavailable") status = "unavailable";
    else if (raw.status === "available" && raw.raw) {
      try {
        profile = parseProfile(raw.raw);
        status = "loaded";
      } catch {
        status = "unreadable";
      }
    }
    const storageError =
      status === "unreadable" || status === "unavailable"
        ? "Saved organization details could not be loaded. Saving will replace the local copy."
        : "";
    return {
      profile,
      ready: raw.status !== "not-ready",
      storageError,
      save: (next: OrganizationProfile) => {
        if (Object.keys(validateProfile(next)).length)
          throw new Error("Check the highlighted fields.");
        profileStore.write(JSON.stringify(next));
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
