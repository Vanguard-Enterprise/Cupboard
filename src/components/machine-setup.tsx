"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, CheckIcon, DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { apiRequest, type Identity } from "@/lib/api-client";
import {
  validMachineIp,
  machineStatus,
  observed,
  type Machine,
} from "@/lib/machines";

const base = "/dashboard/infrastructure/machines";
const empty = { name: "", address: "", provider: "", notes: "" };
const labels = {
  name: "Machine name",
  address: "IP address (IPv4 or IPv6)",
  provider: "Provider",
  notes: "Notes",
};
type Draft = typeof empty;
type Token = { token: string; expiresAt: number; issuedAt: number };

export function MachineSetup({
  identity,
  initialMachineId = null,
}: {
  identity: Identity;
  initialMachineId?: string | null;
}) {
  const allowed =
    !!identity.organization &&
    ["infrastructure.view", "infrastructure.manage"].every((p) =>
      identity.permissions.includes(p),
    );
  const storageKey = `machine-setup:${identity.user.id}:${identity.organization?.id}`;
  const [draft, setDraft] = useState(empty);
  const [machineId, setMachineId] = useState(initialMachineId);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [token, setToken] = useState<Token | null>(null);
  const [now, setNow] = useState(Date.now);
  const form = useRef<HTMLFormElement>(null);
  const saving = useRef(false);

  function store(value: Draft, id: string | null) {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ draft: value, machineId: id }),
      );
    } catch {
      /* The saved machine still persists on the server. */
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!allowed) return;
      if (!initialMachineId) {
        try {
          const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
          if (
            saved &&
            Object.keys(empty).every(
              (key) => typeof saved.draft?.[key] === "string",
            )
          ) {
            setDraft(saved.draft);
            if (typeof saved.machineId === "string") {
              setMachineId(saved.machineId);
              window.history.replaceState(
                null,
                "",
                `${base}/setup?machine=${encodeURIComponent(saved.machineId)}`,
              );
            }
          }
        } catch {
          /* An invalid browser draft does not prevent setup. */
        }
      }
      setReady(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [allowed, initialMachineId, storageKey]);

  useEffect(() => {
    if (!allowed || !machineId) return;
    let active = true;
    async function load() {
      try {
        const records = await apiRequest<Machine[]>("machines");
        const record = records.find((m) => m.id === machineId);
        if (!record)
          throw Error(
            "This machine is unavailable in the current organization.",
          );
        if (active) {
          setMachine(record);
          setLoadError("");
          setNow(Date.now());
        }
      } catch (cause) {
        if (active)
          setLoadError(
            cause instanceof Error
              ? cause.message
              : "Could not check the machine.",
          );
      }
    }
    void load();
    const interval = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [allowed, machineId]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (saving.current || machineId) return;
    if (!validMachineIp(draft.address)) {
      setFields({ address: "Enter a valid IPv4 or IPv6 address." });
      form.current?.querySelector<HTMLElement>("#setup-address")?.focus();
      return;
    }

    saving.current = true;
    setBusy(true);
    setError("");
    setFields({});
    try {
      const response = await fetch("/app-api/machines", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cupboard-Request": "1",
        },
        body: JSON.stringify({ ...draft, revision: null }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) {
        setFields(result.fields ?? {});
        setError(result.error ?? "Machine could not be saved.");
        const first = Object.keys(labels).find((key) => result.fields?.[key]);
        if (first)
          form.current?.querySelector<HTMLElement>(`#setup-${first}`)?.focus();
        return;
      }
      const record = result as Machine;
      store(draft, record.id);
      window.history.replaceState(
        null,
        "",
        `${base}/setup?machine=${encodeURIComponent(record.id)}`,
      );
      setMachine(record);
      setMachineId(record.id);
    } catch {
      setError(
        "Machine could not be saved. Check your connection and try again.",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function startAnother() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Browser storage may be disabled. */
    }
    setMachineId(null);
    setMachine(null);
    setDraft(empty);
    setToken(null);
    setFields({});
    setError("");
    setLoadError("");
    window.history.replaceState(null, "", base + "/setup");
  }

  async function generate() {
    if (!machineId || saving.current || machine?.enrolled) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<Token>(
        `machines/${machineId}/enrollment`,
        {},
      );
      setToken(result);
      setNow(Date.now());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not generate an enrollment token.",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const connected =
    !!machine?.enrolled &&
    !!machine.health &&
    machine.enrolledAt != null &&
    machine.lastSeenAt != null &&
    machine.lastSeenAt >= machine.enrolledAt &&
    machineStatus(machine, now) === "Connected" &&
    !loadError;
  useEffect(() => {
    if (connected) {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* Browser storage may be disabled. */
      }
    }
  }, [connected, storageKey]);
  const step = !machineId ? 0 : machine?.enrolled ? 2 : 1;
  const expired = token != null && token.expiresAt <= now;
  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6">
      <Link
        href={base}
        className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        Machines
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">Machine setup</h1>
        {machine && (
          <p className="mt-1 text-sm text-muted-foreground">
            {machine.name} · {machine.address}
          </p>
        )}
      </div>
      {!allowed ? (
        <p>
          You need infrastructure viewing and management permission to set up
          machines.
        </p>
      ) : !ready ? (
        <p role="status">Loading setup…</p>
      ) : (
        <>
          <ol
            aria-label="Setup progress"
            className="grid grid-cols-3 gap-3 border-y py-5"
          >
            {["Details", "Install agent", "Verify connection"].map(
              (label, index) => (
                <li
                  key={label}
                  aria-current={
                    !connected && index === step ? "step" : undefined
                  }
                  className={`flex items-center gap-2 text-xs sm:text-sm ${index <= step ? "" : "text-muted-foreground"}`}
                >
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-full border ${index < step || connected ? "border-primary bg-primary text-primary-foreground" : index === step ? "border-primary text-primary" : ""}`}
                  >
                    {index < step || connected ? (
                      <CheckIcon className="size-4" aria-label="Complete" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  {label}
                </li>
              ),
            )}
          </ol>
          {!machineId ? (
            <form ref={form} onSubmit={create} noValidate className="space-y-5">
              {(Object.keys(labels) as (keyof Draft)[]).map((field) => (
                <div key={field} className="space-y-2">
                  <Label htmlFor={`setup-${field}`}>
                    {labels[field]}
                    {["provider", "notes"].includes(field) && (
                      <span className="text-muted-foreground"> · optional</span>
                    )}
                  </Label>
                  {field === "notes" ? (
                    <Textarea
                      id={`setup-${field}`}
                      maxLength={2000}
                      value={draft[field]}
                      aria-invalid={!!fields[field]}
                      aria-describedby={
                        fields[field] ? `setup-${field}-error` : undefined
                      }
                      onChange={(e) => {
                        const next = { ...draft, [field]: e.target.value };
                        setDraft(next);
                        store(next, null);
                      }}
                    />
                  ) : (
                    <Input
                      id={`setup-${field}`}
                      maxLength={field === "address" ? 253 : 80}
                      value={draft[field]}
                      aria-invalid={!!fields[field]}
                      aria-describedby={
                        fields[field] ? `setup-${field}-error` : undefined
                      }
                      onChange={(e) => {
                        const next = { ...draft, [field]: e.target.value };
                        setDraft(next);
                        store(next, null);
                      }}
                    />
                  )}
                  {fields[field] && (
                    <p
                      id={`setup-${field}-error`}
                      className="text-sm text-destructive"
                    >
                      {fields[field]}
                    </p>
                  )}
                </div>
              ))}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button disabled={busy} className="min-h-11">
                {busy ? "Saving…" : "Save and continue"}
              </Button>
            </form>
          ) : !machine ? (
            <div className="space-y-3">
              <p role="status">{loadError || "Loading machine…"}</p>
              {loadError && (
                <Button variant="outline" onClick={startAnother}>
                  Start a new setup
                </Button>
              )}
            </div>
          ) : connected ? (
            <div className="space-y-4 rounded-lg border bg-card p-6">
              <CheckIcon className="size-7 text-primary" />
              <h2 className="text-lg font-semibold">Machine connected</h2>
              <p className="text-sm text-muted-foreground">
                First setup complete. Latest report:{" "}
                {observed(machine.lastSeenAt)}.
              </p>
              <Button asChild className="min-h-11">
                <Link href={base}>View machines</Link>
              </Button>
              <Button
                variant="ghost"
                className="min-h-11"
                onClick={startAnother}
              >
                Set up another machine
              </Button>
            </div>
          ) : (
            <div className="space-y-6">
              {!machine.enrolled && (
                <div className="space-y-4 rounded-lg border bg-card p-5">
                  <h2 className="font-semibold">Enroll the agent</h2>
                  <p className="text-sm text-muted-foreground">
                    Generate a single-use token when you’re ready to install.
                    Tokens expire after 10 minutes.
                  </p>
                  {token && !expired && (
                    <div className="space-y-2">
                      <Label htmlFor="setup-token">Enrollment token</Label>
                      <Input
                        id="setup-token"
                        readOnly
                        autoComplete="off"
                        className="font-mono"
                        value={token.token}
                        onFocus={(e) => e.target.select()}
                      />
                      <p className="text-xs text-muted-foreground">
                        Expires {observed(token.expiresAt)}. After leaving this
                        page, generate a new token to continue.
                      </p>
                    </div>
                  )}
                  {expired && (
                    <p className="text-sm text-warning">
                      Token expired. Generate a new token.
                    </p>
                  )}
                  <Button
                    disabled={busy}
                    className="min-h-11"
                    onClick={() => void generate()}
                  >
                    {busy
                      ? "Generating…"
                      : token || machine.enrollmentExpiresAt
                        ? "Generate new token"
                        : "Generate token"}
                  </Button>
                </div>
              )}
              <div className="space-y-4 rounded-lg border bg-card p-5">
                <h2 className="font-semibold">Install on the machine</h2>
                <p className="text-sm text-muted-foreground">
                  Linux with Python 3.10 or later. Use your Cupboard HTTPS
                  address and paste the token at the hidden prompt.
                </p>
                <Button variant="outline" asChild className="min-h-11">
                  <a href="/agent/cupboard-agent.py" download>
                    <DownloadIcon className="size-4" />
                    Download agent
                  </a>
                </Button>
                <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs leading-6">
                  <code>
                    python3 cupboard-agent.py enroll --url
                    https://YOUR-CUPBOARD-HOST{"\n"}python3 cupboard-agent.py
                    run
                  </code>
                </pre>
                <p className="text-sm text-muted-foreground">
                  Keep the agent running. Follow the{" "}
                  <a
                    href="/agent/setup.txt"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    service setup instructions
                  </a>{" "}
                  to start it after reboot.
                </p>
              </div>
              <div role="status" className="rounded-lg border p-5 text-sm">
                {loadError ||
                  (machine.enrolled
                    ? "Waiting for a fresh health report…"
                    : "Waiting for agent enrollment…")}
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button variant="ghost" disabled={busy} onClick={startAnother}>
                Set up another machine
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
