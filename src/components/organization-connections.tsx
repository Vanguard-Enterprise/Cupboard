"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRightIcon,
  MoreHorizontalIcon,
  SearchIcon,
  RefreshCwIcon,
  PencilIcon,
  UnplugIcon,
} from "lucide-react";
import { formatDistance } from "date-fns";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiRequest, type Identity } from "@/lib/api-client";
import { pelicanStatus, type PelicanConnection } from "@/lib/pelican";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import Image from "next/image";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const catalog = [
  {
    id: "pelican",
    name: "Pelican Panel",
    logo: "/images/integrations/pelican.png",
    category: "Server management",
    description:
      "Verify panel access and list the servers assigned to your account.",
    access: [
      "HTTPS panel URL",
      "Client API key from a dedicated account",
      "Server assignments for that account",
    ],
  },
  {
    id: "discord",
    name: "Discord",
    logo: "/images/integrations/discord.svg",
    category: "Community",
    description: "Community roles and moderation events.",
    access: ["Discord server", "Bot access and role permissions"],
  },
  {
    id: "pterodactyl",
    name: "Pterodactyl",
    logo: "/images/integrations/pterodactyl.svg",
    category: "Server management",
    description: "Server state and power controls.",
    access: ["Panel URL", "Scoped Client API key"],
  },
  {
    id: "battlemetrics",
    name: "BattleMetrics",
    logo: "/images/integrations/battlemetrics.png",
    category: "Player activity",
    description: "Server listings and player activity.",
    access: ["API token", "Organization and server identifiers"],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    logo: "/images/integrations/cloudflare.svg",
    category: "Network",
    description: "DNS records used by your Rust services.",
    access: ["Scoped API token", "Selected zone access"],
  },
  {
    id: "github",
    name: "GitHub",
    logo: "/images/integrations/github.svg",
    category: "Source control",
    description: "Configuration and plugin releases from a repository.",
    access: ["GitHub App installation", "Selected repository access"],
  },
] as const;
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed.";

