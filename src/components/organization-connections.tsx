"use client";

import { useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  ArrowRightIcon,
  CloudIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ConnectionStatus = "connected" | "attention";

type ConnectedService = {
  id: string;
  name: string;
  icon: LucideIcon;
  purpose: string;
  account: string;
  status: ConnectionStatus;
  statusDetail: string;
  lastChecked: string;
  access: readonly string[];
};

type CatalogService = {
  id: string;
  name: string;
  icon: LucideIcon;
  category: string;
  description: string;
  access: readonly string[];
};

const connectedServices: readonly ConnectedService[] = [
  {
    id: "discord",
    name: "Discord",
    icon: MessageSquareIcon,
    purpose: "Community roles and moderation events",
    account: "Northstar Rust",
    status: "connected",
    statusDetail: "Sync healthy",
    lastChecked: "2 minutes ago",
    access: ["Read server and role details", "Manage linked member roles"],
  },
  {
    id: "pelican",
    name: "Pelican Panel",
    icon: ServerIcon,
    purpose: "Server status and power controls",
    account: "Operations panel",
    status: "attention",
    statusDetail: "API key rejected",
    lastChecked: "18 minutes ago",
    access: ["Read server status", "Send approved power actions"],
  },
] as const;

const catalogServices: readonly CatalogService[] = [
  {
    id: "pterodactyl",
    name: "Pterodactyl",
    icon: ServerIcon,
    category: "Server management",
    description: "Inspect server state and run approved power actions.",
    access: ["Panel URL", "Application API key", "Selected server access"],
  },
  {
    id: "battlemetrics",
    name: "BattleMetrics",
    icon: ActivityIcon,
    category: "Player activity",
    description: "Bring server listings and player activity into Cupboard.",
    access: ["API token", "Organization and server identifiers"],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    icon: CloudIcon,
    category: "Network",
    description: "Review DNS records used by your Rust services.",
    access: ["Scoped API token", "Selected zone access"],
  },
  {
    id: "github",
    name: "GitHub",
    icon: GitBranchIcon,
    category: "Source control",
    description: "Track configuration and plugin releases from a repository.",
    access: ["GitHub App installation", "Selected repository access"],
  },
] as const;

type SelectedService =
  | { kind: "connected"; service: ConnectedService }
  | { kind: "catalog"; service: CatalogService };

function ServiceIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated text-muted-foreground">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

function StatusBadge({ status }: { status: ConnectionStatus }) {
  if (status === "connected") {
    return (
      <Badge
        variant="outline"
        className="border-primary/20 bg-primary/5 text-primary"
      >
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        Connected
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="border-warning/40 bg-warning/10 text-warning"
    >
      <TriangleAlertIcon aria-hidden="true" />
      Needs attention
    </Badge>
  );
}

export function OrganizationConnections() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SelectedService>();
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const filteredCatalog = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return catalogServices;
    return catalogServices.filter((service) =>
      `${service.name} ${service.category} ${service.description}`
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [query]);

  return (
    <>
      <h1 className="mb-5 text-2xl font-semibold tracking-tight">
        Connections
      </h1>

      <Tabs defaultValue="connected" className="gap-4">
        <TabsList
          aria-label="Connection sections"
          className="h-9! gap-1 rounded-lg bg-surface-elevated p-1"
        >
          <TabsTrigger
            value="connected"
            className="h-7 rounded-md px-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <ServerIcon /> Connected
          </TabsTrigger>
          <TabsTrigger
            value="available"
            className="h-7 rounded-md px-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <PlusIcon /> Available
          </TabsTrigger>
        </TabsList>

        <TabsContent value="connected">
          <section aria-labelledby="connected-heading">
            <h2 id="connected-heading" className="sr-only">
              Connected services
            </h2>

            <ul className="overflow-hidden rounded-xl border border-border bg-card">
              {connectedServices.map((service) => (
                <li
                  key={service.id}
                  className="border-b border-border last:border-b-0"
                >
                  <button
                    type="button"
                    aria-label={`${service.status === "connected" ? "Manage" : "Resolve"} ${service.name}`}
                    aria-describedby={`${service.id}-connection-details ${service.id}-last-checked`}
                    onClick={() => setSelected({ kind: "connected", service })}
                    className={`group grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 border-l-2 px-3 py-2.5 text-left outline-none transition-colors focus-visible:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 sm:grid-cols-[auto_minmax(0,1fr)_7.5rem_5.75rem] ${
                      service.status === "attention"
                        ? "border-l-warning/60 hover:bg-surface-elevated/50"
                        : "border-l-transparent hover:bg-surface-elevated/50"
                    }`}
                  >
                    <ServiceIcon icon={service.icon} />
                    <div
                      id={`${service.id}-connection-details`}
                      className="min-w-0"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">
                          {service.name}
                        </span>
                        <StatusBadge status={service.status} />
                      </div>
                      <p className="mt-0.5 truncate text-sm text-muted-foreground">
                        {service.purpose}
                      </p>
                      <p className="mt-1 text-xs text-text-muted">
                        <span className="text-muted-foreground">
                          {service.account}
                        </span>
                        <span className="px-1.5" aria-hidden="true">
                          ·
                        </span>
                        {service.statusDetail}
                      </p>
                    </div>
                    <span
                      id={`${service.id}-last-checked`}
                      className="col-start-2 whitespace-nowrap pr-2 text-[11px] leading-4 text-text-muted sm:col-start-auto sm:text-right"
                    >
                      Checked {service.lastChecked}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`col-start-2 inline-flex h-8 w-fit items-center justify-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-colors group-hover:border-border-strong sm:col-start-auto sm:w-full [@media(any-pointer:coarse)]:h-11 ${
                        service.status === "attention"
                          ? "border-warning/40 text-warning"
                          : "border-border bg-input-background text-foreground"
                      }`}
                    >
                      {service.status === "connected" ? "Manage" : "Resolve"}
                      <ArrowRightIcon className="size-4" aria-hidden="true" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </TabsContent>

        <TabsContent value="available">
          <section aria-labelledby="catalog-heading">
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 id="catalog-heading" className="sr-only">
                Available connections
              </h2>
              <div className="w-full sm:ml-auto sm:w-64">
                <InputGroup className="h-10 bg-input-background [@media(any-pointer:coarse)]:h-11">
                  <InputGroupAddon>
                    <SearchIcon aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="connection-search"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search connections"
                    aria-label="Search available connections"
                  />
                </InputGroup>
              </div>
            </div>

            {filteredCatalog.length > 0 ? (
              <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
                {filteredCatalog.map((service) => (
                  <li
                    key={service.id}
                    className="flex h-[184px] flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-border-strong [@media(any-pointer:coarse)]:h-[196px]"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <ServiceIcon icon={service.icon} />
                      <Badge
                        variant="outline"
                        className="-mt-0.5 -mr-0.5 border-transparent bg-surface-elevated/50 font-normal text-text-muted"
                      >
                        {service.category}
                      </Badge>
                    </div>
                    <h3 className="mt-3 font-medium">{service.name}</h3>
                    <p className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
                      {service.description}
                    </p>
                    <Button
                      variant="ghost"
                      className="mt-auto h-8 self-start px-0 text-primary hover:bg-transparent hover:text-primary [@media(any-pointer:coarse)]:h-11"
                      aria-label={`Set up ${service.name}`}
                      onClick={() => setSelected({ kind: "catalog", service })}
                    >
                      Set up
                      <ArrowRightIcon data-icon="inline-end" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-xl bg-card/50 px-5 py-10 text-center">
                <SearchIcon
                  className="mx-auto size-5 text-text-muted"
                  aria-hidden="true"
                />
                <h3 className="mt-3 text-sm font-medium">
                  No connections found
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Try a service name or category.
                </p>
                <Button
                  variant="secondary"
                  className="mt-4"
                  onClick={() => setQuery("")}
                >
                  Clear search
                </Button>
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(undefined)}
      >
        {selected && (
          <DialogContent
            aria-describedby={undefined}
            className="gap-3 sm:max-w-sm"
            showCloseButton={false}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              dialogTitleRef.current?.focus();
            }}
          >
            <DialogHeader>
              <div className="flex items-center gap-3">
                <ServiceIcon icon={selected.service.icon} />
                <DialogTitle
                  ref={dialogTitleRef}
                  tabIndex={-1}
                  className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {selected.kind === "connected"
                    ? `${selected.service.name} connection`
                    : `Connect ${selected.service.name}`}
                </DialogTitle>
              </div>
            </DialogHeader>

            {selected.kind === "connected" && (
              <div className="flex items-center justify-between rounded-lg border border-border bg-input-background px-3 py-2.5">
                <div>
                  <p className="text-xs text-text-muted">Status</p>
                  <p className="mt-0.5 text-sm">
                    {selected.service.statusDetail}
                  </p>
                </div>
                <StatusBadge status={selected.service.status} />
              </div>
            )}

            <div>
              <h3 className="text-sm font-medium">
                {selected.kind === "connected" ? "Access" : "Requirements"}
              </h3>
              <ul className="mt-2 space-y-2">
                {selected.service.access.map((item) => (
                  <li key={item} className="text-sm text-muted-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <DialogFooter className="bg-card py-3">
              <DialogClose asChild>
                <Button
                  variant="secondary"
                  className="[@media(any-pointer:coarse)]:h-11"
                >
                  Close
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
