import { describe, expect, it } from "vitest";
import { TicketStreamConsumer } from "./consumer.js";

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as import("pino").Logger;

// The constructor uses lazyConnect, so no Redis is contacted in these tests.
describe("TicketStreamConsumer.stop", () => {
    it("cancels an in-flight backoff sleep instead of waiting it out", async () => {
        const consumer = new TicketStreamConsumer("redis://127.0.0.1:6399", silentLogger);
        // Reach the private backoff sleep the read loop awaits between retries;
        // a 30s sleep must not survive stop() (k8s termination grace is short).
        const internals = consumer as unknown as { sleep(ms: number): Promise<void> };
        const pending = internals.sleep(30_000);
        const started = Date.now();
        await consumer.stop();
        await pending;
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it("resolves promptly when no sleep is in flight", async () => {
        const consumer = new TicketStreamConsumer("redis://127.0.0.1:6399", silentLogger);
        const started = Date.now();
        await consumer.stop();
        expect(Date.now() - started).toBeLessThan(1_000);
    });
});