export function OrganizationConnections({ identity }: { identity: Identity }) {
  const organization = identity.organization?.id;
  const canManage = identity.permissions.includes("integrations.manage");
  const [connection, setConnection] = useState<PelicanConnection | null>(null);
  const [loading, setLoading] = useState(canManage);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const browseRef = useRef<HTMLButtonElement>(null);
  const [requirements, setRequirements] = useState<
    (typeof catalog)[number] | null
  >(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [panelUrl, setPanelUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [formError, setFormError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const load = useCallback(async () => {
    if (!organization || !canManage) return;
    try {
      const result = await apiRequest<PelicanConnection | null>(
        "integrations/pelican",
        undefined,
        organization,
      );
      setConnection(result);
      setError("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [organization, canManage]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!busy && !editing && !removing) void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load, busy, editing, removing]);
  function edit(trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setPanelUrl(connection?.panelUrl ?? "");
    setApiKey("");
    setFormError("");
    setEditing(true);
  }
  function closeEditor() {
    if (busy) return;
    setEditing(false);
    setApiKey("");
    setFormError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !organization) return;
    let url: URL;
    try {
      url = new URL(panelUrl.trim());
    } catch {
      setFormError("Enter a complete HTTPS panel URL.");
      urlRef.current?.focus();
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      setFormError(
        "Use the HTTPS panel origin without a path, login details, query, or fragment.",
      );
      urlRef.current?.focus();
      return;
    }
    if ((!connection || url.href !== connection.panelUrl) && !apiKey) {
      setFormError("Enter a Client API key for this panel.");
      keyRef.current?.focus();
      return;
    }
    if (
      apiKey &&
      (apiKey.length < 16 ||
        apiKey.length > 512 ||
        !/^[\x21-\x7e]+$/.test(apiKey))
    ) {
      setFormError(
        "Enter a Client API key of 16 to 512 characters without spaces.",
      );
      keyRef.current?.focus();
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const result = await apiRequest<PelicanConnection>(
        "integrations/pelican",
        {
          panelUrl: url.href,
          apiKey: apiKey || null,
          id: connection?.id ?? null,
          revision: connection?.revision ?? null,
        },
        organization,
      );
      setConnection(result);
      setError("");
      setApiKey("");
      setEditing(false);
      setNow(Date.now());
      if (!result.error) toast.success("Pelican connection verified.");
    } catch (cause) {
      setFormError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    if (busy || !connection || !organization) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<PelicanConnection>(
        "integrations/pelican/check",
        { id: connection.id, revision: connection.revision },
        organization,
      );
      setConnection(result);
      setNow(Date.now());
      if (!result.error) toast.success("Pelican inventory refreshed.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    if (busy || !connection || !organization) return;
    setBusy(true);
    setFormError("");
    try {
      await apiRequest(
        "integrations/pelican/remove",
        { id: connection.id, revision: connection.revision },
        organization,
      );
      setConnection(null);
      setRemoving(false);
      setError("");
      toast.success("Pelican disconnected.");
    } catch (cause) {
      setFormError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  const status = connection ? pelicanStatus(connection, now) : null;
  const filtered = catalog.filter(
    (service) =>
      !(connection && service.id === "pelican") &&
      `${service.name} ${service.category} ${service.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  if (!canManage)
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          You need integration management permission to view or change
          connections.
        </p>
      </div>
    );
  return (
    <>
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          ref={browseRef}
          onClick={() => {
            setQuery("");
            setBrowsing(true);
          }}
        >
          Browse connections <ArrowRightIcon aria-hidden="true" />
        </Button>
      </header>
      {error && (
        <div
          role="alert"
          className="mb-5 flex flex-wrap items-center gap-3 text-sm text-destructive"
        >
          <p>{error}</p>
          <Button
            variant="outline"
            disabled={busy || loading}
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            Reload connections
          </Button>
        </div>
      )}
      <section aria-label="Connected services">
        {loading ? (
          <div aria-label="Loading connections" className="space-y-3">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : connection ? (
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated">
                  <Image
                    src="/images/integrations/pelican.png"
                    alt=""
                    width={32}
                    height={32}
                    className="size-8 object-contain"
                  />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">Pelican Panel</h3>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          tabIndex={0}
                          variant="outline"
                          className={
                            status === "Connected"
                              ? "border-primary/30 text-primary"
                              : "border-warning/40 text-warning"
                          }
                        >
                          <span>{status}</span>
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        Last checked{" "}
                        {formatDistance(connection.checkedAt, now, {
                          addSuffix: true,
                        })}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      className="size-11"
                      aria-label={
                        busy && !editing && !removing
                          ? "Checking Pelican..."
                          : "Pelican connection actions"
                      }
                      disabled={busy}
                      ref={menuTriggerRef}
                    >
                      <MoreHorizontalIcon aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    onCloseAutoFocus={(event) => {
                      if (editing || removing) event.preventDefault();
                    }}
                  >
                    <DropdownMenuItem onSelect={() => void check()}>
                      <RefreshCwIcon aria-hidden="true" />
                      Refresh
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        if (menuTriggerRef.current)
                          edit(menuTriggerRef.current);
                      }}
                    >
                      <PencilIcon aria-hidden="true" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        triggerRef.current = menuTriggerRef.current;
                        setFormError("");
                        setRemoving(true);
                      }}
                    >
                      <UnplugIcon aria-hidden="true" />
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            {connection.error && (
              <p role="alert" className="px-5 pb-4 text-sm text-warning">
                {connection.error}
              </p>
            )}
            <div className="border-t border-border p-5">
              <h4 className="text-sm font-medium">Accessible servers</h4>
              {!connection.lastSuccessAt ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Verify the connection to load server inventory.
                </p>
              ) : connection.servers.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  No servers are assigned to this Pelican account. Assign
                  servers in the panel, then check the connection.
                </p>
              ) : (
                <Table className="mt-3">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Server</TableHead>
                      <TableHead className="hidden md:table-cell">
                        Node
                      </TableHead>
                      <TableHead>Panel state</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {connection.servers.map((server) => (
                      <TableRow key={server.uuid}>
                        <TableCell className="max-w-44 whitespace-normal break-words">
                          <span className="font-medium">{server.name}</span>
                          <span className="mt-1 block text-xs text-muted-foreground md:hidden">
                            {server.node}
                          </span>
                        </TableCell>
                        <TableCell className="hidden max-w-44 whitespace-normal break-words text-muted-foreground md:table-cell">
                          {server.node}
                        </TableCell>
                        <TableCell>
                          {server.suspended
                            ? "Suspended"
                            : server.installing
                              ? "Installing"
                              : server.transferring
                                ? "Transferring"
                                : "Available"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        ) : (
          !error && (
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-medium">No connected services</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Connect Pelican Panel to verify access and load your server
                inventory.
              </p>
            </div>
          )
        )}
      </section>
      <Dialog open={browsing} onOpenChange={setBrowsing}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden sm:max-w-2xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!editing && !requirements) browseRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Available connections</DialogTitle>
            <DialogDescription className="sr-only">
              Search services and choose a connection or view its setup
              requirements.
            </DialogDescription>
          </DialogHeader>
          <InputGroup className="h-11 w-full bg-input-background">
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search connections"
              aria-label="Search available connections"
            />
          </InputGroup>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <p role="status" className="sr-only">
              {filtered.length} available connections
            </p>
            {filtered.length ? (
              <ul className="overflow-hidden rounded-xl border border-border bg-card">
                {filtered.map((service) => (
                  <li
                    key={service.id}
                    className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-border px-5 py-4 last:border-b-0"
                  >
                    <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface-elevated">
                      <Image
                        src={service.logo}
                        alt=""
                        width={28}
                        height={28}
                        className="size-7 object-contain"
                      />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h3 className="text-sm font-medium">{service.name}</h3>
                        <p className="hidden text-xs text-text-muted sm:block">
                          {service.category}
                        </p>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {service.description}
                      </p>
                    </div>
                    <div className="max-sm:col-start-2 max-sm:col-end-4">
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={loading || busy || Boolean(error)}
                        aria-label={
                          service.id === "pelican"
                            ? "Connect Pelican Panel"
                            : `View ${service.name} requirements`
                        }
                        onClick={(event) => {
                          if (service.id === "pelican") {
                            setBrowsing(false);
                            edit(browseRef.current ?? event.currentTarget);
                          } else {
                            triggerRef.current = event.currentTarget;
                            setRequirements(service);
                          }
                        }}
                      >
                        {service.id === "pelican" ? "Connect" : "Requirements"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-xl bg-card/50 px-5 py-10 text-center">
                <h3 className="text-sm font-medium">No connections found</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Try a service name or category.
                </p>
                <Button
                  variant="secondary"
                  className="mt-4 min-h-11"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  Clear search
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => event.preventDefault()}
          showCloseButton={!busy}
        >
          <DialogHeader>
            <DialogTitle>
              {connection ? "Edit Pelican connection" : "Connect Pelican Panel"}
            </DialogTitle>
            <DialogDescription>
              Use a dedicated Pelican account assigned only to the servers this
              organization should see. Create its key under Account → API
              credentials. Cupboard reads server inventory, live resources, and
              console output. Authorized operators can send console commands and
              start, stop, or restart imported servers. Grant only the server
              permissions you need: startup read for Rust connection discovery,
              resource and console read for monitoring, console write for
              commands, and start, stop, and restart for power controls.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-5" noValidate>
            <div className="space-y-2">
              <Label htmlFor="pelican-url">Panel URL</Label>
              <Input
                ref={urlRef}
                id="pelican-url"
                type="url"
                placeholder="https://panel.example.com"
                autoComplete="off"
                value={panelUrl}
                onChange={(event) => setPanelUrl(event.target.value)}
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                Use HTTPS with a trusted certificate. Private panel origins must
                be approved by the Cupboard operator.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pelican-key">Client API key</Label>
              <Input
                ref={keyRef}
                id="pelican-key"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                {connection
                  ? "Leave blank to keep the saved key for this panel. "
                  : ""}
                The key is encrypted on the server and is never shown again.
              </p>
            </div>
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={closeEditor}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Verifying Pelican..." : "Save and verify"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={removing}
        onOpenChange={(open) => {
          if (!busy) {
            setRemoving(open);
            setFormError("");
          }
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Disconnect Pelican Panel?</DialogTitle>
            <DialogDescription>
              Remove the saved key and server inventory for{" "}
              {connection?.panelUrl}. Servers in Pelican remain running. You can
              reconnect with a new key.
            </DialogDescription>
          </DialogHeader>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              {busy ? "Disconnecting..." : "Disconnect Pelican"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(requirements)}
        onOpenChange={(open) => {
          if (!open) setRequirements(null);
        }}
      >
        {requirements && (
          <DialogContent
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              titleRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle
                ref={titleRef}
                tabIndex={-1}
                className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {requirements.name} requirements
              </DialogTitle>
              <DialogDescription>
                {requirements.name} cannot be connected yet. Cupboard will not
                request credentials or connect this account.
              </DialogDescription>
            </DialogHeader>
            <div>
              <h3 className="text-sm font-medium">Requirements</h3>
              <ul className="mt-2 space-y-2">
                {requirements.access.map((item) => (
                  <li key={item} className="text-sm text-muted-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Close</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
