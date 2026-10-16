"use client";

import { useEffect, useState } from "react";
import {
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  TagsIcon,
  XIcon,
} from "lucide-react";
import { apiRequest } from "@/lib/api-client";
import type { Machine, MachineTag } from "@/lib/machines";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function MachineTagBadges({
  machine,
  catalog,
}: {
  machine: Machine;
  catalog: MachineTag[];
}) {
  return (
    <>
      {catalog
        .filter((tag) => machine.tags?.includes(tag.id))
        .map((tag) => (
          <Badge
            key={tag.id}
            variant="outline"
            className="max-w-40 rounded-full text-[10px] font-normal"
          >
            <span className="truncate">{tag.name}</span>
          </Badge>
        ))}
    </>
  );
}

export function MachineTagsDialog({
  machine,
  organization,
  onClose,
  onSaved,
}: {
  machine: Machine;
  organization: string;
  onClose: () => void;
  onSaved: (catalog: MachineTag[]) => void;
}) {
  const [catalog, setCatalog] = useState<MachineTag[] | null>(null);
  const [selected, setSelected] = useState(machine.tags ?? []);
  const [revision, setRevision] = useState(machine.revision);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MachineTag | null>(null);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    apiRequest<MachineTag[]>("machines/tags", undefined, organization)
      .then((tags) => {
        if (active) setCatalog(tags);
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [organization]);
  async function change(body: unknown) {
    setBusy(true);
    setError("");
    try {
      const tags = await apiRequest<MachineTag[]>(
        "machines/tags",
        body,
        organization,
      );
      setCatalog(tags);
      onSaved(tags);
      setName("");
      setEditing(null);
      if (deleting) {
        // Deleting an assigned tag advances the machine revision on the server.
        if ((machine.tags ?? []).includes(deleting.id))
          setRevision((value) => value + 1);
        setSelected((value) => value.filter((id) => id !== deleting.id));
        setDeleting(null);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Tags could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiRequest(
        `machines/${machine.id}/tags`,
        { tags: selected, revision },
        organization,
      );
      onSaved(catalog ?? []);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Tags could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto [&_button[data-slot=button]]:min-h-11 [&_button[data-slot=dialog-close]]:size-11">
        <DialogHeader>
          <DialogTitle>Tags · {machine.name}</DialogTitle>
          <DialogDescription>
            Label the role of this machine. Tags are shared within your
            organization.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {catalog === null ? (
          <p className="text-sm text-muted-foreground">Loading tags...</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {catalog.map((tag) => (
              <label
                key={tag.id}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border px-3 text-sm hover:bg-muted"
              >
                <Checkbox
                  checked={selected.includes(tag.id)}
                  disabled={
                    busy ||
                    (!selected.includes(tag.id) && selected.length >= 10)
                  }
                  onCheckedChange={(checked) =>
                    setSelected((value) =>
                      checked
                        ? [...value, tag.id]
                        : value.filter((id) => id !== tag.id),
                    )
                  }
                />
                {tag.name}
              </label>
            ))}
            {!catalog.length && (
              <p className="text-sm text-muted-foreground">
                Create a tag to label this machine.
              </p>
            )}
          </div>
        )}
        <Button
          variant="ghost"
          className="min-h-11 justify-start"
          disabled={busy || catalog === null}
          onClick={() => setManaging((value) => !value)}
        >
          <TagsIcon />
          {managing ? "Hide tag settings" : "Manage organization tags"}
        </Button>
        {managing && (
          <div className="space-y-3 border-t border-border pt-4">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void change({
                  kind: "save",
                  ...(editing ? { id: editing } : {}),
                  name,
                });
              }}
              className="space-y-2"
            >
              <Label htmlFor="machine-tag-name">
                {editing ? "Rename tag" : "New tag"}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="machine-tag-name"
                  className="h-11 min-w-0"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={32}
                  disabled={busy}
                  required
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={busy || !name.trim()}
                >
                  {editing ? <PencilIcon /> : <PlusIcon />}
                  {editing ? "Rename" : "Create"}
                </Button>
                {editing && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Cancel rename"
                    onClick={() => {
                      setEditing(null);
                      setName("");
                    }}
                  >
                    <XIcon />
                  </Button>
                )}
              </div>
            </form>
            {catalog?.map((tag) => (
              <div key={tag.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-words">{tag.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label={`Rename ${tag.name}`}
                  disabled={busy}
                  onClick={() => {
                    setEditing(tag.id);
                    setName(tag.name);
                  }}
                >
                  <PencilIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label={`Delete ${tag.name}`}
                  disabled={busy}
                  onClick={() => setDeleting(tag)}
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            {deleting && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-sm">
                  Delete {deleting.name}? This removes it from every machine in
                  this organization.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      void change({ kind: "delete", id: deleting.id })
                    }
                  >
                    Delete tag
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setDeleting(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || catalog === null || !!deleting}
            onClick={() => void save()}
          >
            {busy ? "Saving..." : "Save tags"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
