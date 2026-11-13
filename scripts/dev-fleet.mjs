// Development-only example fleet: fake Rust game servers on loopback (WebRCON
// and A2S) and health reports for the example machines `npm run dev:seed`
// enrolls. The API checks the servers like real ones; nothing here touches the
// database. Credentials and the RCON password stay in the private account file.
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { loopbackApi, privateAccount } from "./dev-machines.mjs";
import { workspaceIdentity } from "./workspace.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const REPORT_MS = 15_000;
export const SERVER_BEHAVIORS = ["busy", "steady", "rcon-rejects", "offline"];
export const MACHINE_BEHAVIORS = ["steady", "busy", "database", "silent"];
export { loopbackApi };

/** Players right now: a slow daily-ish wave with a little noise, per server. */
export function players(behavior, now = Date.now(), seed = 0) {
  const [base, swing, max] =
    behavior === "busy" ? [95, 35, 150] : [40, 15, 100];
  const wave = Math.sin(now / 900_000 + seed) * swing;
  const noise = Math.sin(now / 47_000 + seed * 3) * 4;
  return Math.max(0, Math.min(max, Math.round(base + wave + noise)));
}

/** A Source INFO reply that Cupboard's A2S probe accepts. */
export function a2sInfo({ name, players: count, maxPlayers }) {
  const text = (value) => Buffer.from(`${value}\0`, "utf8");
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x11]),
    text(name),
    text("Procedural Map"),
    text("rust"),
    text("Rust"),
    Buffer.from([0x00, 0x00, count, maxPlayers, 0, 0x64, 0x6c, 0, 1]),
    text("2590"),
  ]);
}

/** One unmasked server text frame. */
export function textFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** Reads one client frame (masked, at most 64 KiB) or null when incomplete. */
export function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) throw new Error("Frame too large.");
  const masked = (buffer[1] & 0x80) !== 0;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, size: offset + length };
}

function serveRcon(server, password) {
  const listener = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let open = false;
    socket.on("error", () => socket.destroy());
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 70_000) return socket.destroy();
      if (!open) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        const path = head.split(" ")[1] ?? "";
        const key = /^sec-websocket-key:\s*(\S+)/im.exec(head)?.[1];
        // The example that rejects RCON behaves like a wrong saved password.
        if (
          !key ||
          server.behavior === "rcon-rejects" ||
          path !== `/${password}`
        ) {
          socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const accept = createHash("sha1")
          .update(key + GUID)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        open = true;
      }
      for (;;) {
        let frame;
        try {
          frame = readFrame(buffer);
        } catch {
          return socket.destroy();
        }
        if (!frame) return;
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === 0x8) return socket.end(Buffer.from([0x88, 0]));
        if (frame.opcode !== 0x1) continue;
        let request;
        try {
          request = JSON.parse(frame.payload.toString("utf8"));
        } catch {
          return socket.destroy();
        }
        socket.write(
          textFrame(
            JSON.stringify({
              Identifier: request.Identifier,
              Message: JSON.stringify({
                Hostname: server.name,
                Players: players(server.behavior, Date.now(), server.rconPort),
                MaxPlayers: server.maxPlayers,
                Map: "Procedural Map",
              }),
              Type: "Generic",
            }),
          ),
        );
      }
    });
  });
  listener.listen(server.rconPort, "127.0.0.1");
  return listener;
}

function serveA2s(server) {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (message, peer) => {
    if (
      !message
        .subarray(0, 5)
        .equals(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]))
    )
      return;
    socket.send(
      a2sInfo({
        name: server.name,
        players: players(server.behavior, Date.now(), server.rconPort),
        maxPlayers: server.maxPlayers,
      }),
      peer.port,
      peer.address,
    );
  });
  socket.bind(server.a2sPort, "127.0.0.1");
  return socket;
}

