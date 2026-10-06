"use client";

import { useCallback, useEffect, useState } from "react";
import { fileRequest } from "@/lib/file-client";

type Logo = { id: string | null; revision: number };
export function useOrganizationLogo(organizationId: string, live = false) {
  const [saved, setSaved] = useState<Logo | null>(null);
  const [selection, setSelection] = useState<File | null | undefined>();
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [validPreview, setValidPreview] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setSaved(await fileRequest<Logo>("organization-logo", organizationId));
      setError("");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not load the logo.",
      );
    } finally {
      setLoading(false);
    }
  }, [organizationId]);
  useEffect(() => {
    // The profile is keyed by organization, so requests cannot update another organization's editor.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!live) return;
    const refresh = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail === organizationId)
        void reload();
    };
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("cupboard-logo")
        : null;
    if (channel)
      channel.onmessage = (event) => {
        if (event.data === organizationId) void reload();
      };
    window.addEventListener("cupboard-logo-saved", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("cupboard-logo-saved", refresh);
      window.removeEventListener("focus", refresh);
      channel?.close();
    };
  }, [live, organizationId, reload]);
  useEffect(() => {
    let url = "";
    let canceled = false;
    const controller = new AbortController();
    async function load() {
      setPreview("");
      setValidPreview(false);
      setProcessing(Boolean(selection));
      try {
        if (selection) {
          const response = await fetch("/app-api/organization-logo/preview", {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Cupboard-Request": "1",
              "X-Cupboard-Organization": organizationId,
            },
            body: selection,
            signal: controller.signal,
          });
          if (!response.ok) {
            const result = await response.json();
            throw new Error(result.error || "Could not prepare the logo.");
          }
          const blob = await response.blob();
          if (canceled) return;
          url = URL.createObjectURL(blob);
          setValidPreview(true);
        } else if (selection === undefined && saved?.id) {
          const response = await fetch(
            `/app-api/organization-logo/${saved.id}`,
            {
              headers: { "X-Cupboard-Organization": organizationId },
              cache: "no-store",
              signal: controller.signal,
            },
          );
          if (!response.ok)
            throw new Error("The saved logo could not be displayed.");
          const blob = await response.blob();
          if (canceled) return;
          url = URL.createObjectURL(blob);
        }
        if (!canceled) setPreview(url);
      } catch (error) {
        if (!canceled)
          setError(
            error instanceof Error
              ? error.message
              : "Could not display the logo.",
          );
      } finally {
        if (!canceled) setProcessing(false);
      }
    }
    void load();
    return () => {
      canceled = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [selection, saved, organizationId]);
  function select(file: File | null) {
    if (file && (file.size > 2 * 1024 * 1024 || file.size === 0)) {
      setSelection(undefined);
      setValidPreview(false);
      setError("Choose an image no larger than 2 MiB.");
      return false;
    }
    setValidPreview(file === null);
    setSelection(file);
    setError("");
    return true;
  }
  async function save() {
    if (selection === undefined) return;
    if (selection && !validPreview)
      throw new Error("Wait for a valid logo preview before saving.");
    if (!saved) throw new Error("Load the saved logo before making changes.");
    setSaving(true);
    try {
      let next: Logo;
      if (selection === null)
        next = await fileRequest<Logo>(
          "organization-logo/remove",
          organizationId,
          { revision: saved.revision },
        );
      else {
        const response = await fetch("/app-api/organization-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Cupboard-Request": "1",
            "X-Cupboard-Organization": organizationId,
            "X-Cupboard-Logo-Revision": String(saved.revision),
          },
          body: selection,
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error || "Could not save the logo. Try again.",
          );
        next = result;
      }
      setSaved(next);
      window.dispatchEvent(
        new CustomEvent("cupboard-logo-saved", { detail: organizationId }),
      );
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("cupboard-logo");
        channel.postMessage(organizationId);
        channel.close();
      }
      setSelection(undefined);
      setError("");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not save the logo. Try again.";
      setError(message);
      throw new Error(message);
    } finally {
      setSaving(false);
    }
  }
  return {
    preview,
    error,
    loading,
    saving,
    processing,
    validPreview: selection === null || validPreview,
    ready: saved !== null,
    dirty: selection !== undefined,
    hasLogo: selection === undefined ? Boolean(saved?.id) : Boolean(selection),
    select,
    save,
    reload,
    cancel() {
      setSelection(undefined);
      void reload();
    },
  };
}
