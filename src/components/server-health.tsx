"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { type Identity } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

export type HealthServer = {
  id: string;
  name: string;
  checkedAt: number | null;
  rconStatus: string | null;
  a2sStatus: string | null;
  players: number | null;
  playersAt: number | null;
  playersSource: string | null;
  rconHost?: string | null;
  a2sHost?: string | null;
  panelServerUuid?: string | null;
};
const STALE_AFTER = 90_000;
const outcomes: Record<string, string> = {
  connected: "Connected",
  authentication_failed: "Authentication failed",
  unreachable: "Unreachable",
  timeout: "Timed out",
  invalid_configuration: "Invalid configuration",
  protocol_error: "Unexpected response",
};
function Timestamp({ value }: { value: number }) {
  return (
    <time dateTime={new Date(value).toISOString()}>
      {new Date(value).toLocaleString()}
    </time>
  );
}
export function ServerHealth({ identity }: { identity: Identity }) {
  // Remount for account, organization, or permission changes to discard old data.
  return (
    <HealthView
      key={`${identity.user.id}:${identity.organization?.id}:${identity.permissions.join(",")}`}
      identity={identity}
    />
  );
}
function HealthView({ identity }: { identity: Identity }) {
  const [servers, setServers] = useState<HealthServer[] | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(true);
  const [now, setNow] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const view = identity.permissions.includes("servers.view");
  const organizationId = identity.organization?.id;
  useEffect(() => {
    if (!view || !organizationId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function load() {
      setRefreshing(true);
      try {
        const response = await fetch("/app-api/servers/health", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403)
            setServers(null);
          throw new Error(
            response.status === 401 || response.status === 403
              ? "Server access changed. Reload the page to update your session."
              : "Server health could not be refreshed. Try again.",
          );
        }
        const result = await response.json();
        if (disposed) return;
        if (result.organizationId !== organizationId) {
          setServers(null);
          throw new Error(
            "Your active organization changed. Reload the page to view its servers.",
          );
        }
        setServers(result.servers);
        setError("");
      } catch (cause) {
        if (!disposed)
          setError(
            cause instanceof Error
              ? cause.message
              : "Server health could not be refreshed.",
          );
      } finally {
        if (!disposed) {
          setNow(Date.now());
          setRefreshing(false);
          timer = setTimeout(load, 15_000);
        }
      }
    }
    void load();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [view, organizationId, attempt]);
  const manage = identity.permissions.includes("servers.manage");
  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Server health
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rust servers in {identity.organization?.name}.
          </p>
        </div>
        {view && (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={refreshing}
            onClick={() => setAttempt((a) => a + 1)}
          >
            {refreshing ? "Refreshing..." : "Refresh health"}
          </Button>
        )}
      </div>
      {!view ? (
        <p className="text-sm text-muted-foreground">
          You need server viewing permission to see this organization&apos;s
          health.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Servers are checked about every 30 seconds. Readings older than 90
            seconds are marked stale.
          </p>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {servers ? "The displayed readings are stale. " : ""}
                {error}
              </AlertDescription>
            </Alert>
          )}
          {!servers && !error && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading server health...
            </p>
          )}
          {servers?.length === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <h2 className="font-semibold">No servers yet</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {manage
                  ? "Add a Rust server to start checking its health and player count."
                  : "Ask an organization administrator to add a server."}
              </p>
              {manage && (
                <Button asChild className="mt-4 min-h-11">
                  <Link href="/dashboard/servers">Add server</Link>
                </Button>
              )}
            </div>
          )}
          {!!servers?.length && (
            <ul className="divide-y rounded-lg border">
              {servers.map((server) => {
                const stale =
                  Boolean(error) ||
                  (server.checkedAt !== null &&
                    now - server.checkedAt > STALE_AFTER);
                const rcon = server.rconStatus === "connected";
                const a2s = server.a2sStatus === "connected";
                const panelOnly =
                  Boolean(server.panelServerUuid) &&
                  !server.rconHost &&
                  !server.a2sHost;
                const state = panelOnly
                  ? "Panel managed"
                  : server.checkedAt === null
                    ? "Awaiting first check"
                    : stale
                      ? "Stale"
                      : rcon && a2s
                        ? "Healthy"
                        : rcon || a2s
                          ? "Degraded"
                          : "Unavailable";
                const oldPlayers =
                  stale ||
                  (!rcon && !a2s) ||
                  server.playersAt === null ||
                  now - server.playersAt > STALE_AFTER;
                return (
                  <li key={server.id} className="space-y-4 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h2 className="break-words font-semibold">
                        {server.name}
                      </h2>
                      <span
                        className={
                          state === "Healthy"
                            ? "text-sm text-primary"
                            : "text-sm text-warning"
                        }
                      >
                        {state}
                      </span>
                    </div>
                    {panelOnly ? (
                      <p className="text-sm text-muted-foreground">
                        Game health not configured.{" "}
                        <Link
                          href="/dashboard/servers"
                          className="underline underline-offset-4"
                        >
                          Manage server
                        </Link>
                      </p>
                    ) : (
                      <>
                        <dl className="grid gap-4 text-sm sm:grid-cols-3">
                          <div>
                            <dt className="text-muted-foreground">
                              {server.players !== null && oldPlayers
                                ? "Last known players"
                                : "Players"}
                            </dt>
                            <dd className="mt-1 font-mono text-2xl tabular-nums">
                              {server.players ?? "Unknown"}
                            </dd>
                            {server.playersAt !== null && (
                              <dd className="mt-1 text-xs text-muted-foreground">
                                {server.playersSource === "rcon"
                                  ? "RCON"
                                  : "A2S"}{" "}
                                reading · <Timestamp value={server.playersAt} />
                              </dd>
                            )}
                          </div>
                          {(
                            [
                              ["RCON", server.rconStatus],
                              ["A2S", server.a2sStatus],
                            ] as const
                          ).map(([label, status]) => (
                            <div key={label}>
                              <dt className="text-muted-foreground">{label}</dt>
                              <dd className="mt-1">
                                {status
                                  ? (outcomes[status] ?? "Unknown")
                                  : "Not checked"}
                              </dd>
                            </div>
                          ))}
                        </dl>
                        <p className="text-xs text-muted-foreground">
                          {server.checkedAt === null ? (
                            "Waiting for the first server response."
                          ) : (
                            <>
                              Last checked{" "}
                              <Timestamp value={server.checkedAt} />.{" "}
                              {stale
                                ? "Waiting for a fresh reading."
                                : !rcon && !a2s
                                  ? "Neither connection responded successfully. Check the server and network."
                                  : !rcon || !a2s
                                    ? "One connection needs attention. Player count uses the responding connection."
                                    : "Both connections responded successfully."}
                            </>
                          )}
                        </p>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!!servers?.length && (
            <Button variant="outline" asChild className="min-h-11">
              <Link href="/dashboard/servers">View server connections</Link>
            </Button>
          )}
        </>
      )}
    </section>
  );
}
