"use client";

import { useEffect, useRef, useState } from "react";
import {
  DownloadIcon,
  FileIcon,
  Trash2Icon,
  UploadIcon,
  SearchIcon,
  ListIcon,
  LayoutGridIcon,
  MoreVerticalIcon,
  XIcon,
  RefreshCwIcon,
  ChevronDownIcon,
  CheckIcon,
  InfoIcon,
  FileTextIcon,
  FileCodeIcon,
  FileArchiveIcon,
  ImageIcon,
  MusicIcon,
  FilmIcon,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

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
function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name.slice(dot + 1).toLowerCase()
    : "";
}
function fileIcon(name: string) {
  const ext = extension(name);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext))
    return ImageIcon;
  if (["zip", "gz", "tar", "7z", "rar"].includes(ext)) return FileArchiveIcon;
  if (
    ["json", "cfg", "toml", "yaml", "yml", "xml", "cs", "js", "ts"].includes(
      ext,
    )
  )
    return FileCodeIcon;
  if (["txt", "md", "pdf", "csv", "doc", "docx"].includes(ext))
    return FileTextIcon;
  if (["mp3", "wav", "ogg", "flac"].includes(ext)) return MusicIcon;
  if (["mp4", "webm", "mov"].includes(ext)) return FilmIcon;
  return FileIcon;
}
const sorts = {
  newest: "Newest first",
  oldest: "Oldest first",
  name: "Name A–Z",
  size: "Largest first",
};
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
  const [view, setView] = useState("list");
  const [type, setType] = useState("all");
  const [sort, setSort] = useState<keyof typeof sorts>("newest");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [details, setDetails] = useState<StoredFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const uploadTrigger = useRef<HTMLButtonElement>(null);
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
      choose.current?.focus();
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
      setUploadOpen(false);
      setActiveId(result.id);
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
      setActiveId(null);
      search.current?.focus();
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
  const visible = files
    ?.filter(
      (file) =>
        file.name.toLowerCase().includes(query.toLowerCase()) &&
        (type === "all" || (extension(file.name) || "none") === type),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "size"
          ? b.size - a.size
          : sort === "oldest"
            ? a.createdAt - b.createdAt
            : b.createdAt - a.createdAt,
    );
  const active = visible?.find((file) => file.id === activeId);
  const extensions = [
    ...new Set(files?.map((file) => extension(file.name) || "none") ?? []),
  ].sort();
  const disabled = busy || refreshing;
  function select(file: StoredFile) {
    setActiveId(activeId === file.id ? null : file.id);
  }
  function askDelete(file: StoredFile) {
    setRemoving(file);
    setDeleteError("");
  }
  function closeUpload() {
    setUploadOpen(false);
    setSelected(null);
    setUploadError("");
    setDragging(false);
  }
  function openUpload() {
    setUploadError("");
    setUploadOpen(true);
  }
  function actions(file: StoredFile) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 md:size-8"
            disabled={disabled}
            aria-label={`Actions for ${file.name}`}
          >
            <MoreVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            className="min-h-11 md:min-h-8"
            onSelect={() => download(file)}
          >
            <DownloadIcon />
            Download
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11 md:min-h-8"
            onSelect={() => setDetails(file)}
          >
            <InfoIcon />
            File details
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="min-h-11 md:min-h-8"
            variant="destructive"
            onSelect={() => askDelete(file)}
          >
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
          <p className="mt-1 text-sm break-words text-muted-foreground">
            Shared library for {identity.organization?.name}
          </p>
        </div>
        {allowed && (
          <Button
            className="h-11 shrink-0 md:h-10"
            ref={uploadTrigger}
            onClick={openUpload}
            disabled={disabled || files === null}
          >
            <UploadIcon />
            Upload file
          </Button>
        )}
      </div>
      {!allowed ? (
        <Alert>
          <AlertDescription>
            You need organization management permission to access files.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="relative max-w-2xl">
            <SearchIcon className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
            <Label htmlFor="file-search" className="sr-only">
              Search files
            </Label>
            <Input
              ref={search}
              id="file-search"
              className="h-11 bg-input-background pr-10 pl-10"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveId(null);
              }}
              placeholder="Search files"
            />
            {query && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-0 right-0 size-11"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  search.current?.focus();
                }}
              >
                <XIcon />
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="h-11 max-w-40 md:h-9">
                    <span className="truncate">
                      {type === "all"
                        ? "File type"
                        : type === "none"
                          ? "No extension"
                          : `.${type}`}
                    </span>
                    <ChevronDownIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-72 w-44">
                  <DropdownMenuRadioGroup
                    value={type}
                    onValueChange={(value) => {
                      setType(value);
                      setActiveId(null);
                    }}
                  >
                    <DropdownMenuRadioItem
                      className="min-h-11 md:min-h-8"
                      value="all"
                    >
                      All file types
                    </DropdownMenuRadioItem>
                    {extensions.map((ext) => (
                      <DropdownMenuRadioItem
                        className="min-h-11 break-all md:min-h-8"
                        key={ext}
                        value={ext}
                      >
                        {ext === "none" ? "No extension" : `.${ext}`}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-11 md:h-9"
                    aria-label={`Sort files: ${sorts[sort]}`}
                  >
                    {sorts[sort]}
                    <ChevronDownIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-44">
                  <DropdownMenuRadioGroup
                    value={sort}
                    onValueChange={(value) =>
                      setSort(value as keyof typeof sorts)
                    }
                  >
                    {Object.entries(sorts).map(([value, label]) => (
                      <DropdownMenuRadioItem
                        className="min-h-11 md:min-h-8"
                        key={value}
                        value={value}
                      >
                        {label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="size-11 md:size-9"
                disabled={disabled}
                onClick={refresh}
                aria-label={refreshing ? "Refreshing files" : "Refresh"}
                title="Refresh"
              >
                <RefreshCwIcon
                  className={
                    refreshing ? "animate-spin motion-reduce:animate-none" : ""
                  }
                />
              </Button>
              <ToggleGroup
                type="single"
                value={view}
                onValueChange={(value) => {
                  if (value) setView(value);
                }}
                variant="outline"
                spacing={0}
                aria-label="File view"
              >
                <ToggleGroupItem
                  className="size-11 md:size-9"
                  value="list"
                  aria-label="List view"
                  title="List view"
                >
                  <ListIcon />
                </ToggleGroupItem>
                <ToggleGroupItem
                  className="size-11 md:size-9"
                  value="grid"
                  aria-label="Grid view"
                  title="Grid view"
                >
                  <LayoutGridIcon />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
          <div
            className={cn(
              "flex min-h-11 flex-wrap items-center gap-2 rounded-lg px-3 text-sm",
              active
                ? "bg-primary/10 text-foreground"
                : "bg-muted/30 text-muted-foreground",
            )}
          >
            {active ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 md:size-8"
                  aria-label="Clear selection"
                  onClick={() => setActiveId(null)}
                >
                  <XIcon />
                </Button>
                <span className="mr-2">1 selected</span>
                <Button
                  variant="ghost"
                  className="h-11 md:h-8"
                  disabled={disabled}
                  onClick={() => download(active)}
                >
                  <DownloadIcon />
                  Download
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 md:h-8"
                  disabled={disabled}
                  onClick={() => setDetails(active)}
                >
                  <InfoIcon />
                  Details
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 md:size-8"
                  disabled={disabled}
                  aria-label={`Delete ${active.name}`}
                  title="Delete"
                  onClick={() => askDelete(active)}
                >
                  <Trash2Icon />
                </Button>
              </>
            ) : (
              <span>
                {files === null
                  ? "Shared library"
                  : `${visible?.length ?? 0} ${(visible?.length ?? 0) === 1 ? "file" : "files"}${query || type !== "all" ? ` of ${files.length}` : ""}`}
              </span>
            )}
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
            <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
              <div className="mb-4 rounded-xl bg-muted/40 p-4">
                <FileIcon className="size-8 text-muted-foreground" />
              </div>
              <h2 className="font-medium">
                {files.length ? "No matching files" : "Your files, together"}
              </h2>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                {files.length
                  ? "Try another filename or clear your filters."
                  : "Upload configs, plugins, and other files to share with your organization managers."}
              </p>
              {files.length ? (
                <Button
                  variant="outline"
                  className="mt-5 h-11"
                  onClick={() => {
                    setQuery("");
                    setType("all");
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <p className="mt-4 text-xs text-muted-foreground">
                  Use Upload file to get started. Up to 10 MiB per file.
                </p>
              )}
            </div>
          ) : view === "list" ? (
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">Files</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="pb-3 pl-3 font-medium">
                    Name
                  </th>
                  <th
                    scope="col"
                    className="hidden w-36 pb-3 font-medium md:table-cell"
                  >
                    Uploaded
                  </th>
                  <th
                    scope="col"
                    className="hidden w-24 pb-3 font-medium sm:table-cell"
                  >
                    Size
                  </th>
                  <th scope="col" className="w-14 pb-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible?.map((file) => {
                  const Icon = fileIcon(file.name);
                  return (
                    <tr
                      key={file.id}
                      className={cn(
                        "border-b border-border/60 transition-colors hover:bg-muted/40",
                        active?.id === file.id &&
                          "bg-primary/10 hover:bg-primary/15",
                      )}
                    >
                      <td className="p-0">
                        <button
                          type="button"
                          aria-pressed={active?.id === file.id}
                          onClick={() => select(file)}
                          className="flex min-h-14 w-full items-center gap-3 rounded-md px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          title={file.name}
                        >
                          <Icon className="size-5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {file.name}
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground sm:hidden">
                              {sizeLabel(file.size)} ·{" "}
                              {new Date(
                                file.createdAt * 1000,
                              ).toLocaleDateString()}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="hidden text-muted-foreground md:table-cell">
                        {new Date(file.createdAt * 1000).toLocaleDateString()}
                      </td>
                      <td className="hidden text-muted-foreground tabular-nums sm:table-cell">
                        {sizeLabel(file.size)}
                      </td>
                      <td className="text-right">{actions(file)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <ul
              className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              aria-label="Files"
            >
              {visible?.map((file) => {
                const Icon = fileIcon(file.name);
                return (
                  <li
                    key={file.id}
                    className={cn(
                      "overflow-hidden rounded-xl border bg-card transition-colors hover:border-border-strong",
                      active?.id === file.id && "border-primary bg-primary/10",
                    )}
                  >
                    <div className="flex items-center gap-2 px-3 pt-2">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span
                        className="min-w-0 flex-1 truncate text-sm font-medium"
                        title={file.name}
                      >
                        {file.name}
                      </span>
                      {actions(file)}
                    </div>
                    <button
                      type="button"
                      aria-label={`Select ${file.name}`}
                      aria-pressed={active?.id === file.id}
                      onClick={() => select(file)}
                      className="group w-full px-3 pb-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <div className="relative my-2 flex h-36 items-center justify-center rounded-lg bg-background/60">
                        <Icon className="size-14 text-muted-foreground/60" />
                        {active?.id === file.id && (
                          <CheckIcon className="absolute top-3 right-3 size-5 text-primary" />
                        )}
                      </div>
                      <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>{sizeLabel(file.size)}</span>
                        <span>
                          {new Date(file.createdAt * 1000).toLocaleDateString()}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <Dialog
            open={uploadOpen}
            onOpenChange={(open) => {
              if (!busy) {
                if (open) setUploadOpen(true);
                else closeUpload();
              }
            }}
          >
            <DialogContent
              showCloseButton={!busy}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                uploadTrigger.current?.focus();
              }}
            >
              <DialogHeader>
                <DialogTitle>Upload file</DialogTitle>
                <DialogDescription>
                  Add a file to {identity.organization?.name}. Organization
                  managers can download it.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={upload} className="space-y-4">
                <div
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!busy) setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    if (busy) return;
                    if (event.dataTransfer.files.length !== 1) {
                      setSelected(null);
                      setUploadError("Choose one file at a time.");
                      return;
                    }
                    setSelected(event.dataTransfer.files[0]);
                    setUploadError("");
                  }}
                  className={cn(
                    "rounded-xl border border-dashed p-6 text-center",
                    dragging ? "border-primary bg-primary/10" : "bg-muted/20",
                  )}
                >
                  <UploadIcon className="mx-auto mb-3 size-7 text-muted-foreground" />
                  <p className="text-sm font-medium">Drop a file here</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    or choose a file from your device
                  </p>
                  <Label htmlFor="file-upload" className="sr-only">
                    Upload a file
                  </Label>
                  <Input
                    ref={input}
                    id="file-upload"
                    type="file"
                    tabIndex={-1}
                    disabled={busy}
                    className="sr-only"
                    aria-describedby="file-help file-upload-error"
                    onChange={(event) => {
                      setSelected(event.target.files?.[0] ?? null);
                      setUploadError("");
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4 h-11"
                    disabled={busy}
                    ref={choose}
                    onClick={() => input.current?.click()}
                  >
                    Choose file
                  </Button>
                </div>
                {selected && (
                  <div className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                    <FileIcon className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="break-all font-medium">{selected.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {sizeLabel(selected.size)}
                      </p>
                    </div>
                  </div>
                )}
                <p id="file-help" className="text-xs text-muted-foreground">
                  Up to 10 MiB per file. Uploading the same filename creates
                  another file.
                </p>
                {uploadError && (
                  <p
                    id="file-upload-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {uploadError}
                  </p>
                )}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={closeUpload}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={!selected || disabled || files === null}
                  >
                    {uploading ? "Uploading..." : "Upload file"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          <Dialog
            open={details !== null}
            onOpenChange={(open) => {
              if (!open) setDetails(null);
            }}
          >
            <DialogContent
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                search.current?.focus();
              }}
            >
              <DialogHeader>
                <DialogTitle>File details</DialogTitle>
                <DialogDescription className="break-all">
                  {details?.name}
                </DialogDescription>
              </DialogHeader>
              {details && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-4 text-sm">
                  <dt className="text-muted-foreground">Size</dt>
                  <dd>{sizeLabel(details.size)}</dd>
                  <dt className="text-muted-foreground">Uploaded</dt>
                  <dd>{new Date(details.createdAt * 1000).toLocaleString()}</dd>
                  <dt className="text-muted-foreground">Access</dt>
                  <dd>Organization managers</dd>
                </dl>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setDetails(null)}>
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog
            open={removing !== null}
            onOpenChange={(open) => {
              if (!open && !busy) setRemoving(null);
            }}
          >
            <DialogContent
              showCloseButton={!busy}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                search.current?.focus();
              }}
            >
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
