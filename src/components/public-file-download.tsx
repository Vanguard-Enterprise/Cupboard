"use client";
import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
export function PublicFileDownload() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/app-api/public-files/download", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Cupboard-Request": "1",
        },
        body: JSON.stringify({ token: window.location.hash.slice(1) }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "This link is no longer available.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      const encoded = response.headers
        .get("content-disposition")
        ?.match(/filename\*=UTF-8''([^;]+)/)?.[1];
      link.download = encoded ? decodeURIComponent(encoded) : "download";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Download failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <section className="w-full max-w-md space-y-5 rounded-xl border bg-card p-6">
        <h1 className="text-2xl font-semibold">Shared file</h1>
        <p className="text-sm text-muted-foreground">
          Download the file shared with you through Cupboard.
        </p>
        <Button className="h-11" disabled={busy} onClick={download}>
          <DownloadIcon />
          {busy ? "Downloading..." : "Download file"}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
