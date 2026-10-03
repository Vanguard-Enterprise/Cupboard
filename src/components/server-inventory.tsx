"use client";

import { useEffect, useRef, useState } from "react";
import { apiRequest, type Identity } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type Server = {
  id: string;
  name: string;
  rconHost: string;
  rconPort: number;
  a2sHost: string;
  a2sPort: number;
};
const empty = {
  name: "",
  rconHost: "",
  rconPort: "28016",
  rconPassword: "",
  a2sHost: "",
  a2sPort: "28017",
};
const labels = {
  name: "Server name",
  rconHost: "RCON host",
  rconPort: "RCON port",
  rconPassword: "RCON password",
  a2sHost: "A2S host",
  a2sPort: "A2S port",
};
export function ServerInventory({ identity }: { identity: Identity }) {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(empty);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const view = identity.permissions.includes("servers.view");
  const manage = identity.permissions.includes("servers.manage");
  async function load() {
    setRefreshing(true);
    try {
      setServers(await apiRequest<Server[]>("servers"));
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Servers could not be loaded.",
      );
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => {
    if (!view) return;
    let active = true;
    apiRequest<Server[]>("servers")
      .then((value) => {
        if (active) setServers(value);
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [view]);
  useEffect(() => {
    if (saving) return;
    const first = Object.keys(labels).find((field) => fields[field]);
    if (first)
      form.current?.querySelector<HTMLInputElement>(`#${first}`)?.focus();
  }, [fields, saving]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const portErrors: Record<string, string> = {};
    for (const field of ["rconPort", "a2sPort"] as const) {
      if (
        !/^\d+$/.test(draft[field]) ||
        Number(draft[field]) < 1 ||
        Number(draft[field]) > 65535
      )
        portErrors[field] = "Enter a port from 1 to 65535.";
    }
    if (Object.keys(portErrors).length) {
      setFields(portErrors);
      setFormError("Check the highlighted fields.");
      return;
    }
    setSaving(true);
    setFields({});
    setFormError("");
    try {
      const response = await fetch("/app-api/servers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cupboard-Request": "1",
        },
        body: JSON.stringify({
          ...draft,
          rconPort: Number(draft.rconPort),
          a2sPort: Number(draft.a2sPort),
        }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) {
        setFields(result.fields ?? {});
        setFormError(result.error ?? "Server could not be added.");
        return;
      }
      setDraft(empty);
      setOpen(false);
      toast.success("Server added.");
      if (view) await load();
    } catch {
      setFormError(
        "Server could not be added. Check your connection and try again.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Server inventory
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rust servers in {identity.organization?.name}.
          </p>
        </div>
        {manage && (
          <Dialog
            open={open}
            onOpenChange={(value) => {
              if (saving) return;
              setOpen(value);
              if (!value) {
                setDraft(empty);
                setFields({});
                setFormError("");
              }
            }}
          >
            <DialogTrigger asChild>
              <Button className="min-h-11">Add server</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add server</DialogTitle>
                <DialogDescription>
                  Save RCON and A2S details for this organization. Saving does
                  not connect to or change the server.
                </DialogDescription>
              </DialogHeader>
              <form
                ref={form}
                onSubmit={save}
                noValidate
                className="grid gap-4 sm:grid-cols-2"
              >
                {(Object.keys(labels) as (keyof typeof labels)[]).map(
                  (field) => (
                    <div
                      key={field}
                      className={
                        field === "name" || field === "rconPassword"
                          ? "space-y-2 sm:col-span-2"
                          : "space-y-2"
                      }
                    >
                      <Label htmlFor={field}>{labels[field]}</Label>
                      <Input
                        id={field}
                        name={field}
                        className="min-h-11"
                        type={field === "rconPassword" ? "password" : "text"}
                        inputMode={
                          field.endsWith("Port") ? "numeric" : undefined
                        }
                        autoComplete="off"
                        value={draft[field]}
                        disabled={saving}
                        aria-invalid={Boolean(fields[field])}
                        aria-describedby={
                          fields[field]
                            ? `${field}-error`
                            : field === "rconPassword"
                              ? "password-help"
                              : undefined
                        }
                        onChange={(event) =>
                          setDraft({ ...draft, [field]: event.target.value })
                        }
                      />
                      {fields[field] && (
                        <p
                          id={`${field}-error`}
                          className="text-sm text-destructive"
                        >
                          {fields[field]}
                        </p>
                      )}
                      {field === "rconPassword" && (
                        <p
                          id="password-help"
                          className="text-xs text-muted-foreground"
                        >
                          Stored encrypted. The password is never shown after
                          saving.
                        </p>
                      )}
                    </div>
                  ),
                )}
                {formError && (
                  <Alert variant="destructive" className="sm:col-span-2">
                    <AlertDescription>{formError}</AlertDescription>
                  </Alert>
                )}
                <div className="flex justify-end gap-2 sm:col-span-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={saving}
                    onClick={() => {
                      setOpen(false);
                      setDraft(empty);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button className="min-h-11" disabled={saving}>
                    {saving ? "Adding server..." : "Add server"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>
      {!view ? (
        <p className="text-sm text-muted-foreground">
          You need server viewing permission to see this organization&apos;s
          servers.
        </p>
      ) : (
        <>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {servers ? "The server list may be out of date. " : ""}
                {error}
                <Button variant="outline" disabled={refreshing} onClick={load}>
                  {refreshing ? "Refreshing..." : "Try again"}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!servers && !error && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading servers...
            </p>
          )}
          {servers?.length === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <h2 className="font-semibold">No servers yet</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {manage
                  ? "Add a Rust server using its RCON and A2S details."
                  : "Ask an organization administrator to add a server."}
              </p>
            </div>
          )}
          {servers && servers.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {servers.map((server) => (
                <li key={server.id} className="space-y-3 p-5">
                  <h2 className="font-semibold">{server.name}</h2>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">RCON</dt>
                      <dd className="break-all font-mono">
                        {server.rconHost}:{server.rconPort}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">A2S</dt>
                      <dd className="break-all font-mono">
                        {server.a2sHost}:{server.a2sPort}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
