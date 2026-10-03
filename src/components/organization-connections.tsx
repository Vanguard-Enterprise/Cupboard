"use client";

import { useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  ArrowRightIcon,
  CloudIcon,
  GitBranchIcon,
  MessageSquareIcon,
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
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
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Review connected services and explore integrations for your
            organization.
          </p>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => searchRef.current?.focus()}
        >
          Browse connections <ArrowRightIcon aria-hidden="true" />
        </Button>
      </header>

      <section aria-labelledby="connected-heading">
        <div className="mb-4 flex items-center gap-2">
          <h2 id="connected-heading" className="text-base font-semibold">
            Connected services
          </h2>
          <span className="text-sm text-muted-foreground">
            {connectedServices.length}
          </span>
        </div>
        <ul className="overflow-hidden rounded-xl border border-border bg-card">
          {[...connectedServices]
            .sort(
              (a, b) =>
                Number(b.status === "attention") -
                Number(a.status === "attention"),
            )
            .map((service) => (
              <li
                key={service.id}
                className={`grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 border-b border-l-2 p-4 last:border-b-0 lg:grid-cols-[auto_minmax(0,1fr)_11rem_auto] lg:items-center ${service.status === "attention" ? "border-l-warning/60" : "border-l-transparent"}`}
              >
                <ServiceIcon icon={service.icon} />
                <div className="min-w-0">
                  <h3 className="font-medium">{service.name}</h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {service.account}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-text-muted">
                    {service.purpose}
                  </p>
                </div>
                <div className="col-start-2 lg:col-start-auto">
                  <StatusBadge status={service.status} />
                  <p
                    className={`mt-1.5 text-sm ${service.status === "attention" ? "text-warning" : "text-muted-foreground"}`}
                  >
                    {service.statusDetail}
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    Checked {service.lastChecked}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="col-start-2 min-h-11 justify-self-start lg:col-start-auto"
                  aria-label={`View ${service.name} details`}
                  onClick={(event) => {
                    triggerRef.current = event.currentTarget;
                    setSelected({ kind: "connected", service });
                  }}
                >
                  View details <ArrowRightIcon aria-hidden="true" />
                </Button>
              </li>
            ))}
        </ul>
      </section>

      <section
        aria-labelledby="catalog-heading"
        className="mt-10 border-t border-border pt-8"
      >
        <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="catalog-heading" className="text-base font-semibold">
              Available connections
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Find a service and review what you need to connect it.
            </p>
          </div>
          <InputGroup className="h-11 w-full bg-input-background sm:w-64">
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              id="connection-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search connections"
              aria-label="Search available connections"
            />
          </InputGroup>
        </div>
        <p role="status" className="sr-only">
          {filteredCatalog.length} available connections
        </p>
        {filteredCatalog.length > 0 ? (
          <ul className="grid gap-4 md:grid-cols-2">
            {filteredCatalog.map((service) => (
              <li
                key={service.id}
                className="flex flex-col rounded-xl border border-border bg-card p-5"
              >
                <div className="flex items-center gap-3">
                  <ServiceIcon icon={service.icon} />
                  <div>
                    <h3 className="font-medium">{service.name}</h3>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {service.category}
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-6 text-muted-foreground">
                  {service.description}
                </p>
                <div className="mt-auto pt-4">
                  <Button
                    variant="outline"
                    className="min-h-11"
                    aria-label={`View ${service.name} requirements`}
                    onClick={(event) => {
                      triggerRef.current = event.currentTarget;
                      setSelected({ kind: "catalog", service });
                    }}
                  >
                    View requirements <ArrowRightIcon aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-xl bg-card/50 px-5 py-10 text-center">
            <SearchIcon
              className="mx-auto size-5 text-text-muted"
              aria-hidden="true"
            />
            <h3 className="mt-3 text-sm font-medium">No connections found</h3>
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
      </section>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(undefined)}
      >
        {selected && (
          <DialogContent
            className="gap-5 sm:max-w-md"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus();
            }}
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
                    : `${selected.service.name} requirements`}
                </DialogTitle>
              </div>
              <DialogDescription>
                {selected.kind === "connected"
                  ? "This status is sample data. Cupboard has not checked or changed this account."
                  : "These requirements are sample data. Cupboard will not request credentials or connect this account."}
              </DialogDescription>
            </DialogHeader>

            {selected.kind === "connected" && (
              <div className="space-y-3 rounded-lg border border-border bg-input-background p-4">
                <div>
                  <p className="text-xs text-text-muted">Linked account</p>
                  <p className="mt-1 text-sm">{selected.service.account}</p>
                </div>
                <div>
                  <p className="text-xs text-text-muted">Status</p>
                  <p className="mt-0.5 text-sm">
                    {selected.service.statusDetail}
                  </p>
                </div>
                <StatusBadge status={selected.service.status} />
                <p className="text-xs text-text-muted">
                  Checked {selected.service.lastChecked}
                </p>
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
                <Button variant="secondary" className="min-h-11">
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
