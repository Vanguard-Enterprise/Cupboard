"use client";

import { useEffect, useRef, useState } from "react";
import { DownloadIcon, FileIcon, Trash2Icon } from "lucide-react";
import { type Identity } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type StoredFile = { id: string; name: string; size: number; createdAt: number };
const maxSize = 10 * 1024 * 1024;
function sizeLabel(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
async function fileRequest<T>(
  path: string,
  organization: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/app-api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: {
      "X-Cupboard-Organization": organization,
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Cupboard-Request": "1" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "The file request failed. Try again.");
  return result;
}
export function FileLibrary({ identity }: { identity: Identity }) {
  const organization = identity.organization?.id ?? "";
  const allowed = identity.permissions.includes("organization.manage");
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [error, setError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [selected, setSelected] = useState<File | null>(null);
  const [removing, setRemoving] = useState<StoredFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!allowed) return;
    let active = true;
    fileRequest<StoredFile[]>("files", organization)
      .then((result) => {
        if (active) {
          setFiles(result);
          setLoadedAt(new Date());
        }
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [allowed, organization]);
  async function refresh() {
    setRefreshing(true);
    try {
      setFiles(await fileRequest<StoredFile[]>("files", organization));
      setLoadedAt(new Date());
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Files could not be loaded.",
      );
    } finally {
      setRefreshing(false);
    }
  }
  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || busy || refreshing || files === null) return;
    if (selected.size > maxSize) {
      setUploadError("Choose a file no larger than 10 MiB.");
      input.current?.focus();
      return;
    }
    setBusy(true);
    setUploading(true);
    setUploadError("");
    try {
      const response = await fetch("/app-api/files", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Cupboard-Request": "1",
          "X-Cupboard-Filename": encodeURIComponent(selected.name),
          "X-Cupboard-Organization": organization,
        },
        body: selected,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Upload failed. Try again.");
      setFiles((previous) => [result, ...(previous ?? [])]);
      setSelected(null);
      if (input.current) input.current.value = "";
      toast.success(`${result.name} uploaded.`);
    } catch (cause) {
      setUploadError(
        cause instanceof Error ? cause.message : "Upload failed. Try again.",
      );
    } finally {
      setBusy(false);
      setUploading(false);
    }
  }
  async function remove() {
    if (!removing || busy) return;
    setBusy(true);
    setDeleteError("");
    try {
      await fileRequest(`files/${removing.id}/delete`, organization, {});
      setFiles(
        (previous) => previous?.filter((file) => file.id !== removing.id) ?? [],
      );
      toast.success(`${removing.name} deleted.`);
      setRemoving(null);
    } catch (cause) {
      setDeleteError(
        cause instanceof Error ? cause.message : "Deletion failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function download(file: StoredFile) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/app-api/files/${file.id}`, {
        cache: "no-store",
        headers: { "X-Cupboard-Organization": organization },
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "Download failed. Try again.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
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
  const visible = files?.filter((file) =>
    file.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Shared files for {identity.organization?.name}.
        </p>
      </div>
      {!allowed ? (
        <Alert>
          <AlertDescription>
            You need organization management permission to access files.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <form onSubmit={upload} className="rounded-xl border bg-card p-4">
            <Label htmlFor="file-upload">Upload a file</Label>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
              <Input
                ref={input}
                id="file-upload"
                type="file"
                disabled={busy}
                aria-describedby="file-help file-upload-error"
                onChange={(event) => {
                  setSelected(event.target.files?.[0] ?? null);
                  setUploadError("");
                }}
                className="max-w-lg"
              />
              <Button
                type="submit"
                disabled={!selected || busy || refreshing || files === null}
              >
                {uploading ? "Uploading..." : "Upload file"}
              </Button>
            </div>
            <p id="file-help" className="mt-2 text-xs text-muted-foreground">
              Up to 10 MiB per file. Only organization managers can access these
              files.
            </p>
            <p
              id="file-upload-error"
              role={uploadError ? "alert" : undefined}
              className="mt-2 text-sm text-destructive"
            >
              {uploadError}
            </p>
          </form>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="w-full sm:max-w-sm">
              <Label htmlFor="file-search" className="sr-only">
                Search files
              </Label>
              <Input
                id="file-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search files..."
              />
            </div>
            <Button
              variant="outline"
              disabled={busy || refreshing}
              onClick={refresh}
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {error}
                {loadedAt && ` Last loaded ${loadedAt.toLocaleTimeString()}.`}
              </AlertDescription>
            </Alert>
          )}
          {files === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              {error
                ? "Files could not be loaded. Use Refresh to try again."
                : "Loading files..."}
            </p>
          ) : visible?.length === 0 ? (
            <div className="rounded-xl border border-dashed p-10 text-center">
              <FileIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
              <h2 className="font-medium">
                {files.length ? "No matching files" : "No files yet"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {files.length
                  ? "Try another filename."
                  : "Upload a file to add it to this organization's library."}
              </p>
            </div>
          ) : (
            <ul
              className="divide-y rounded-xl border bg-card"
              aria-label="Files"
            >
              {visible?.map((file) => (
                <li
                  key={file.id}
                  className="flex flex-wrap items-center gap-3 p-4"
                >
                  <FileIcon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="break-all text-sm font-medium">{file.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {sizeLabel(file.size)} ·{" "}
                      {new Date(file.createdAt * 1000).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || refreshing}
                      aria-label={`Download ${file.name}`}
                      onClick={() => download(file)}
                    >
                      <DownloadIcon />
                      Download
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy || refreshing}
                      aria-label={`Delete ${file.name}`}
                      onClick={() => {
                        setRemoving(file);
                        setDeleteError("");
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Dialog
            open={removing !== null}
            onOpenChange={(open) => {
              if (!open && !busy) setRemoving(null);
            }}
          >
            <DialogContent showCloseButton={!busy}>
              <DialogHeader>
                <DialogTitle>Delete file?</DialogTitle>
                <DialogDescription className="break-all">
                  Delete {removing?.name} from this organization. This cannot be
                  undone.
                </DialogDescription>
              </DialogHeader>
              {deleteError && (
                <p role="alert" className="text-sm text-destructive">
                  {deleteError}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setRemoving(null)}
                >
                  Cancel
                </Button>
                <Button variant="destructive" disabled={busy} onClick={remove}>
                  {busy ? "Deleting..." : "Delete file"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
