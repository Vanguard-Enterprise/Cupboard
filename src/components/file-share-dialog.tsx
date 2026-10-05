"use client";

import { useEffect, useState } from "react";
import type { StoredFile } from "./file-library";
import { fileRequest } from "@/lib/file-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

export function FileShareDialog({
  file,
  organization,
  onClose,
}: {
  file: StoredFile;
  organization: string;
  onClose: () => void;
}) {
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [publicLink, setPublicLink] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let active = true;
    fileRequest<{ expiresAt: number | null }>(
      `files/${file.id}/share`,
      organization,
    )
      .then((result) => {
        if (active) {
          setExpiresAt(result.expiresAt);
          setLoaded(true);
          setOrigin(window.location.origin);
        }
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Sharing could not be loaded.",
          );
      });
    return () => {
      active = false;
    };
  }, [file.id, organization]);
  const organizationLink = origin
    ? `${origin}/dashboard/files?organization=${encodeURIComponent(organization)}&file=${encodeURIComponent(file.id)}`
    : "";
  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(link);
    } catch {
      setError("Select the link and copy it with your browser's Copy command.");
    }
  }
  async function publicAction(revoke: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    setCopied("");
    try {
      if (revoke) {
        await fileRequest(`files/${file.id}/share/revoke`, organization, {});
        setExpiresAt(null);
        setPublicLink("");
      } else {
        const result = await fileRequest<{ token: string; expiresAt: number }>(
          `files/${file.id}/share`,
          organization,
          { days: Number(days) },
        );
        setExpiresAt(result.expiresAt);
        setPublicLink(`${window.location.origin}/share/file#${result.token}`);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Sharing could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }
  function linkField(id: string, label: string, value: string) {
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex gap-2">
          <Input
            className="h-11 md:h-9"
            id={id}
            value={value}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <Button
            variant="outline"
            className="h-11 md:h-9"
            disabled={!value}
            onClick={() => copyLink(value)}
          >
            {copied === value ? "Copied" : "Copy link"}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[90dvh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          <DialogDescription className="break-all">
            {file.name}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {linkField(
            "organization-link",
            "Organization link",
            organizationLink,
          )}
          <p className="text-sm text-muted-foreground">
            Only signed-in members with file access in this organization can
            open this link.
          </p>
        </div>
        {!file.isFolder && (
          <div className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium">Public download link</h3>
            <p className="text-sm text-muted-foreground">
              Anyone with this link can download this file until it expires or
              you revoke it. Replacing a link disables the previous link.
            </p>
            {expiresAt && (
              <p className="text-sm">
                Expires {new Date(expiresAt * 1000).toLocaleString()}
              </p>
            )}
            {publicLink && linkField("public-link", "Public link", publicLink)}
            <div className="space-y-2">
              <Label htmlFor="share-expiry">Expires after</Label>
              <Select value={days} onValueChange={setDays} disabled={busy}>
                <SelectTrigger id="share-expiry" className="h-11 md:h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 day</SelectItem>
                  <SelectItem value="7">7 days</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="h-11 md:h-9"
                disabled={busy || !loaded}
                onClick={() => publicAction(false)}
              >
                {busy
                  ? "Saving..."
                  : expiresAt
                    ? "Replace public link"
                    : "Create public link"}
              </Button>
              {expiresAt && (
                <Button
                  variant="destructive"
                  className="h-11 md:h-9"
                  disabled={busy}
                  onClick={() => publicAction(true)}
                >
                  Revoke link
                </Button>
              )}
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
