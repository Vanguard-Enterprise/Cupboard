// Development support for the shared Discord application.
//
// Every worktree uses one Discord application whose credentials live in
// OpenBao. Discord sends installs back to one registered redirect URI, so a
// small relay on a fixed port forwards each install to the worktree whose
// web port leads its state. The relay holds no credentials, and nothing here
// opens a Discord gateway connection.
import { execFile } from "node:child_process";
import { createServer } from "node:http";

export const relayPort = 21700;
export const relayPath = "/discord/callback";
const credentialsPath = "cupboard/rebuild/development/discord";

export function redirectUri(host) {
  return `http://${host}:${relayPort}${relayPath}`;
}

// Returns the worktree callback URL for a relay request, or undefined.
export function relayTarget(requestUrl, hostHeader, allowedHosts) {
  let url;
  try {
    url = new URL(requestUrl, "http://relay.invalid");
  } catch {
    return undefined;
  }
  const host = hostHeader?.replace(/:\d+$/, "");
  if (url.pathname !== relayPath || !host || !allowedHosts.includes(host))
    return undefined;
  const match = /^(\d{4,5})\.[0-9a-f]{64}$/.exec(
    url.searchParams.get("state") ?? "",
  );
  const port = Number(match?.[1]);
  if (!match || port < 1024 || port > 65535 || port === relayPort)
    return undefined;
  return `http://${host}:${port}/dashboard/community/discord/callback${url.search}`;
}

// Serves the relay while any worktree's dev server runs. When another
// worktree already holds the port, retry so one takes over after it stops.
export function startDiscordRelay(
  allowedHosts,
  { port = relayPort, retryMs = 30_000 } = {},
) {
  let server;
  let timer;
  let stopped = false;
  const listen = () => {
    if (stopped) return;
    server = createServer((request, response) => {
      const target = relayTarget(
        request.url ?? "",
        request.headers.host,
        allowedHosts,
      );
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      if (request.method !== "GET" || !target) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Unknown Discord installation.");
        return;
      }
      response.writeHead(303, { Location: target });
      response.end();
    });
    server.once("error", () => {
      server = undefined;
      if (!stopped) timer = setTimeout(listen, retryMs);
    });
    server.listen(port, "0.0.0.0");
  };
  listen();
  return () => {
    stopped = true;
    clearTimeout(timer);
    server?.close();
  };
}

// Reads the development application's credentials from OpenBao without
// writing them anywhere. Resolves to environment variables for the API only.
export function loadDiscordCredentials(host, webPort) {
  return new Promise((resolve) => {
    execFile(
      "bao",
      ["kv", "get", "-format=json", "-mount=kv", credentialsPath],
      {
        timeout: 8000,
        env: {
          ...process.env,
          BAO_ADDR: process.env.BAO_ADDR ?? "https://openbao.vngenterprise.com",
        },
      },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const data = JSON.parse(stdout).data.data;
          if (!data.application_id || !data.bot_token || !data.client_secret)
            return resolve(undefined);
          resolve({
            CUPBOARD_DISCORD_APPLICATION_ID: data.application_id,
            CUPBOARD_DISCORD_BOT_TOKEN: data.bot_token,
            CUPBOARD_DISCORD_CLIENT_SECRET: data.client_secret,
            CUPBOARD_DISCORD_REDIRECT_URI: redirectUri(host),
            CUPBOARD_DISCORD_STATE_PREFIX: `${webPort}.`,
          });
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}
