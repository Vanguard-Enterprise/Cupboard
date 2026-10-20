"use client";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  PlayIcon,
  SquareIcon,
  RotateCwIcon,
  TerminalIcon,
  ActivityIcon,
  PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
type Candidates = {
  connectionId: string;
  revision: number;
  servers: { uuid: string; name: string; node: string; imported: boolean }[];
};
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The panel request failed.";
export function PelicanServerImport({
  organization,
  onImported,
}: {
  organization: string;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Candidates | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  async function browse() {
    setOpen(true);
    setCatalog(null);
    setError("");
    setQuery("");
    setLoading(true);
    try {
      setCatalog(
        await apiRequest<Candidates>(
          "servers/pelican/candidates",
          undefined,
          organization,
        ),
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }
  async function add(uuid: string) {
    if (!catalog || busy) return;
    setBusy(uuid);
    setError("");
    try {
      await apiRequest(
        "servers/pelican/import",
        {
          uuid,
          connectionId: catalog.connectionId,
          revision: catalog.revision,
        },
        organization,
      );
      setCatalog({
        ...catalog,
        servers: catalog.servers.map((s) =>
          s.uuid === uuid ? { ...s, imported: true } : s,
        ),
      });
      onImported();
      toast.success("Rust server added.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }
  const filtered =
    catalog?.servers.filter((s) =>
      `${s.name} ${s.node}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Button
        variant="outline"
        className="min-h-11"
        onClick={() => void browse()}
      >
        From Pelican
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Import Rust servers</DialogTitle>
            <DialogDescription>
              Add existing Rust servers from your connected Pelican account.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Search panel servers"
            placeholder="Search servers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {error && (
            <div role="alert" className="space-y-3 text-sm text-destructive">
              <p>{error}</p>
              <Button
                variant="outline"
                disabled={loading || !!busy}
                onClick={() => void browse()}
              >
                Reload
              </Button>
              <Link
                className="ml-3 underline"
                href="/dashboard/organization/integrations/connections"
              >
                Connections
              </Link>
            </div>
          )}
          {loading ? (
            <p role="status">Loading Rust servers...</p>
          ) : (
            catalog && (
              <>
                <p className="sr-only" role="status">
                  {filtered.length} Rust servers
                </p>
                <ul className="divide-y rounded-lg border">
                  {filtered.map((s) => (
                    <li
                      key={s.uuid}
                      className="flex items-center justify-between gap-4 p-4"
                    >
                      <div className="min-w-0">
                        <p className="break-words font-medium">{s.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {s.node}
                        </p>
                      </div>
                      <Button
                        disabled={!!busy || s.imported}
                        aria-label={
                          s.imported
                            ? `${s.name} already added`
                            : `Add ${s.name}`
                        }
                        onClick={() => void add(s.uuid)}
                      >
                        {s.imported ? (
                          "Added"
                        ) : busy === s.uuid ? (
                          "Adding..."
                        ) : (
                          <>
                            <PlusIcon aria-hidden="true" />
                            Add
                          </>
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
                {filtered.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No Rust servers found. Check server assignments and startup
                    read permission in Pelican.
                  </p>
                )}
              </>
            )
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
type ResourceResult = { state: string; resources: Record<string, number> };
const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const uptime = (n: number) =>
  `${Math.floor(n / 3_600_000)}h ${Math.floor(n / 60_000) % 60}m`;
export function PelicanServerControls({
  server,
  organization,
  manage,
  active,
  inline,
  onClose,
}: {
  server: { id: string; name: string };
  organization: string;
  manage: boolean;
  active?: boolean;
  inline?: boolean;
  onClose?: () => void;
}) {
  const [localOpen, setOpen] = useState(false);
  const open = active ?? localOpen;
  const [tab, setTab] = useState("resources");
  const [result, setResult] = useState<ResourceResult | null>(null);
  const [observed, setObserved] = useState<number | null>(null);
  const [resourceError, setResourceError] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [consoleError, setConsoleError] = useState("");
  const [actionError, setActionError] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"stop" | "restart" | null>(null);
  const path = `servers/${server.id}/panel`;
  const loadResources = useCallback(async () => {
    const data = await apiRequest<ResourceResult>(
      `${path}/resources`,
      undefined,
      organization,
    );
    return data;
  }, [path, organization]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let running = false;
    async function refresh() {
      if (running) return;
      running = true;
      try {
        const data = await loadResources();
        if (!disposed) {
          setResult(data);
          setObserved(Date.now());
          setResourceError("");
        }
      } catch (cause) {
        if (!disposed) setResourceError(message(cause));
      } finally {
        running = false;
      }
    }
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      disposed = true;
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [open, loadResources]);
  useEffect(() => {
    if (!open || tab !== "console") return;
    let disposed = false;
    let running = false;
    async function refresh() {
      if (running) return;
      running = true;
      try {
        const data = await apiRequest<{ lines: string[] }>(
          `${path}/console`,
          undefined,
          organization,
        );
        if (!disposed) {
          setLines(data.lines);
          setConsoleError("");
        }
      } catch (cause) {
        if (!disposed) setConsoleError(message(cause));
      } finally {
        running = false;
      }
    }
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => {
      disposed = true;
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [open, tab, path, organization]);
  async function power(signal: "start" | "stop" | "restart") {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await apiRequest(`${path}/power`, { signal }, organization);
      setConfirm(null);
      toast.success(
        `${signal === "start" ? "Start" : signal === "stop" ? "Stop" : "Restart"} requested.`,
      );
      try {
        setResult(await loadResources());
        setObserved(Date.now());
        setResourceError("");
      } catch (cause) {
        setResourceError(message(cause));
      }
    } catch (cause) {
      setActionError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !command.trim()) return;
    setBusy(true);
    setActionError("");
    try {
      await apiRequest(`${path}/command`, { command }, organization);
      setCommand("");
      toast.success("Command sent.");
    } catch (cause) {
      setActionError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  const content = (
    <>
      {inline ? (
        <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
      ) : (
        <DialogHeader>
          <DialogTitle>{server.name}</DialogTitle>
          <DialogDescription>
            Manage this Rust server through Pelican.
          </DialogDescription>
        </DialogHeader>
      )}

      {manage && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void power("start")}
          >
            <PlayIcon aria-hidden="true" />
            Start
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setActionError("");
              setConfirm("stop");
            }}
          >
            <SquareIcon aria-hidden="true" />
            Stop
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setActionError("");
              setConfirm("restart");
            }}
          >
            <RotateCwIcon aria-hidden="true" />
            Restart
          </Button>
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="resources">
            <ActivityIcon aria-hidden="true" />
            Resources
          </TabsTrigger>
          <TabsTrigger value="console">
            <TerminalIcon aria-hidden="true" />
            Console
          </TabsTrigger>
        </TabsList>
        <TabsContent value="resources" className="space-y-4">
          {resourceError && (
            <p role="alert" className="text-sm text-destructive">
              {resourceError}
              {result ? " Last observed values are shown." : ""}
            </p>
          )}
          {result ? (
            <>
              <Badge variant="outline">{result.state}</Badge>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {[
                  ["CPU", `${result.resources.cpu_absolute.toFixed(1)}%`],
                  ["Memory", bytes(result.resources.memory_bytes)],
                  ["Disk", bytes(result.resources.disk_bytes)],
                  ["Received", bytes(result.resources.network_rx_bytes)],
                  ["Sent", bytes(result.resources.network_tx_bytes)],
                  ["Uptime", uptime(result.resources.uptime)],
                ].map(([name, value]) => (
                  <div key={name} className="rounded-lg border p-4">
                    <dt className="text-sm text-muted-foreground">{name}</dt>
                    <dd className="mt-1 font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
              {observed && (
                <p className="text-xs text-muted-foreground">
                  Last observed {new Date(observed).toLocaleTimeString()}.
                  Refreshes every 30 seconds while open.
                </p>
              )}
            </>
          ) : (
            !resourceError && <p role="status">Loading resources...</p>
          )}
        </TabsContent>
        <TabsContent value="console" className="space-y-3">
          {consoleError && (
            <p role="alert" className="text-sm text-destructive">
              {consoleError}
            </p>
          )}
          <pre
            aria-label="Server console output"
            className="h-72 overflow-auto rounded-lg border bg-background p-3 text-xs whitespace-pre-wrap break-words"
          >
            {lines.length ? lines.join("\n") : "Waiting for console output..."}
          </pre>
          {manage && (
            <form onSubmit={send} className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Label className="sr-only" htmlFor={`command-${server.id}`}>
                  Console command
                </Label>
                <Input
                  id={`command-${server.id}`}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="Enter a Rust console command"
                  maxLength={1000}
                  autoComplete="off"
                  disabled={busy}
                />
              </div>
              <Button disabled={busy || !command.trim()}>Send</Button>
            </form>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
  return (
    <>
      {active === undefined && (
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => {
            setTab("resources");
            setOpen(true);
          }}
        >
          Manage <span className="sr-only">{server.name}</span>
        </Button>
      )}
      {inline ? (
        <div className="space-y-5">{content}</div>
      ) : (
        <Dialog
          open={open}
          onOpenChange={(value) => {
            if (!busy) {
              setOpen(value);
              if (!value) onClose?.();
            }
          }}
        >
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
            {content}
          </DialogContent>
        </Dialog>
      )}
      <Dialog
        open={!!confirm}
        onOpenChange={(value) => {
          if (!value && !busy) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === "stop" ? "Stop" : "Restart"} {server.name}?
            </DialogTitle>
            <DialogDescription>
              Players will be disconnected. Pelican will send the server a
              graceful power signal.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => confirm && void power(confirm)}
            >
              {busy
                ? "Requesting..."
                : confirm === "stop"
                  ? "Stop server"
                  : "Restart server"}
            </Button>
          </div>
          {actionError && (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
