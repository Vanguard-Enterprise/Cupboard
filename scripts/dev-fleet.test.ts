import { describe, expect, it } from "vitest";
import {
  MACHINE_BEHAVIORS,
  SERVER_BEHAVIORS,
  a2sInfo,
  fleetOf,
  loopbackApi,
  machineReport,
  players,
  readFrame,
  textFrame,
} from "./dev-fleet.mjs";
import { EXAMPLE_PORTS, exampleFleet, withExamplePorts } from "./dev-seed.mjs";

describe("example fleet", () => {
  it("defines servers and machines the simulator knows how to play", () => {
    const fleet = exampleFleet();
    expect(fleet.rconPassword).toMatch(/^[0-9a-f]{32}$/);
    expect(fleet.servers.map((s) => s.behavior)).toEqual(SERVER_BEHAVIORS);
    expect(fleet.machines.map((m) => m.behavior)).toEqual(MACHINE_BEHAVIORS);
    const ports = fleet.servers.flatMap((s) => [s.rconPort, s.a2sPort]);
    // Distinct, and clear of ephemeral and dev stack ports.
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(EXAMPLE_PORTS[0]);
      expect(port).toBeLessThanOrEqual(EXAMPLE_PORTS[1]);
      expect(port).toBeLessThan(20000);
    }
    for (const server of fleet.servers)
      expect(server.id).toMatch(/^[0-9a-f-]{36}$/);
    // A fleet saved before the range moved gets new ports, nothing else.
    expect(withExamplePorts(fleet)).toBe(fleet);
    const old = {
      ...fleet,
      servers: fleet.servers.map((s) => ({ ...s, rconPort: 41234 })),
    };
    const moved = withExamplePorts(old);
    expect(moved.servers.map((s: { id: string }) => s.id)).toEqual(
      fleet.servers.map((s) => s.id),
    );
    expect(moved.rconPassword).toBe(fleet.rconPassword);
    for (const server of moved.servers)
      expect(server.rconPort).toBeLessThanOrEqual(EXAMPLE_PORTS[1]);
    for (const machine of fleet.machines)
      expect(machine.credential).toMatch(/^[0-9a-f]{64}$/);
    // Every worktree gets its own ids and secrets.
    const other = exampleFleet();
    expect(other.rconPassword).not.toBe(fleet.rconPassword);
    expect(other.machines[0].credential).not.toBe(fleet.machines[0].credential);
  });

  it("answers A2S with the INFO fields Cupboard's probe requires", () => {
    const packet = a2sInfo({ name: "Rust EU", players: 87, maxPlayers: 150 });
    expect([...packet.subarray(0, 5)]).toEqual([0xff, 0xff, 0xff, 0xff, 0x49]);
    // Skip the header, protocol, and four strings, as the probe does.
    let rest = packet.subarray(6);
    for (let i = 0; i < 4; i++) rest = rest.subarray(rest.indexOf(0) + 1);
    expect(rest[2]).toBe(87);
    expect(rest[3]).toBe(150);
    expect(rest.subarray(9).includes(0)).toBe(true);
  });

  it("reads masked client frames and writes server text frames", () => {
    const payload = Buffer.from('{"Identifier":1,"Message":"serverinfo"}');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      masked,
    ]);
    expect(readFrame(frame.subarray(0, 5))).toBeNull();
    const read = readFrame(frame)!;
    expect(read.opcode).toBe(1);
    expect(read.payload.toString()).toBe(payload.toString());
    expect(read.size).toBe(frame.length);
    const long = "x".repeat(300);
    const reply = textFrame(long);
    expect([reply[0], reply[1]]).toEqual([0x81, 126]);
    expect(reply.readUInt16BE(2)).toBe(300);
  });

  it("keeps player counts and machine readings in their valid ranges", () => {
    for (let at = 0; at < 86_400_000; at += 600_000) {
      const busy = players("busy", at);
      expect(busy).toBeGreaterThanOrEqual(0);
      expect(busy).toBeLessThanOrEqual(150);
      for (const behavior of ["steady", "busy", "database"]) {
        const report = machineReport({ name: "eu-game-01", behavior }, at);
        expect(report.cpuUsagePercent).toBeGreaterThanOrEqual(0);
        expect(report.cpuUsagePercent).toBeLessThanOrEqual(100);
        expect(report.memoryAvailableBytes).toBeLessThanOrEqual(
          report.memoryTotalBytes,
        );
        expect(report.diskAvailableBytes).toBeLessThanOrEqual(
          report.diskTotalBytes,
        );
      }
    }
    expect(
      machineReport({ name: "x", behavior: "busy" }, 0),
    ).not.toHaveProperty("geolocation");
  });

  it("plays only a private account file's well-formed fleet", () => {
    const fleet = exampleFleet();
    expect(fleetOf("account.json", "p", () => ({ exampleFleet: fleet }))).toBe(
      fleet,
    );
    // Not seeded yet, unreadable or not private, or malformed: nothing yet.
    expect(fleetOf("account.json", "p", () => ({}))).toBeNull();
    expect(
      fleetOf("account.json", "p", () => {
        throw new Error("Development credentials must be private.");
      }),
    ).toBeNull();
    const bad = {
      ...fleet,
      servers: [{ ...fleet.servers[0], behavior: "unknown" }],
    };
    expect(
      fleetOf("account.json", "p", () => ({ exampleFleet: bad })),
    ).toBeNull();
  });

  it("reports only to the loopback API", () => {
    expect(loopbackApi("http://127.0.0.1:47234")).toBe(
      "http://127.0.0.1:47234",
    );
    for (const url of [
      "https://127.0.0.1:47234",
      "http://localhost:47234",
      "http://100.107.41.153:47234",
      "http://user:pass@127.0.0.1:1",
      "http://127.0.0.1:1/api",
    ])
      expect(() => loopbackApi(url)).toThrow();
  });
});
