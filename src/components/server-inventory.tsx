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
  checkedAt: number | null;
  rconStatus: string | null;
  a2sStatus: string | null;
};
const outcomes: Record<string, string> = {
  connected: "Connected",
  authentication_failed:
    "Authentication failed. Check the RCON password and server access rules.",
  unreachable: "Unreachable. Check the address, port, and network access.",
  timeout:
    "Timed out. Check that the server is running and the firewall allows this port.",
  invalid_configuration:
    "Invalid configuration. Check the saved connection details and credential encryption key.",
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
function endpoint(host: string, port: number) {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}
export function ServerInventory({ identity }: { identity: Identity }) {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState("");
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(empty);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());
  const form = useRef<HTMLFormElement>(null);
  const view = identity.permissions.includes("servers.view");
  const manage = identity.permissions.includes("servers.manage");
  async function load() {
    setRefreshing(true);
    try {
      setServers(await apiRequest<Server[]>("servers"));
      setLoadedAt(Date.now());
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
        if (active) {
          setServers(value);
          setLoadedAt(Date.now());
        }
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
  async function testConnection(id: string) {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setChecking((previous) => ({ ...previous, [id]: true }));
    setCheckErrors((previous) => ({ ...previous, [id]: "" }));
    try {
      const result = await apiRequest<Server>(`servers/${id}/check`, {});
      setServers(
        (previous) =>
          previous?.map((server) => (server.id === id ? result : server)) ??
          null,
      );
    } catch (cause) {
      setCheckErrors((previous) => ({
        ...previous,
        [id]:
          cause instanceof Error
            ? cause.message
            : "Connection check could not be saved. Try again.",
      }));
    } finally {
      inFlight.current.delete(id);
      setChecking((previous) => ({ ...previous, [id]: false }));
    }
  }
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
                  Save RCON and A2S details for this organization. Read-only
                  health checks begin automatically after saving.
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
                      setFields({});
                      setFormError("");
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
                {servers && loadedAt !== null && (
                  <span className="block">
                    Last loaded{" "}
                    <time dateTime={new Date(loadedAt).toISOString()}>
                      {new Date(loadedAt).toLocaleString()}
                    </time>
                    .
                  </span>
                )}
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
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-semibold">{server.name}</h2>
                    {manage && (
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={checking[server.id]}
                        onClick={() => testConnection(server.id)}
                        aria-label={`Test connection for ${server.name}`}
                      >
                        {checking[server.id]
                          ? "Testing connection..."
                          : "Test connection"}
                      </Button>
                    )}
                  </div>
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">RCON</dt>
                      <dd className="break-all font-mono">
                        {endpoint(server.rconHost, server.rconPort)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">A2S</dt>
                      <dd className="break-all font-mono">
                        {endpoint(server.a2sHost, server.a2sPort)}
                      </dd>
                    </div>
                  </dl>
                  <div
                    role="status"
                    aria-live="polite"
                    className="space-y-2 text-sm"
                  >
                    {checking[server.id] && (
                      <p>Testing RCON and A2S connections...</p>
                    )}
                    {server.checkedAt ? (
                      <>
                        <p className="text-xs text-muted-foreground">
                          Last checked{" "}
                          <time
                            dateTime={new Date(server.checkedAt).toISOString()}
                          >
                            {new Date(server.checkedAt).toLocaleString()}
                          </time>
                          . Results reflect that check.
                        </p>
                        <dl className="grid gap-3 sm:grid-cols-2">
                          {(
                            [
                              ["RCON", server.rconStatus],
                              ["A2S", server.a2sStatus],
                            ] as const
                          ).map(([protocol, status]) => (
                            <div key={protocol}>
                              <dt className="font-medium">{protocol} result</dt>
                              <dd
                                className={
                                  status === "connected"
                                    ? "text-primary"
                                    : "text-warning"
                                }
                              >
                                {status === "protocol_error"
                                  ? protocol === "RCON"
                                    ? "Unexpected WebRCON response or closed connection. Check the RCON password, port, and rcon.web setting."
                                    : "Unexpected A2S response. Check the query port. Split or compressed replies are not supported."
                                  : (outcomes[status ?? ""] ??
                                    "Unknown. Test the connection again.")}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </>
                    ) : (
                      <p className="text-muted-foreground">Not checked yet.</p>
                    )}
                  </div>
                  {checkErrors[server.id] && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {checkErrors[server.id]}{" "}
                        {server.checkedAt
                          ? "The previous result is shown. Test the connection again to refresh it."
                          : "No connection result was saved."}
                      </AlertDescription>
                    </Alert>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
