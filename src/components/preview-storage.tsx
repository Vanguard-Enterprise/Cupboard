"use client";

import { createContext, useContext, useMemo } from "react";

const PreviewScope = createContext<string | null | undefined>(undefined);

export function previewStorageKey(
  accountId: string,
  organizationId: string,
  base: string,
) {
  return `${base}:account:${encodeURIComponent(accountId)}:organization:${encodeURIComponent(organizationId)}`;
}

export function PreviewStorageProvider({
  accountId,
  organizationId,
  children,
}: {
  accountId: string;
  organizationId: string | null;
  children: React.ReactNode;
}) {
  const scope = organizationId
    ? JSON.stringify([accountId, organizationId])
    : null;
  return (
    <PreviewScope.Provider
      key={JSON.stringify([accountId, organizationId])}
      value={scope}
    >
      {children}
    </PreviewScope.Provider>
  );
}

export function usePreviewStorage(
  base: string,
  eventName: string,
  empty: string | null = "",
) {
  const scope = useContext(PreviewScope);
  if (scope === undefined)
    throw new Error("PreviewStorageProvider is required");
  return useMemo(() => {
    const ids: [string, string] | null = scope ? JSON.parse(scope) : null;
    const key = ids ? previewStorageKey(ids[0], ids[1], base) : null;
    return {
      snapshot() {
        if (!key) return empty;
        try {
          return window.localStorage.getItem(key) ?? empty;
        } catch {
          return "storage-unavailable";
        }
      },
      subscribe(callback: () => void) {
        const onStorage = (event: StorageEvent) => {
          if (key && (!event.key || event.key === key)) callback();
        };
        const onSaved = (event: Event) => {
          if (key && event instanceof CustomEvent && event.detail === key)
            callback();
        };
        window.addEventListener("storage", onStorage);
        window.addEventListener(eventName, onSaved);
        return () => {
          window.removeEventListener("storage", onStorage);
          window.removeEventListener(eventName, onSaved);
        };
      },
      notify() {
        if (key)
          window.dispatchEvent(new CustomEvent(eventName, { detail: key }));
      },
      set(value: string) {
        if (!key) throw new Error("An organization is required");
        window.localStorage.setItem(key, value);
        window.dispatchEvent(new CustomEvent(eventName, { detail: key }));
      },
      remove() {
        if (!key) throw new Error("An organization is required");
        window.localStorage.removeItem(key);
        window.dispatchEvent(new CustomEvent(eventName, { detail: key }));
      },
    };
  }, [scope, base, eventName, empty]);
}
