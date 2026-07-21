import { describe, expect, it, vi } from "vitest";
import { TicketStreamConsumer, type ConsumerRedis } from "./consumer.js";
import { RelayError } from "./relay.js";

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as import("pino").Logger;

const EVENT_JSON = JSON.stringify({
    kind: "ticket.status",
    tenant_id: "t-1",
    ticket_id: "0197a6a4-0000-7000-8000-000000000001",
    status: "resolved",
});

/**
 * Fake redis: serves the given entries from the first XREADGROUP, then blocks
 * (resolves null) until disconnect. Records ack order into `calls`.
 */
function fakeRedis(entries: [string, string[]][], calls: string[]) {
    let served = false;
    let stopped = false;
    const redis: ConsumerRedis = {
        connect: async () => undefined,
        disconnect: () => {
            stopped = true;
        },
        on: () => undefined,
        xgroup: async () => {
            throw new Error("BUSYGROUP Consumer Group name already exists");
        },
        xautoclaim: async () => ["0-0", []],
        xack: async (...args) => {
            calls.push(`ack:${String(args[2])}`);
            return 1;
        },
        xreadgroup: async () => {
            if (!served) {
                served = true;
                return [["cupboard:tickets", entries]];
            }
            // Simulate BLOCK: return nothing until stop() disconnects us.
            await new Promise((r) => setTimeout(r, stopped ? 0 : 5));
            return null;
        },
    };
    return redis;
}

describe("TicketStreamConsumer", () => {
    it("acks AFTER the handler resolves (post/fence run inside the handler)", async () => {
        const calls: string[] = [];
        const redis = fakeRedis([["1-1", ["data", EVENT_JSON]]], calls);
        const handler = vi.fn(async () => {
            calls.push("handled");
        });
        const consumer = new TicketStreamConsumer("redis://unused", silentLogger, handler, {
            redis,
        });
        await consumer.start();
        await vi.waitFor(() => expect(calls).toContain("ack:1-1"));
        await consumer.stop();

        expect(handler).toHaveBeenCalledTimes(1);
        expect(calls).toEqual(["handled", "ack:1-1"]);
    });

    it("still acks unparseable entries after a warn, without calling the handler", async () => {
        const calls: string[] = [];
        const redis = fakeRedis([["2-1", ["data", "not json"]]], calls);
        const handler = vi.fn(async () => undefined);
        const consumer = new TicketStreamConsumer("redis://unused", silentLogger, handler, {
            redis,
        });
        await consumer.start();
        await vi.waitFor(() => expect(calls).toContain("ack:2-1"));
        await consumer.stop();

        expect(handler).not.toHaveBeenCalled();
    });

    it("acks-and-drops after retries ONLY for non-RelayError throws (bugs)", async () => {
        const calls: string[] = [];
        const redis = fakeRedis([["3-1", ["data", EVENT_JSON]]], calls);
        const handler = vi.fn(async () => {
            throw new TypeError("cannot read properties of undefined");
        });
        const consumer = new TicketStreamConsumer("redis://unused", silentLogger, handler, {
            redis,
            handlerBackoffMs: 1,
        });
        await consumer.start();
        await vi.waitFor(() => expect(calls).toContain("ack:3-1"));
        await consumer.stop();

        expect(handler).toHaveBeenCalledTimes(5); // MAX_HANDLER_ATTEMPTS
    });

    it("leaves the entry PENDING (no ack) when RelayError retries exhaust (decision G)", async () => {
        const calls: string[] = [];
        const redis = fakeRedis([["5-1", ["data", EVENT_JSON]]], calls);
        const handler = vi.fn(async () => {
            throw new RelayError("discord down");
        });
        const consumer = new TicketStreamConsumer("redis://unused", silentLogger, handler, {
            redis,
            handlerBackoffMs: 1,
        });
        await consumer.start();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(5));
        // Give the loop a beat to (wrongly) ack if it were going to.
        await new Promise((r) => setTimeout(r, 20));
        await consumer.stop();

        expect(calls.filter((c) => c.startsWith("ack:"))).toEqual([]);
    });

    it("a transient failure then success acks exactly once", async () => {
        const calls: string[] = [];
        const redis = fakeRedis([["4-1", ["data", EVENT_JSON]]], calls);
        const handler = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error("blip"))
            .mockResolvedValue(undefined);
        const consumer = new TicketStreamConsumer("redis://unused", silentLogger, handler, {
            redis,
            handlerBackoffMs: 1,
        });
        await consumer.start();
        await vi.waitFor(() => expect(calls).toContain("ack:4-1"));
        await consumer.stop();

        expect(handler).toHaveBeenCalledTimes(2);
        expect(calls.filter((c) => c.startsWith("ack:"))).toEqual(["ack:4-1"]);
    });
});

describe("XAUTOCLAIM reclaim", () => {
    it("sweeps periodically, not just at boot", async () => {
        const calls: string[] = [];
        const redis = fakeRedis([], calls);
        const xautoclaim = vi.fn(async () => ["0-0", []]);
        redis.xautoclaim = xautoclaim;
        const consumer = new TicketStreamConsumer(
            "redis://unused",
            silentLogger,
            async () => undefined,
            { redis, claimIntervalMs: 5 },
        );
        await consumer.start();
        await vi.waitFor(() => expect(xautoclaim.mock.calls.length).toBeGreaterThanOrEqual(3));
        await consumer.stop();
    });

    it("walks the full cursor even across empty pages, and processes claimed entries", async () => {
        const calls: string[] = [];
        const redis = fakeRedis([], calls);
        const xautoclaim = vi
            .fn<(...args: (string | number)[]) => Promise<unknown>>()
            // Page 1: empty page mid-scan (deleted entries) with more to walk.
            .mockResolvedValueOnce(["5-0", []])
            // Page 2: a stranded entry, then the walk completes.
            .mockResolvedValueOnce(["0-0", [["9-1", ["data", EVENT_JSON]]]])
            // Later sweeps: nothing.
            .mockResolvedValue(["0-0", []]);
        redis.xautoclaim = xautoclaim;
        const handler = vi.fn(async () => undefined);
        const consumer = new TicketStreamConsumer("redis://unused", silentLogger, handler, {
            redis,
            claimIntervalMs: 60_000,
        });
        await consumer.start();
        await vi.waitFor(() => expect(calls).toContain("ack:9-1"));
        await consumer.stop();

        expect(handler).toHaveBeenCalledTimes(1);
        // The second call continued from the returned cursor, not "0-0".
        expect(xautoclaim.mock.calls[1]?.[4]).toBe("5-0");
    });
});

describe("TicketStreamConsumer.stop", () => {
    it("cancels an in-flight backoff sleep instead of waiting it out", async () => {
        const consumer = new TicketStreamConsumer(
            "redis://unused",
            silentLogger,
            async () => undefined,
            { redis: fakeRedis([], []) },
        );
        // Reach the private backoff sleep the loops await between retries; a
        // 30s sleep must not survive stop() (k8s termination grace is short).
        const internals = consumer as unknown as { sleep(ms: number): Promise<void> };
        const pending = internals.sleep(30_000);
        const started = Date.now();
        await consumer.stop();
        await pending;
        expect(Date.now() - started).toBeLessThan(1_000);
    });
});