const GIB = 1024 ** 3;
/** One agent-style health report for an example machine. */
export function machineReport(machine, now = Date.now()) {
  const wave = (period, phase = 0) => (Math.sin(now / period + phase) + 1) / 2;
  const cpu =
    machine.behavior === "busy"
      ? 78 + wave(120_000) * 18
      : machine.behavior === "database"
        ? 18 + wave(300_000, 1) * 14
        : 30 + wave(240_000, 2) * 25;
  const memoryTotal = (machine.behavior === "database" ? 64 : 32) * GIB;
  const memoryUsed =
    machine.behavior === "busy"
      ? 0.86
      : machine.behavior === "database"
        ? 0.71
        : 0.52;
  const diskTotal = (machine.behavior === "database" ? 2000 : 500) * GIB;
  const diskUsed = machine.behavior === "database" ? 0.64 : 0.38;
  const cpuCount = machine.behavior === "database" ? 16 : 8;
  return {
    hostname: machine.name,
    os: "Ubuntu 24.04 LTS",
    agentVersion: "dev-example",
    cpuCount,
    loadOne: Number(((cpu / 100) * cpuCount).toFixed(2)),
    cpuUsagePercent: Number(Math.min(100, cpu).toFixed(1)),
    networkReceiveBytesPerSecond: Math.round(
      (machine.behavior === "database" ? 2e6 : 9e6) * (0.4 + wave(60_000, 3)),
    ),
    networkSendBytesPerSecond: Math.round(
      (machine.behavior === "database" ? 4e6 : 6e6) * (0.4 + wave(75_000, 4)),
    ),
    memoryTotalBytes: memoryTotal,
    memoryAvailableBytes: Math.round(memoryTotal * (1 - memoryUsed)),
    diskTotalBytes: diskTotal,
    diskAvailableBytes: Math.round(diskTotal * (1 - diskUsed)),
    uptimeSeconds: (Math.floor(now / 1000) % (40 * 86_400)) + 86_400,
  };
}

async function report(api, machines, send = fetch) {
  let accepted = 0;
  for (const machine of machines) {
    try {
      const response = await send(`${api}/node-api/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${machine.credential}`,
        },
        body: JSON.stringify(machineReport(machine)),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) accepted += 1;
    } catch {
      /* The API may be rebuilding; the next round retries. */
    }
  }
  return accepted;
}

/** The seeded fleet, read like every private account file, or null. */
export function fleetOf(path, project, read = privateAccount) {
  try {
    const fleet = read(path, project).exampleFleet;
    const port = (value) =>
      Number.isInteger(value) && value >= 1024 && value <= 65535;
    const valid =
      /^[0-9a-f]{32}$/.test(fleet?.rconPassword ?? "") &&
      Array.isArray(fleet.servers) &&
      Array.isArray(fleet.machines) &&
      fleet.servers.every(
        (s) =>
          SERVER_BEHAVIORS.includes(s.behavior) &&
          port(s.rconPort) &&
          port(s.a2sPort) &&
          Number.isInteger(s.maxPlayers) &&
          s.maxPlayers >= 1 &&
          s.maxPlayers <= 255,
      ) &&
      fleet.machines.every(
        (m) =>
          MACHINE_BEHAVIORS.includes(m.behavior) &&
          /^[0-9a-f]{64}$/.test(m.credential ?? ""),
      );
    return valid ? fleet : null;
  } catch {
    return null;
  }
}

async function run() {
  const [path] = process.argv.slice(2);
  const api = loopbackApi(process.env.CUPBOARD_API_URL ?? "");
  const project = workspaceIdentity(process.cwd());
  let fleet = fleetOf(path, project);
  // The account file gains its fleet on the first `npm run dev:seed`.
  while (!fleet) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    fleet = fleetOf(path, project);
  }
  const closers = [];
  for (const server of fleet.servers) {
    if (server.behavior === "offline") continue;
    const rcon = serveRcon(server, fleet.rconPassword);
    const a2s = serveA2s(server);
    rcon.on("error", () =>
      console.error(`Example server ${server.name}: its RCON port is in use.`),
    );
    a2s.on("error", () =>
      console.error(`Example server ${server.name}: its query port is in use.`),
    );
    closers.push(
      () => rcon.close(),
      () => a2s.close(),
    );
  }
  const reporting = fleet.machines.filter((m) => m.behavior !== "silent");
  let last = -1;
  const tick = async () => {
    const accepted = await report(api, reporting);
    if (accepted !== last)
      console.log(
        `Example fleet: ${accepted}/${reporting.length} machines reporting.`,
      );
    last = accepted;
  };
  void tick();
  const timer = setInterval(() => void tick(), REPORT_MS);
  const stop = () => {
    clearInterval(timer);
    for (const close of closers) close();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run().catch(() => {
    console.error("Example fleet stopped.");
    process.exitCode = 1;
  });
