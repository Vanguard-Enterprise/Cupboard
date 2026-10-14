"use client";

import {
  ArrowLeftIcon,
  PlusIcon,
  SearchIcon,
  MoreHorizontalIcon,
  ActivityIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  PelicanServerImport,
  PelicanServerControls,
} from "@/components/pelican-server-controls";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";

type Server = {
  id: string;
  name: string;
  rconHost: string | null;
  rconPort: number | null;
  a2sHost: string | null;
  a2sPort: number | null;
  panelServerUuid?: string | null;
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
function endpoint(host: string | null, port: number | null) {
  if (!host || !port) return "Not configured";
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}
export function ServerInventory({ identity }: { identity: Identity }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [provider, setProvider] = useState("all");
  const [selected, setSelected] = useState<Server | null>(null);
  const [readings, setReadings] = useState<
    Record<
      string,
      { state: string; resources: Record<string, number>; at: number }
    >
  >({});
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
  const organization = identity.organization?.id;
  const status = (server: Server) => {
    const reading = readings[server.id];
    if (reading && Date.now() - reading.at < 90_000)
      return reading.state === "running"
        ? "Running"
        : reading.state === "offline" || reading.state === "stopped"
          ? "Offline"
          : "Starting";
    return server.panelServerUuid ? "Awaiting report" : "Manual";
  };
  const visible = servers?.filter(
    (server) =>
      `${server.name} ${server.rconHost ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" || status(server) === filter) &&
      (provider === "all" ||
        (provider === "pelican") === !!server.panelServerUuid),
  );
  useEffect(() => {
    if (!servers || !organization) return;
    let disposed = false;
    let running = false;
    async function refresh() {
      if (running) return;
      running = true;
      for (const server of servers ?? []) {
        if (disposed) break;
        if (!server.panelServerUuid) continue;
        try {
          const data = await apiRequest<{
            state: string;
            resources: Record<string, number>;
          }>(`servers/${server.id}/panel/resources`, undefined, organization);
          if (!disposed)
            setReadings((previous) => ({
              ...previous,
              [server.id]: { ...data, at: Date.now() },
            }));
        } catch {
          if (!disposed)
            setReadings((previous) => {
              const next = { ...previous };
              delete next[server.id];
              return next;
            });
        }
      }
      running = false;
    }
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      disposed = true;
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [servers, organization]);
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
    <section className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
      {!selected && (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Game Servers
            </h1>
          </div>
          <div className="flex gap-2">
            {manage &&
              identity.permissions.includes("integrations.manage") &&
              identity.organization?.id && (
                <PelicanServerImport
                  key={identity.organization.id}
                  organization={identity.organization?.id}
                  onImported={() => void load()}
                />
              )}
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
                  <Button className="min-h-11">
                    <PlusIcon className="size-4" />
                    Add server
                  </Button>
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
                            type={
                              field === "rconPassword" ? "password" : "text"
                            }
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
                              setDraft({
                                ...draft,
                                [field]: event.target.value,
                              })
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
                              Stored encrypted. The password is never shown
                              after saving.
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
        </div>
      )}
      {selected?.panelServerUuid && organization && (
        <div className="space-y-5">
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => setSelected(null)}
          >
            <ArrowLeftIcon className="size-4" />
            Back to servers
          </Button>
          <PelicanServerControls
            key={selected.id}
            server={selected}
            organization={organization}
            manage={manage}
            active
            inline
            onClose={() => setSelected(null)}
          />
        </div>
      )}
      {selected && !selected.panelServerUuid && (
        <div className="space-y-5">
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => setSelected(null)}
          >
            <ArrowLeftIcon className="size-4" />
            Back to servers
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            {selected.name}
          </h1>
          <div className="grid gap-4 rounded-lg border p-5 sm:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">RCON</p>
              <p className="mt-1 font-mono text-sm">
                {endpoint(selected.rconHost, selected.rconPort)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">A2S</p>
              <p className="mt-1 font-mono text-sm">
                {endpoint(selected.a2sHost, selected.a2sPort)}
              </p>
            </div>
          </div>
        </div>
      )}
      {selected ? null : !view ? (
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
                  ? "Import a Rust server from Pelican or add its RCON and A2S details."
                  : "Ask an organization administrator to add a server."}
              </p>
            </div>
          )}
          {servers && servers.length > 0 && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative w-full md:w-72 lg:mr-auto">
                  <SearchIcon className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
                  <Input
                    className="min-h-11 pl-9"
                    aria-label="Search servers"
                    placeholder="Search servers..."
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <Select value={filter} onValueChange={setFilter}>
                  <SelectTrigger
                    className="min-h-11 flex-1 sm:w-44 sm:flex-none"
                    aria-label="Server status"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="start"
                    className="p-1"
                  >
                    <SelectItem className="min-h-11" value="all">
                      All statuses
                    </SelectItem>
                    {[
                      "Running",
                      "Offline",
                      "Starting",
                      "Awaiting report",
                      "Manual",
                    ].map((value) => (
                      <SelectItem
                        className="min-h-11"
                        key={value}
                        value={value}
                      >
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger
                    className="min-h-11 flex-1 sm:w-44 sm:flex-none"
                    aria-label="Provider filter"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="start"
                    className="p-1"
                  >
                    <SelectItem className="min-h-11" value="all">
                      All providers
                    </SelectItem>
                    <SelectItem className="min-h-11" value="pelican">
                      Pelican
                    </SelectItem>
                    <SelectItem className="min-h-11" value="manual">
                      Manual
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {!visible?.length ? (
                <div className="space-y-3 border-y border-dashed py-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    No servers match your search.
                  </p>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                      setProvider("all");
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              ) : (
                <TooltipProvider>
                  <Table className="table-fixed" aria-label="Game servers">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-auto text-xs text-muted-foreground">
                          Server
                        </TableHead>
                        {["CPU", "Memory", "Storage"].map((label) => (
                          <TableHead
                            key={label}
                            className="hidden w-[12%] text-xs text-muted-foreground md:table-cell"
                          >
                            {label}
                          </TableHead>
                        ))}
                        <TableHead className="hidden w-[18%] text-xs text-muted-foreground md:table-cell">
                          Network
                        </TableHead>
                        <TableHead className="w-12">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visible.map((server) => {
                        const reading = readings[server.id];
                        return (
                          <TableRow key={server.id}>
                            <TableCell className="whitespace-normal py-3">
                              <div className="flex items-start gap-3">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={`${server.name}: ${status(server)}`}
                                      className={`flex size-11 shrink-0 items-center justify-center rounded-lg border-2 bg-card ${status(server) === "Running" ? "border-primary" : status(server) === "Offline" ? "border-muted-foreground" : "border-warning"}`}
                                    >
                                      <ServerIcon className="size-4 text-muted-foreground" />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {status(server)}
                                    {reading
                                      ? ` · Last observed ${new Date(reading.at).toLocaleTimeString()}`
                                      : ""}
                                  </TooltipContent>
                                </Tooltip>
                                <button
                                  type="button"
                                  aria-label={server.name}
                                  onClick={() => setSelected(server)}
                                  className="group flex min-h-11 min-w-0 flex-col items-start justify-start rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  <span className="flex flex-wrap items-baseline gap-x-2">
                                    <span
                                      role="heading"
                                      aria-level={2}
                                      className="font-medium underline-offset-4 group-hover:underline break-words"
                                    >
                                      {server.name}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {server.panelServerUuid
                                        ? "Pelican"
                                        : "Manual"}
                                    </span>
                                  </span>
                                  <span className="break-all font-mono text-xs text-muted-foreground">
                                    {endpoint(server.rconHost, server.rconPort)}
                                  </span>
                                  <span className="sr-only">
                                    {endpoint(server.a2sHost, server.a2sPort)}
                                  </span>
                                </button>
                              </div>
                              <div
                                role="status"
                                aria-live="polite"
                                className="sr-only"
                              >
                                {checking[server.id]
                                  ? "Testing RCON and A2S connections..."
                                  : server.checkedAt
                                    ? `Last checked ${new Date(server.checkedAt).toLocaleString()}`
                                    : "Not checked yet."}
                                {[server.rconStatus, server.a2sStatus].map(
                                  (value, index) =>
                                    value && (
                                      <span key={index}>
                                        {outcomes[value] ?? value}
                                      </span>
                                    ),
                                )}
                              </div>
                              {checkErrors[server.id] && (
                                <p
                                  role="alert"
                                  className="mt-2 text-xs text-destructive"
                                >
                                  {checkErrors[server.id]}{" "}
                                  {server.checkedAt
                                    ? "The previous result is shown. Test the connection again to refresh it."
                                    : "No connection result was saved."}
                                </p>
                              )}
                            </TableCell>
                            {reading ? (
                              <>
                                <TableCell className="hidden md:table-cell">
                                  <div className="space-y-2 py-2">
                                    <span className="text-xs tabular-nums">
                                      {reading.resources.cpu_absolute.toFixed(
                                        1,
                                      )}
                                      %
                                    </span>
                                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                                      <div
                                        className="h-full rounded-full bg-primary"
                                        style={{
                                          width: `${Math.min(100, reading.resources.cpu_absolute)}%`,
                                        }}
                                      />
                                    </div>
                                  </div>
                                </TableCell>
                                {["memory_bytes", "disk_bytes"].map(
                                  (metric) => (
                                    <TableCell
                                      key={metric}
                                      className="hidden text-xs tabular-nums md:table-cell"
                                    >
                                      {(
                                        reading.resources[metric] /
                                        1024 /
                                        1024
                                      ).toFixed(1)}{" "}
                                      MiB
                                    </TableCell>
                                  ),
                                )}
                                <TableCell className="hidden text-xs tabular-nums md:table-cell">
                                  <div>
                                    ↓{" "}
                                    {(
                                      reading.resources.network_rx_bytes /
                                      1024 /
                                      1024
                                    ).toFixed(1)}{" "}
                                    MiB
                                  </div>
                                  <div className="text-muted-foreground">
                                    ↑{" "}
                                    {(
                                      reading.resources.network_tx_bytes /
                                      1024 /
                                      1024
                                    ).toFixed(1)}{" "}
                                    MiB
                                  </div>
                                </TableCell>
                              </>
                            ) : (
                              <TableCell
                                colSpan={4}
                                className="hidden text-center text-xs text-muted-foreground md:table-cell"
                              >
                                {server.panelServerUuid
                                  ? "Awaiting resource report"
                                  : "Live resources require a Pelican connection"}
                              </TableCell>
                            )}
                            <TableCell className="px-0">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="min-h-11 min-w-11"
                                    aria-label={`Actions for ${server.name}`}
                                  >
                                    <MoreHorizontalIcon />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  align="end"
                                  className="min-w-44"
                                >
                                  <DropdownMenuItem
                                    onSelect={() => setSelected(server)}
                                  >
                                    <ActivityIcon aria-hidden="true" />
                                    Monitor
                                  </DropdownMenuItem>
                                  {manage &&
                                    server.rconHost &&
                                    server.a2sHost && (
                                      <DropdownMenuItem
                                        disabled={checking[server.id]}
                                        onSelect={() =>
                                          void testConnection(server.id)
                                        }
                                        aria-label={`Test connection for ${server.name}`}
                                      >
                                        <RefreshCwIcon aria-hidden="true" />
                                        {checking[server.id]
                                          ? "Testing..."
                                          : "Test connection"}
                                      </DropdownMenuItem>
                                    )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TooltipProvider>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
