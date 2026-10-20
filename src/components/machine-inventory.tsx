"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DownloadIcon,
  Trash2Icon,
  ActivityIcon,
  PencilIcon,
  RefreshCwIcon,
  LinkIcon,
  UnplugIcon,
  HardDriveIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ArrowLeftIcon,
  SearchIcon,
  CheckIcon,
  CircleDotIcon,
  TagsIcon,
} from "lucide-react";
import { apiRequest, type Identity } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { MachineCountry, MachineReadings } from "@/components/machine-readings";
import { MachineTagBadges, MachineTagsDialog } from "@/components/machine-tags";
import { MachineNetwork } from "@/components/machine-network";
import { MachineMonitoring } from "@/components/machine-monitoring";
import {
  validMachineIp,
  machineStatus,
  observed,
  type Machine,
  type MachineTag,
} from "@/lib/machines";
import { toast } from "sonner";

const empty = { name: "", address: "", provider: "", notes: "" };
const labels = {
  name: "Machine name",
  address: "IP address (IPv4 or IPv6)",
  provider: "Provider",
  notes: "Notes",
};
const errorMessage = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "The request could not be completed.";
export function MachineInventory({ identity }: { identity: Identity }) {
  const organization = identity.organization?.id;
  const view = identity.permissions.includes("infrastructure.view");
  const manage = identity.permissions.includes("infrastructure.manage");
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(view);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [tagMachine, setTagMachine] = useState<Machine | null>(null);
  const [tagCatalog, setTagCatalog] = useState<MachineTag[]>([]);
  const [editor, setEditor] = useState<Machine | null>(null);
  const [draft, setDraft] = useState(empty);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const [provider, setProvider] = useState("all");
  const [action, setAction] = useState<{
    machine: Machine;
    kind: "enroll" | "disconnect" | "remove";
  } | null>(null);
  const [token, setToken] = useState<{
    token: string;
    expiresAt: number;
    issuedAt: number;
  } | null>(null);
  const [actionError, setActionError] = useState("");
  const [acting, setActing] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const mutation = useRef(false);
  const refreshFailed = useRef(false);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const records = await apiRequest<Machine[]>(
        "machines",
        undefined,
        organization!,
      );
      if (mounted.current && current === generation.current) {
        setMachines(records);
        if (records.some((machine) => machine.tags?.length)) {
          try {
            const tags = await apiRequest<MachineTag[]>(
              "machines/tags",
              undefined,
              organization!,
            );
            if (mounted.current && current === generation.current)
              setTagCatalog(tags);
          } catch {
            /* Preserve last known tag labels during a refresh failure. */
          }
        }
        setError("");
        refreshFailed.current = false;
        setNow(Date.now());
      }
    } catch (cause) {
      if (mounted.current && current === generation.current) {
        setError(errorMessage(cause));
        if (!refreshFailed.current)
          toast.error("Couldn’t refresh machines.", {
            description: "Retrying automatically.",
            position: "top-right",
            duration: 4000,
          });
        refreshFailed.current = true;
      }
    } finally {
      if (mounted.current && current === generation.current)
        setRefreshing(false);
    }
  }, [organization]);
  useEffect(() => {
    mounted.current = true;
    const initial = setTimeout(() => {
      if (view) void load();
    }, 0);
    const poll = setInterval(() => {
      if (view) void load();
      setNow(Date.now());
    }, 30_000);
    return () => {
      mounted.current = false;
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [view, load]);
  useEffect(() => {
    if (saving) return;
    const field = Object.keys(labels).find((key) => fields[key]);
    if (field)
      form.current?.querySelector<HTMLElement>(`#machine-${field}`)?.focus();
  }, [fields, saving]);
  function edit(machine: Machine) {
    setEditor(machine);
    setDraft({
      name: machine.name,
      address: machine.address,
      provider: machine.provider,
      notes: machine.notes,
    });
    setFields({});
    setFormError("");
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (mutation.current || !editor) return;
    if (!validMachineIp(draft.address)) {
      setFields({ address: "Enter a valid IPv4 or IPv6 address." });
      form.current?.querySelector<HTMLElement>("#machine-address")?.focus();
      return;
    }

    mutation.current = true;
    setSaving(true);
    setFields({});
    setFormError("");
    try {
      const response = await fetch(`/app-api/machines/${editor.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cupboard-Request": "1",
          "X-Cupboard-Organization": organization!,
        },
        body: JSON.stringify({
          ...draft,
          revision: editor.revision,
        }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        setFields(result.fields ?? {});
        setFormError(result.error ?? "Machine could not be saved.");
        return;
      }
      setEditor(null);
      toast.success("Machine updated.");
      if (view) await load();
    } catch {
      if (mounted.current)
        setFormError(
          "Machine could not be saved. Check your connection and try again.",
        );
    } finally {
      mutation.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  function beginAction(
    machine: Machine,
    kind: "enroll" | "disconnect" | "remove",
  ) {
    setAction({ machine, kind });
    setToken(null);
    setActionError("");
  }
  async function runAction() {
    if (!action || mutation.current) return;
    mutation.current = true;
    setActing(true);
    setActionError("");
    try {
      if (action.kind === "enroll") {
        const result = await apiRequest<{
          token: string;
          expiresAt: number;
          issuedAt: number;
        }>(`machines/${action.machine.id}/enrollment`, {}, organization!);
        if (mounted.current) setToken(result);
      } else {
        await apiRequest(
          `machines/${action.machine.id}/${action.kind}`,
          {},
          organization!,
        );
        if (mounted.current) {
          setAction(null);
          toast.success(
            action.kind === "remove"
              ? "Machine removed."
              : "Agent disconnected.",
          );
          if (action.kind === "remove") {
            setDetails(null);
            const key = `machine-setup:${identity.user.id}:${identity.organization?.id}`;
            try {
              const saved = JSON.parse(localStorage.getItem(key) || "null");
              if (saved?.machineId === action.machine.id)
                localStorage.removeItem(key);
            } catch {}
          }
        }
      }
      if (view && mounted.current) await load();
    } catch (cause) {
      if (mounted.current) setActionError(errorMessage(cause));
    } finally {
      mutation.current = false;
      if (mounted.current) setActing(false);
    }
  }
  function inspect(machine: Machine) {
    setDetails(machine.id);
  }
  const visible = machines?.filter(
    (machine) =>
      [
        machine.name,
        machine.address,
        machine.provider,
        ...tagCatalog
          .filter((tag) => machine.tags?.includes(tag.id))
          .map((tag) => tag.name),
      ].some((value) =>
        value.toLowerCase().includes(query.trim().toLowerCase()),
      ) &&
      (filter === "all" || machineStatus(machine, now) === filter) &&
      (provider === "all" || machine.provider === provider),
  );
  const selected = machines?.find((machine) => machine.id === details);
  const enrolling = machines?.find(
    (machine) => machine.id === action?.machine.id,
  );
  const agentEnrolled = Boolean(
    token &&
    enrolling?.enrolled &&
    enrolling.enrolledAt != null &&
    enrolling.enrolledAt >= token.issuedAt,
  );
  const verified = Boolean(
    agentEnrolled &&
    !error &&
    enrolling?.lastSeenAt != null &&
    enrolling.enrolledAt != null &&
    enrolling.lastSeenAt >= enrolling.enrolledAt &&
    machineStatus(enrolling, now) === "Connected",
  );
  const expired = Boolean(token && now >= token.expiresAt);
  const providers = [
    ...new Set(machines?.map((machine) => machine.provider).filter(Boolean)),
  ].sort();
  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
      {!selected && (
        <div
          className={
            machines?.length
              ? "hidden flex-wrap items-start justify-between gap-4 md:flex"
              : "flex flex-wrap items-start justify-between gap-4"
          }
        >
          <div>
            <h1 className="sr-only text-2xl font-semibold tracking-tight md:not-sr-only">
              Machines
            </h1>
          </div>
          <div className="flex gap-2">
            {manage && (
              <Button className="size-11 p-0 md:w-auto md:px-2.5" asChild>
                <Link href="/dashboard/infrastructure/machines/setup">
                  <PlusIcon className="size-4" />
                  <span className="sr-only md:not-sr-only">Add machine</span>
                </Link>
              </Button>
            )}
          </div>
        </div>
      )}
      {!view ? (
        <p className="text-sm text-muted-foreground">
          You need infrastructure viewing permission to see machines in this
          organization.
        </p>
      ) : (
        <>
          {!machines && error && (
            <p className="text-sm text-muted-foreground">
              Waiting for machine data…
            </p>
          )}
          {!machines && !error && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading machines...
            </p>
          )}
          {machines && (
            <div className="space-y-5">
              {!selected ? (
                <div className="space-y-5">
                  {machines.length > 0 ? (
                    <>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="flex w-full items-center gap-3 md:w-72 lg:mr-auto">
                          <div className="relative min-w-0 flex-1">
                            <SearchIcon className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
                            <Input
                              className="min-h-11 pl-9"
                              aria-label="Search machines"
                              placeholder="Search machines..."
                              value={query}
                              onChange={(e) => setQuery(e.target.value)}
                            />
                          </div>
                          {manage && (
                            <Button
                              size="icon"
                              className="size-11 shrink-0 md:hidden"
                              aria-label="Add machine"
                              asChild
                            >
                              <Link
                                href="/dashboard/infrastructure/machines/setup"
                                aria-label="Add machine"
                              >
                                <PlusIcon className="size-4" />
                              </Link>
                            </Button>
                          )}
                        </div>
                        <Select value={filter} onValueChange={setFilter}>
                          <SelectTrigger
                            className="min-h-11 flex-1 sm:w-44 sm:flex-none"
                            aria-label="Connection status"
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
                              "Connected",
                              "Stale",
                              "Awaiting report",
                              "Not enrolled",
                            ].map((status) => (
                              <SelectItem
                                className="min-h-11"
                                key={status}
                                value={status}
                              >
                                {status}
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
                            {providers.map((value) => (
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
                      </div>
                      {visible?.length === 0 ? (
                        <div className="space-y-3 border-y border-dashed py-12 text-center">
                          <p className="text-sm text-muted-foreground">
                            No machines match your search.
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
                        <Table
                          className="table-fixed"
                          aria-label="Machine inventory"
                        >
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="w-auto text-xs text-muted-foreground">
                                Machine
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
                            {visible?.map((machine) => {
                              return (
                                <TableRow key={machine.id}>
                                  <TableCell className="whitespace-normal py-3">
                                    <div className="flex items-start gap-3">
                                      <MachineCountry
                                        machine={machine}
                                        now={now}
                                      />
                                      <button
                                        type="button"
                                        aria-label={machine.name}
                                        onClick={() => inspect(machine)}
                                        className="group flex min-h-11 min-w-0 flex-col items-start justify-start rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                      >
                                        <span className="flex flex-wrap items-baseline gap-x-2">
                                          <span className="font-medium underline-offset-4 group-hover:underline break-words">
                                            {machine.name}
                                          </span>
                                          <MachineTagBadges
                                            machine={machine}
                                            catalog={tagCatalog}
                                          />
                                        </span>

                                        <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                                          {machine.provider && (
                                            <span>{machine.provider}</span>
                                          )}
                                          <span className="break-all font-mono">
                                            {machine.address}
                                          </span>
                                        </span>
                                      </button>
                                    </div>
                                    {machineStatus(machine, now) ===
                                      "Stale" && (
                                      <div className="mt-2 md:hidden">
                                        <LastSeen
                                          at={machine.lastSeenAt!}
                                          now={now}
                                        />
                                      </div>
                                    )}
                                  </TableCell>
                                  {!machine.enrolled ? (
                                    <TableCell
                                      colSpan={4}
                                      className="hidden md:table-cell"
                                    >
                                      <MachineStatsOverlay>
                                        {!manage && (
                                          <span className="text-xs text-muted-foreground">
                                            Agent not enrolled.
                                          </span>
                                        )}
                                        {manage && (
                                          <Button
                                            variant="link"
                                            asChild
                                            className="min-h-11 text-foreground"
                                          >
                                            <Link
                                              href={`/dashboard/infrastructure/machines/setup?machine=${machine.id}`}
                                            >
                                              <LinkIcon className="size-4" />
                                              Enroll machine
                                            </Link>
                                          </Button>
                                        )}
                                      </MachineStatsOverlay>
                                    </TableCell>
                                  ) : machineStatus(machine, now) ===
                                    "Stale" ? (
                                    <TableCell
                                      colSpan={4}
                                      className="hidden md:table-cell"
                                    >
                                      <MachineStatsOverlay>
                                        <LastSeen
                                          at={machine.lastSeenAt!}
                                          now={now}
                                        />
                                      </MachineStatsOverlay>
                                    </TableCell>
                                  ) : (
                                    <>
                                      {(
                                        ["cpu", "memory", "storage"] as const
                                      ).map((metric) => (
                                        <TableCell
                                          key={metric}
                                          className="hidden md:table-cell"
                                        >
                                          <MachineReadings
                                            machine={machine}
                                            metric={metric}
                                            now={now}
                                          />
                                        </TableCell>
                                      ))}
                                      <TableCell className="hidden md:table-cell">
                                        <MachineNetwork
                                          organization={organization!}
                                          machine={machine}
                                          now={now}
                                        />
                                      </TableCell>
                                    </>
                                  )}
                                  <TableCell className="px-0">
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="min-h-11 min-w-11"
                                          aria-label={`Actions for ${machine.name}`}
                                        >
                                          <MoreHorizontalIcon />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem
                                          onSelect={() => inspect(machine)}
                                        >
                                          <ActivityIcon aria-hidden="true" />
                                          Monitor
                                        </DropdownMenuItem>
                                        {manage && (
                                          <>
                                            <DropdownMenuItem
                                              onSelect={() => edit(machine)}
                                            >
                                              <PencilIcon aria-hidden="true" />
                                              Edit
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                              onSelect={() =>
                                                setTagMachine(machine)
                                              }
                                            >
                                              <TagsIcon aria-hidden="true" />
                                              Tags
                                            </DropdownMenuItem>
                                            {machine.enrolled && (
                                              <DropdownMenuItem
                                                onSelect={() =>
                                                  beginAction(machine, "enroll")
                                                }
                                              >
                                                <RefreshCwIcon aria-hidden="true" />
                                                Replace
                                              </DropdownMenuItem>
                                            )}
                                            {!machine.enrolled && (
                                              <DropdownMenuItem
                                                variant="destructive"
                                                onSelect={() =>
                                                  beginAction(machine, "remove")
                                                }
                                              >
                                                <Trash2Icon aria-hidden="true" />
                                                Remove
                                              </DropdownMenuItem>
                                            )}
                                            {(machine.enrolled ||
                                              machine.enrollmentExpiresAt !==
                                                null) && (
                                              <DropdownMenuItem
                                                variant="destructive"
                                                onSelect={() =>
                                                  beginAction(
                                                    machine,
                                                    "disconnect",
                                                  )
                                                }
                                              >
                                                <UnplugIcon aria-hidden="true" />
                                                Disconnect
                                              </DropdownMenuItem>
                                            )}
                                          </>
                                        )}
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      )}
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed px-6 py-12 text-center">
                      <HardDriveIcon className="mx-auto mb-4 size-8 text-muted-foreground" />
                      <h2 className="font-semibold">No machines yet</h2>
                      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                        {manage
                          ? "Add a host, then enroll its Linux agent to see health reports here."
                          : "Ask an infrastructure manager to add a machine."}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-5">
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => setDetails(null)}
                  >
                    <ArrowLeftIcon className="size-4" />
                    Back to machines
                  </Button>
                  <MachineMonitoring
                    machine={selected}
                    now={now}
                    organization={organization!}
                    manage={manage}
                    onEdit={() => edit(selected)}
                    onEnroll={() => beginAction(selected, "enroll")}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
      {tagMachine && organization && (
        <MachineTagsDialog
          key={tagMachine.id}
          machine={tagMachine}
          organization={organization}
          onClose={() => setTagMachine(null)}
          onSaved={(tags) => {
            setTagCatalog(tags);
            void load();
          }}
        />
      )}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit machine</DialogTitle>
            <DialogDescription>
              Update the name, address, provider, or notes for this machine.
            </DialogDescription>
          </DialogHeader>
          <form
            ref={form}
            onSubmit={save}
            noValidate
            className="grid gap-4 sm:grid-cols-2"
          >
            {(Object.keys(labels) as (keyof typeof labels)[]).map((field) => (
              <div key={field} className="space-y-2 sm:col-span-2">
                <Label htmlFor={`machine-${field}`}>
                  {labels[field]}
                  {["provider", "notes"].includes(field) && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · optional
                    </span>
                  )}
                </Label>
                {field === "notes" ? (
                  <Textarea
                    id={`machine-${field}`}
                    value={draft[field]}
                    disabled={saving}
                    aria-invalid={!!fields[field]}
                    aria-describedby={
                      fields[field]
                        ? `machine-${field}-error`
                        : "machine-notes-help"
                    }
                    onChange={(e) =>
                      setDraft({ ...draft, [field]: e.target.value })
                    }
                  />
                ) : (
                  <Input
                    id={`machine-${field}`}
                    className="min-h-11"
                    value={draft[field]}
                    disabled={saving}
                    autoComplete="off"
                    aria-invalid={!!fields[field]}
                    aria-describedby={
                      fields[field] ? `machine-${field}-error` : undefined
                    }
                    onChange={(e) =>
                      setDraft({ ...draft, [field]: e.target.value })
                    }
                  />
                )}
                {fields[field] && (
                  <p
                    id={`machine-${field}-error`}
                    className="text-sm text-destructive"
                  >
                    {fields[field]}
                  </p>
                )}
                {field === "notes" && (
                  <p
                    id="machine-notes-help"
                    className="text-xs text-muted-foreground"
                  >
                    Visible to infrastructure viewers. Do not include passwords
                    or tokens.
                  </p>
                )}
              </div>
            ))}
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
                onClick={() => setEditor(null)}
              >
                Cancel
              </Button>
              <Button className="min-h-11" disabled={saving}>
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !acting) {
            setAction(null);
            setToken(null);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {action?.kind === "remove"
                ? "Remove machine"
                : action?.kind === "disconnect"
                  ? "Disconnect agent"
                  : "Enroll agent"}{" "}
              · {action?.machine.name}
            </DialogTitle>
            <DialogDescription>
              {action?.kind === "remove"
                ? "Remove this unenrolled machine and cancel any pending enrollment token. This cannot be undone."
                : action?.kind === "disconnect"
                  ? "Revoke this machine's agent credential and any pending enrollment token. Health reporting stops and saved readings are cleared. The machine record remains."
                  : "Install the Linux agent on this machine. It reports health over outbound HTTPS every 30 seconds. Enrollment replaces any agent already connected to this record."}
            </DialogDescription>
          </DialogHeader>
          {action?.kind === "enroll" && (
            <ol
              aria-label="Enrollment progress"
              className="grid grid-cols-3 gap-2 border-y py-4"
            >
              {["Prepare", "Install agent", "Verify report"].map(
                (label, index) => {
                  const current = verified
                    ? 3
                    : agentEnrolled
                      ? 2
                      : token
                        ? 1
                        : 0;
                  return (
                    <li
                      key={label}
                      aria-current={index === current ? "step" : undefined}
                      className={`flex flex-col items-center gap-2 text-center text-xs sm:flex-row sm:text-left ${index <= current ? "text-foreground" : "text-muted-foreground"}`}
                    >
                      <span
                        className={`flex size-6 shrink-0 items-center justify-center rounded-full border ${index < current ? "border-primary bg-primary text-primary-foreground" : index === current ? "border-primary text-primary" : "border-border"}`}
                      >
                        {index < current ? (
                          <CheckIcon
                            className="size-3.5"
                            aria-label="Complete"
                          />
                        ) : (
                          index + 1
                        )}
                      </span>
                      {label}
                    </li>
                  );
                },
              )}
            </ol>
          )}
          {verified ? (
            <div className="space-y-5 py-2">
              <div className="flex items-start gap-3">
                <span className="rounded-full bg-primary/10 p-2 text-primary">
                  <CheckIcon className="size-5" />
                </span>
                <div>
                  <h3 className="font-semibold">Agent connected</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {action?.machine.name} sent a health report at{" "}
                    {observed(enrolling?.lastSeenAt ?? null)}.
                  </p>
                </div>
              </div>
              <Button
                className="min-h-11"
                onClick={() => {
                  if (enrolling) inspect(enrolling);
                  setAction(null);
                  setToken(null);
                }}
              >
                View monitoring
              </Button>
            </div>
          ) : token ? (
            <div className="space-y-5">
              {!agentEnrolled && (
                <div className="space-y-2">
                  <Label htmlFor="enrollment-token">Enrollment token</Label>
                  <Input
                    id="enrollment-token"
                    className="font-mono"
                    readOnly
                    value={token.token}
                    onFocus={(e) => e.target.select()}
                    autoComplete="off"
                  />
                  <p
                    className={`text-xs ${expired ? "text-warning" : "text-muted-foreground"}`}
                  >
                    {expired
                      ? "This token has expired. Generate another token before enrolling."
                      : `Single use. Expires at ${new Date(token.expiresAt).toLocaleTimeString()}. Copy it before closing this dialog.`}
                  </p>
                  {expired && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={acting}
                      onClick={() => void runAction()}
                    >
                      {acting ? "Generating..." : "Generate new token"}
                    </Button>
                  )}
                </div>
              )}
              <div className="space-y-4 text-sm">
                <div>
                  <h3 className="font-medium">Install on the machine</h3>
                  <p className="mt-1 text-muted-foreground">
                    Linux with Python 3.10 or later. The agent needs outbound
                    HTTPS access to Cupboard.
                  </p>
                  <a
                    className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    href="/agent/cupboard-agent.py"
                    download
                  >
                    <DownloadIcon className="size-4" />
                    Download the Linux agent
                  </a>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Use your Cupboard HTTPS address. Paste the token at the
                    hidden prompt.
                  </p>
                  <pre className="mt-2 whitespace-pre-wrap break-all rounded-md border bg-input-background p-3 text-xs leading-6">
                    <code>
                      python3 cupboard-agent.py enroll --url
                      https://YOUR-CUPBOARD-HOST
                    </code>
                  </pre>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Start reporting and keep this process running.
                  </p>
                  <pre className="mt-2 whitespace-pre-wrap break-all rounded-md border bg-input-background p-3 text-xs leading-6">
                    <code>python3 cupboard-agent.py run</code>
                  </pre>
                </div>
              </div>
              <div
                role="status"
                className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4"
              >
                <CircleDotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">
                    {agentEnrolled
                      ? "Waiting for the first report"
                      : "Waiting for agent enrollment"}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {error
                      ? "The connection check could not refresh. Try again to verify the agent."
                      : "This dialog updates when the machine sends its first health report."}
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The credential stays in ~/.config/cupboard-agent on the machine.
                Follow the{" "}
                <a
                  href="/agent/setup.txt"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  service setup instructions
                </a>{" "}
                to report after reboot.
              </p>
              {actionError && (
                <Alert variant="destructive">
                  <AlertDescription>{actionError}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={refreshing}
                  onClick={() => {
                    setRefreshing(true);
                    void load();
                  }}
                >
                  {refreshing ? "Checking..." : "Check for report"}
                </Button>
                <Button
                  className="min-h-11"
                  disabled={acting}
                  onClick={() => {
                    setAction(null);
                    setToken(null);
                  }}
                >
                  Close enrollment
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {action?.kind === "remove"
                  ? `Remove ${action.machine.name} from this organization?`
                  : action?.kind === "enroll"
                    ? "Generate a token when you are ready to install the agent. It expires in 10 minutes. Generating another token invalidates the previous unused token."
                    : "To reconnect later, generate a new token and enroll the machine again."}
              </p>
              {actionError && (
                <Alert variant="destructive">
                  <AlertDescription>{actionError}</AlertDescription>
                </Alert>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={acting}
                  onClick={() => setAction(null)}
                >
                  Cancel
                </Button>
                <Button
                  className="min-h-11"
                  variant={
                    action?.kind !== "enroll" ? "destructive" : "default"
                  }
                  disabled={acting}
                  onClick={() => void runAction()}
                >
                  {acting
                    ? "Working..."
                    : action?.kind === "remove"
                      ? "Remove machine"
                      : action?.kind === "disconnect"
                        ? "Disconnect agent"
                        : "Generate token"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function LastSeen({ at, now }: { at: number; now: number }) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const [amount, unit] =
    seconds >= 86400
      ? ([Math.floor(seconds / 86400), "day"] as const)
      : seconds >= 3600
        ? ([Math.floor(seconds / 3600), "hour"] as const)
        : seconds >= 60
          ? ([Math.floor(seconds / 60), "minute"] as const)
          : ([seconds, "second"] as const);
  const relative = new Intl.RelativeTimeFormat("en", {
    numeric: "always",
  }).format(-amount, unit);
  return (
    <p className="text-center text-xs text-foreground">
      Last seen {relative}{" "}
      <time dateTime={new Date(at).toISOString()} className="inline-block">
        ({observed(at)})
      </time>
    </p>
  );
}

function MachineStatsOverlay({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-14 items-center justify-center overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 grid grid-cols-[2fr_2fr_2fr_3fr] items-center gap-4"
      >
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3 w-12 motion-reduce:animate-none" />
            <Skeleton
              className={`${index === 3 ? "h-8" : "h-1.5"} w-full motion-reduce:animate-none`}
            />
          </div>
        ))}
      </div>
      <div className="relative z-10 px-3 py-2 whitespace-normal">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-8 -inset-y-3 bg-background/70 backdrop-blur-md [mask-image:radial-gradient(ellipse,black_35%,transparent_75%)]"
        />
        <div className="relative">{children}</div>
      </div>
    </div>
  );
}
