"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  SlidersHorizontalIcon,
  CheckIcon,
  InfoIcon,
  FileTextIcon,
  FileCodeIcon,
  FileArchiveIcon,
  ImageIcon,
  MusicIcon,
  FilmIcon,
  FolderIcon,
  FolderPlusIcon,
  CopyIcon,
  ScissorsIcon,
  ClipboardPasteIcon,
  PencilIcon,
  Share2Icon,
  ChevronRightIcon,
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { fileRequest } from "@/lib/file-client";
import { FileShareDialog } from "@/components/file-share-dialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { FileThumbnail } from "@/components/file-thumbnail";

function subscribeView(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("cupboard-file-view", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("cupboard-file-view", callback);
  };
}

export type StoredFile = {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  parentId?: string | null;
  isFolder?: boolean;
};
const maxSize = 10 * 1024 * 1024;
function sizeLabel(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(1)} MiB`;
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
  const [syncError, setSyncError] = useState("");
  const syncVersion = useRef(0);
  const [folder, setFolder] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{
    file: StoredFile;
    mode: "copy" | "cut";
  } | null>(null);
  const [contextFile, setContextFile] = useState<StoredFile | null>(null);
  const [naming, setNaming] = useState<{ file?: StoredFile } | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [sharing, setSharing] = useState<StoredFile | null>(null);
  const [query, setQuery] = useState("");
  const viewKey = `cupboard:files:view:${identity.user.id}:${organization}`;
  const [memoryView, setMemoryView] = useState("list");
  const view = useSyncExternalStore(
    subscribeView,
    () => {
      try {
        return localStorage.getItem(viewKey) === "grid" ? "grid" : "list";
      } catch {
        return memoryView;
      }
    },
    () => "list",
  );
  function setView(value: string) {
    setMemoryView(value);
    try {
      localStorage.setItem(viewKey, value);
      window.dispatchEvent(new Event("cupboard-file-view"));
    } catch {
      // The view still switches when browser storage is unavailable.
    }
  }
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
          const params = new URLSearchParams(window.location.search);
          if (params.has("file")) {
            const linked = result.find(
              (file) => file.id === params.get("file"),
            );
            if (params.get("organization") !== organization || !linked) {
              setError(
                "This link is not available in the active organization. Switch organizations and open the link again.",
              );
            } else {
              setFolder(
                linked.isFolder ? linked.id : (linked.parentId ?? null),
              );
              setActiveId(linked.isFolder ? null : linked.id);
              setDetails(linked);
            }
          }
          setLoadedAt(new Date());
        }
      })
      .catch((cause: Error) => {
        if (active) setSyncError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [allowed, organization]);
  useEffect(() => {
    if (!allowed || busy) return;
    let active = true;
    let pending = false;
    async function update() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      const version = syncVersion.current;
      try {
        const result = await fileRequest<StoredFile[]>("files", organization);
        if (!active || version !== syncVersion.current) return;
        setFiles(result);
        setFolder((current) =>
          current && !result.some((file) => file.id === current)
            ? null
            : current,
        );
        setDetails((current) =>
          current
            ? (result.find((file) => file.id === current.id) ?? null)
            : null,
        );
        setLoadedAt(new Date());
        setSyncError("");
      } catch (cause) {
        if (active && version === syncVersion.current)
          setSyncError(
            cause instanceof Error
              ? cause.message
              : "File updates failed. Retrying automatically.",
          );
      } finally {
        pending = false;
      }
    }
    const timer = window.setInterval(update, 15000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [allowed, organization, busy]);
  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || busy || files === null) return;
    if (selected.size > maxSize) {
      setUploadError("Choose a file no larger than 10 MiB.");
      choose.current?.focus();
      return;
    }
    syncVersion.current += 1;
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
          ...(folder ? { "X-Cupboard-Folder": folder } : {}),
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
    syncVersion.current += 1;
    setBusy(true);
    setDeleteError("");
    try {
      await fileRequest(`files/${removing.id}/delete`, organization, {});
      const removed = new Set([removing.id]);
      let count = 0;
      while (count !== removed.size) {
        count = removed.size;
        files?.forEach((file) => {
          if (file.parentId && removed.has(file.parentId)) removed.add(file.id);
        });
      }
      setFiles(
        (previous) => previous?.filter((file) => !removed.has(file.id)) ?? [],
      );
      if (clipboard && removed.has(clipboard.file.id)) setClipboard(null);
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
    syncVersion.current += 1;
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
        (file.parentId ?? null) === folder &&
        file.name.toLowerCase().includes(query.toLowerCase()) &&
        (type === "all" ||
          (!file.isFolder && (extension(file.name) || "none") === type)),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.isFolder)) - Number(Boolean(a.isFolder)) ||
        (sort === "name"
          ? a.name.localeCompare(b.name)
          : sort === "size"
            ? b.size - a.size
            : sort === "oldest"
              ? a.createdAt - b.createdAt
              : b.createdAt - a.createdAt),
    );
  const active = visible?.find((file) => file.id === activeId);
  const extensions = [
    ...new Set(files?.map((file) => extension(file.name) || "none") ?? []),
  ].sort();
  const disabled = busy;
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
  function openFolder(id: string | null) {
    setFolder(id);
    setActiveId(null);
    setQuery("");
    setType("all");
  }
  function startName(file?: StoredFile) {
    setName(file?.name ?? "");
    setNameError("");
    setNaming({ file });
  }
  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    if (!naming || busy) return;
    syncVersion.current += 1;
    setBusy(true);
    setNameError("");
    try {
      const result = await fileRequest<StoredFile | StoredFile[]>(
        naming.file ? `files/${naming.file.id}/rename` : "files/folders",
        organization,
        naming.file ? { name } : { name, parentId: folder },
      );
      const entries = Array.isArray(result) ? result : [result];
      setFiles((previous) => [
        ...entries,
        ...(previous ?? []).filter(
          (file) => !entries.some((entry) => entry.id === file.id),
        ),
      ]);
      setNaming(null);
      setActiveId(entries[0]?.id ?? null);
      toast.success(naming.file ? "Renamed." : "Folder created.");
    } catch (cause) {
      setNameError(
        cause instanceof Error ? cause.message : "Could not save. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function copy(file: StoredFile, mode: "copy" | "cut") {
    setClipboard({ file, mode });
    toast.success(
      `${file.name} ready to ${mode === "cut" ? "move" : "copy"}. Open a folder and paste.`,
    );
  }
  async function paste(destination = folder) {
    if (!clipboard || busy) return;
    syncVersion.current += 1;
    setBusy(true);
    setError("");
    try {
      const result = await fileRequest<StoredFile | StoredFile[]>(
        `files/${clipboard.file.id}/${clipboard.mode === "cut" ? "move" : "copy"}`,
        organization,
        { parentId: destination },
      );
      const updated = Array.isArray(result) ? result : [result];
      setFiles((previous) => [
        ...updated,
        ...(previous ?? []).filter(
          (file) => !updated.some((item) => item.id === file.id),
        ),
      ]);
      if (clipboard.mode === "cut") setClipboard(null);
      toast.success(clipboard.mode === "cut" ? "Moved." : "Copied.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Paste failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function menuItems(file: StoredFile | null, context = false) {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
    const itemProps = { className: "min-h-11 md:min-h-8", disabled };
    return file ? (
      <>
        {file.isFolder ? (
          <Item {...itemProps} onSelect={() => openFolder(file.id)}>
            <FolderIcon />
            Open folder
          </Item>
        ) : (
          <Item {...itemProps} onSelect={() => download(file)}>
            <DownloadIcon />
            Download
          </Item>
        )}
        <Separator />
        <Item {...itemProps} onSelect={() => copy(file, "copy")}>
          <CopyIcon />
          Copy
        </Item>
        <Item {...itemProps} onSelect={() => copy(file, "cut")}>
          <ScissorsIcon />
          Cut
        </Item>
        {file.isFolder && (
          <Item
            {...itemProps}
            disabled={disabled || !clipboard}
            onSelect={() => paste(file.id)}
          >
            <ClipboardPasteIcon />
            Paste into folder
          </Item>
        )}
        <Item {...itemProps} onSelect={() => startName(file)}>
          <PencilIcon />
          Rename
        </Item>
        <Separator />
        <Item {...itemProps} onSelect={() => setSharing(file)}>
          <Share2Icon />
          Share
        </Item>
        <Item {...itemProps} onSelect={() => setDetails(file)}>
          <InfoIcon />
          File details
        </Item>
        <Separator />
        <Item
          {...itemProps}
          variant="destructive"
          onSelect={() => askDelete(file)}
        >
          <Trash2Icon />
          Delete
        </Item>
      </>
    ) : (
      <>
        <Item {...itemProps} onSelect={() => startName()}>
          <FolderPlusIcon />
          New folder
        </Item>
        <Item {...itemProps} onSelect={openUpload}>
          <UploadIcon />
          Upload file
        </Item>
        <Separator />
        <Item
          {...itemProps}
          disabled={disabled || !clipboard}
          onSelect={() => paste()}
        >
          <ClipboardPasteIcon />
          Paste
        </Item>
      </>
    );
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
        <DropdownMenuContent align="end" className="w-52">
          {menuItems(file)}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  const ancestors: StoredFile[] = [];
  let ancestor = files?.find((file) => file.id === folder);
  while (ancestor && !ancestors.some((file) => file.id === ancestor?.id)) {
    ancestors.unshift(ancestor);
    ancestor = files?.find((file) => file.id === ancestor?.parentId);
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {folder ? (
            <nav
              aria-label="Folder path"
              className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
            >
              <Button
                variant="ghost"
                className="h-11 px-0 text-2xl font-semibold tracking-tight"
                onClick={() => openFolder(null)}
              >
                Files
              </Button>
              {ancestors.map((item) => (
                <span key={item.id} className="flex min-w-0 items-center">
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  <Button
                    variant="ghost"
                    className="h-11 max-w-48"
                    onClick={() => openFolder(item.id)}
                  >
                    <span className="truncate">{item.name}</span>
                  </Button>
                </span>
              ))}
            </nav>
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
          )}
        </div>
        {allowed && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="h-11 md:h-10"
              disabled={disabled || files === null}
              onClick={() => startName()}
            >
              <FolderPlusIcon />
              New folder
            </Button>
            <Button
              className="h-11 shrink-0 md:h-10"
              ref={uploadTrigger}
              onClick={openUpload}
              disabled={disabled || files === null}
            >
              <UploadIcon />
              Upload file
            </Button>
          </div>
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
          {clipboard && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="h-11"
                disabled={disabled}
                onClick={() => paste()}
              >
                <ClipboardPasteIcon />
                Paste
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label="Cancel copy or cut"
                onClick={() => setClipboard(null)}
              >
                <XIcon />
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-40">
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-11"
                  aria-label="Filter and sort files"
                >
                  <SlidersHorizontalIcon />
                  Filters{type !== "all" || sort !== "newest" ? " •" : ""}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="max-h-[70vh] w-52 overflow-y-auto"
              >
                <DropdownMenuLabel>File type</DropdownMenuLabel>
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
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
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
            <div className="flex items-center gap-2">
              {files !== null && (
                <span
                  className="whitespace-nowrap text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  {visible?.length ?? 0}{" "}
                  {(visible?.length ?? 0) === 1 ? "item" : "items"}
                </span>
              )}
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
          {active && (
            <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg bg-primary/10 px-3 text-sm text-foreground">
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
                  onClick={() =>
                    active.isFolder ? openFolder(active.id) : download(active)
                  }
                >
                  <DownloadIcon />
                  {active.isFolder ? "Open folder" : "Download"}
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
              </>{" "}
            </div>
          )}
          {(error || syncError) && (
            <Alert variant="destructive">
              <AlertDescription>
                {error || syncError}
                {syncError &&
                  loadedAt &&
                  ` Last loaded ${loadedAt.toLocaleTimeString()}.`}
              </AlertDescription>
            </Alert>
          )}
          <ContextMenu
            onOpenChange={(open) => {
              if (!open) search.current?.focus();
            }}
          >
            <ContextMenuTrigger asChild disabled={!allowed || files === null}>
              <div
                className="min-h-72 flex-1"
                tabIndex={0}
                aria-label="File browser"
                onContextMenu={(event) => {
                  const id = (event.target as HTMLElement)
                    .closest("[data-file-id]")
                    ?.getAttribute("data-file-id");
                  const target = files?.find((file) => file.id === id) ?? null;
                  setContextFile(target);
                  setActiveId(target?.id ?? null);
                }}
                onKeyDown={(event) => {
                  if (
                    (event.target as HTMLElement).closest(
                      "input,textarea,[contenteditable=true]",
                    )
                  )
                    return;
                  if (event.shiftKey && event.key === "F10") {
                    event.preventDefault();
                    const target = event.target as HTMLElement;
                    const rect = target.getBoundingClientRect();
                    target.dispatchEvent(
                      new MouseEvent("contextmenu", {
                        bubbles: true,
                        clientX: rect.left + 20,
                        clientY: rect.top + 20,
                      }),
                    );
                  } else if (
                    (event.ctrlKey || event.metaKey) &&
                    ["c", "x", "v"].includes(event.key.toLowerCase())
                  ) {
                    if (disabled) return;
                    if (event.key.toLowerCase() === "v" && clipboard) {
                      event.preventDefault();
                      void paste();
                    } else if (active && event.key.toLowerCase() !== "v") {
                      event.preventDefault();
                      copy(
                        active,
                        event.key.toLowerCase() === "x" ? "cut" : "copy",
                      );
                    }
                  }
                }}
              >
                {files === null ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {syncError
                      ? "Files could not be loaded. Retrying automatically."
                      : "Loading files..."}
                  </p>
                ) : visible?.length === 0 ? (
                  <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
                    <div className="mb-4 rounded-xl bg-muted/40 p-4">
                      <FileIcon className="size-8 text-muted-foreground" />
                    </div>
                    <h2 className="font-medium">
                      {query || type !== "all"
                        ? "No matching files"
                        : folder
                          ? "This folder is empty"
                          : "Your files, together"}
                    </h2>
                    <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                      {query || type !== "all"
                        ? "Try another filename or clear your filters."
                        : "Upload configs, plugins, and other files to share with your organization managers."}
                    </p>
                    {query || type !== "all" ? (
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
                        const Icon = file.isFolder
                          ? FolderIcon
                          : fileIcon(file.name);
                        return (
                          <tr
                            key={file.id}
                            data-file-id={file.id}
                            className={cn(
                              "border-b border-border/60 transition-colors hover:bg-muted/40",
                              clipboard?.mode === "cut" &&
                                clipboard.file.id === file.id &&
                                "opacity-50",
                              active?.id === file.id &&
                                "bg-primary/10 hover:bg-primary/15",
                            )}
                          >
                            <td className="p-0">
                              <button
                                type="button"
                                aria-pressed={active?.id === file.id}
                                onClick={() =>
                                  file.isFolder
                                    ? openFolder(file.id)
                                    : select(file)
                                }
                                className="flex min-h-14 w-full items-center gap-3 rounded-md px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                title={file.name}
                              >
                                <Icon className="size-5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0">
                                  <span className="block truncate font-medium">
                                    {file.name}
                                  </span>
                                  <span className="mt-1 block text-xs text-muted-foreground sm:hidden">
                                    {file.isFolder
                                      ? "Folder"
                                      : sizeLabel(file.size)}{" "}
                                    ·{" "}
                                    {new Date(
                                      file.createdAt * 1000,
                                    ).toLocaleDateString()}
                                  </span>
                                </span>
                              </button>
                            </td>
                            <td className="hidden text-muted-foreground md:table-cell">
                              {new Date(
                                file.createdAt * 1000,
                              ).toLocaleDateString()}
                            </td>
                            <td className="hidden text-muted-foreground tabular-nums sm:table-cell">
                              {file.isFolder ? "Folder" : sizeLabel(file.size)}
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
                      const Icon = file.isFolder
                        ? FolderIcon
                        : fileIcon(file.name);
                      return (
                        <li
                          key={file.id}
                          data-file-id={file.id}
                          className={cn(
                            "overflow-hidden rounded-xl border bg-card transition-colors hover:border-border-strong",
                            clipboard?.mode === "cut" &&
                              clipboard.file.id === file.id &&
                              "opacity-50",
                            active?.id === file.id &&
                              "border-primary bg-primary/10",
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
                            onClick={() =>
                              file.isFolder ? openFolder(file.id) : select(file)
                            }
                            className="group w-full px-3 pb-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <div className="relative my-2 flex h-36 items-center justify-center rounded-lg bg-background/60">
                              {!file.isFolder &&
                              ["png", "jpg", "jpeg", "gif", "webp"].includes(
                                extension(file.name),
                              ) ? (
                                <FileThumbnail
                                  key={`${organization}:${file.id}`}
                                  id={file.id}
                                  organization={organization}
                                  fallback={
                                    <Icon className="size-14 text-muted-foreground/60" />
                                  }
                                />
                              ) : (
                                <Icon className="size-14 text-muted-foreground/60" />
                              )}
                              {active?.id === file.id && (
                                <CheckIcon className="absolute top-3 right-3 size-5 text-primary" />
                              )}
                            </div>
                            <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span>
                                {file.isFolder
                                  ? "Folder"
                                  : sizeLabel(file.size)}
                              </span>
                              <span>
                                {new Date(
                                  file.createdAt * 1000,
                                ).toLocaleDateString()}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-52">
              {menuItems(contextFile, true)}
            </ContextMenuContent>
          </ContextMenu>
          <Dialog
            open={naming !== null}
            onOpenChange={(open) => {
              if (!open && !busy) setNaming(null);
            }}
          >
            <DialogContent showCloseButton={!busy}>
              <DialogHeader>
                <DialogTitle>
                  {naming?.file ? "Rename" : "New folder"}
                </DialogTitle>
                <DialogDescription>
                  {naming?.file
                    ? "Choose a new name."
                    : "Use / to create subfolders, for example configs/plugins/custom. Existing folders are reused."}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={saveName} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="file-name">Name</Label>
                  <Input
                    id="file-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoFocus
                    required
                    disabled={busy}
                  />
                </div>
                {nameError && (
                  <p role="alert" className="text-sm text-destructive">
                    {nameError}
                  </p>
                )}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setNaming(null)}
                  >
                    Cancel
                  </Button>
                  <Button disabled={busy || !name.trim()}>
                    {busy
                      ? "Saving..."
                      : naming?.file
                        ? "Save name"
                        : "Create folder"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          {sharing && (
            <FileShareDialog
              key={sharing.id}
              file={sharing}
              organization={organization}
              onClose={() => setSharing(null)}
            />
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
                  <dd>
                    {details.isFolder ? "Folder" : sizeLabel(details.size)}
                  </dd>
                  <dt className="text-muted-foreground">Uploaded</dt>
                  <dd>{new Date(details.createdAt * 1000).toLocaleString()}</dd>
                  <dt className="text-muted-foreground">Organization access</dt>
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
                <DialogTitle>
                  {removing?.isFolder
                    ? "Delete folder and contents?"
                    : "Delete file?"}
                </DialogTitle>
                <DialogDescription className="break-all">
                  Delete {removing?.name}
                  {removing?.isFolder
                    ? " and every file and subfolder inside it"
                    : ""}{" "}
                  from this organization. This cannot be undone.
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
                  {busy
                    ? "Deleting..."
                    : removing?.isFolder
                      ? "Delete folder"
                      : "Delete file"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
