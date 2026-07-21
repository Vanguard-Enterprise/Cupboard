/**
 * Ticket stream consumer (PR5: relay wired in).
 *
 * Reads `cupboard:tickets` via consumer group `bot` (XREADGROUP), parses the
 * single `data` field of each entry, hands the event to the relay handler,
 * and XACKs only after the handler returns (decision F: the fence is set by
 * the handler BEFORE the ack). Unparseable entries are logged at warn and
 * STILL acked (crates/bus precedent: poison never lingers in the pending
 * list).
 *
 * Failure semantics (decision G, "retries with backoff, acks only on
 * success"): a RelayError is a transient dependency failure by construction
 * (Discord or tenant down); after in-process retries exhaust, the entry is
 * left PENDING (no ack) and the periodic XAUTOCLAIM sweep redelivers it every
 * CLAIM_MIN_IDLE_MS until it succeeds. Only non-RelayError throws (bugs) are
 * acked-and-dropped after retries so a defect cannot wedge the stream; true
 * poison (unparseable) never reaches the handler at all.
 *
 * The XAUTOCLAIM sweep runs inside the read loop on a timer (not just at
 * boot): fast k8s restarts would otherwise strand a crashed pod's pending
 * entries forever, and our own left-pending entries rely on it to retry.
 */

import { hostname } from "node:os";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { CONSUMER_GROUP, parseTicketEvent, TICKET_STREAM, type TicketEvent } from "./events.js";
import { RelayError } from "./relay.js";

const READ_COUNT = 32;
const BLOCK_MS = 5000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const MAX_HANDLER_ATTEMPTS = 5;
/** Pending entries idle this long are presumed orphaned by a dead consumer. */
const CLAIM_MIN_IDLE_MS = 60_000;

/** One XREADGROUP reply: [stream, [entryId, [field, value, ...]][]][] */
type StreamReply = [string, [string, string[]][]][] | null;
/** One XAUTOCLAIM reply: [nextCursor, entries, (redis>=7) deletedIds] */
type AutoclaimReply = [string, [string, string[] | null][] | null, ...unknown[]];

/** The Redis slice the consumer uses; injectable for tests. */
export type ConsumerRedis = {
    connect(): Promise<void>;
    disconnect(): void;
    on(event: "error", listener: (err: Error) => void): unknown;
    xgroup(...args: (string | number)[]): Promise<unknown>;
    xack(...args: (string | number)[]): Promise<unknown>;
    xreadgroup(...args: (string | number)[]): Promise<unknown>;
    xautoclaim(...args: (string | number)[]): Promise<unknown>;
};

export type ConsumerOptions = {
    /** Injectable for tests; defaults to a real ioredis connection. */
    redis?: ConsumerRedis;
    /** Handler-retry backoff floor; tests shrink it. */
    handlerBackoffMs?: number;
    /** Interval between XAUTOCLAIM sweeps; tests shrink it. */
    claimIntervalMs?: number;
};

export class TicketStreamConsumer {
    private readonly redis: ConsumerRedis;
    private readonly logger: Logger;
    private readonly handler: (event: TicketEvent) => Promise<void>;
    private readonly consumerName: string;
    private readonly handlerBackoffMs: number;
    private readonly claimIntervalMs: number;
    private running = false;
    private loop: Promise<void> | undefined;
    /** Resolves the in-flight backoff sleep early; set only while sleeping. */
    private wake: (() => void) | undefined;

    constructor(
        redisUrl: string,
        logger: Logger,
        handler: (event: TicketEvent) => Promise<void>,
        options: ConsumerOptions = {},
    ) {
        this.logger = logger;
        this.handler = handler;
        this.handlerBackoffMs = options.handlerBackoffMs ?? 1000;
        this.claimIntervalMs = options.claimIntervalMs ?? CLAIM_MIN_IDLE_MS;
        this.consumerName = `bot-${hostname() || "unknown"}-${process.pid}`;
        this.redis =
            options.redis ??
            // The cast collapses ioredis's literal-typed overloads into the
            // narrow command slice above; every call site stays in-bounds.
            (new Redis(redisUrl, {
                // Blocking XREADGROUP calls must survive reconnects instead of
                // erroring out mid-flight; the loop-level catch handles the rest.
                maxRetriesPerRequest: null,
                retryStrategy: (times) => Math.min(times * BACKOFF_MIN_MS, BACKOFF_MAX_MS),
                lazyConnect: true,
            }) as unknown as ConsumerRedis);
        this.redis.on("error", (err) => {
            this.logger.warn({ error: err.message }, "redis connection error");
        });
    }

    /**
     * Connect, ensure the group, start the loop (whose first iteration runs
     * the reclaim sweep). MUST be called only after the Discord client is
     * ready and guild bindings are hydrated (index.ts): the relay's ready
     * guard turns ordering violations into retries, but the correct order
     * avoids churning the whole boot backlog through that guard.
     */
    async start(): Promise<void> {
        await this.redis.connect();
        await this.ensureGroup();
        this.running = true;
        this.loop = this.readLoop();
        this.logger.info(
            { stream: TICKET_STREAM, group: CONSUMER_GROUP, consumer: this.consumerName },
            "ticket stream consumer started",
        );
    }

    /**
     * Stop the loop: cancel any backoff sleep (otherwise shutdown could wait
     * out up to BACKOFF_MAX_MS of the termination grace) and disconnect, which
     * interrupts any in-flight blocking read.
     */
    async stop(): Promise<void> {
        this.running = false;
        this.wake?.();
        this.redis.disconnect();
        await this.loop;
        this.logger.info("ticket stream consumer stopped");
    }

    /**
     * Create the group at `$` with MKSTREAM (the committed contract from
     * crates/domain/src/events.rs). BUSYGROUP means it already exists: fine.
     */
    private async ensureGroup(): Promise<void> {
        try {
            await this.redis.xgroup("CREATE", TICKET_STREAM, CONSUMER_GROUP, "$", "MKSTREAM");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!message.includes("BUSYGROUP")) {
                throw err;
            }
        }
    }

    /**
     * XAUTOCLAIM entries pending past CLAIM_MIN_IDLE_MS: a crashed pod's
     * unacked deliveries AND our own entries left pending after RelayError
     * exhaustion. The cursor walk continues until the server says "0-0"; an
     * empty page mid-scan (e.g. a stretch of deleted entries) does NOT end
     * the sweep. Failures are non-fatal: everything stays pending for the
     * next sweep.
     */
    private async claimPending(): Promise<void> {
        let cursor = "0-0";
        for (;;) {
            let reply: AutoclaimReply;
            try {
                reply = (await this.redis.xautoclaim(
                    TICKET_STREAM,
                    CONSUMER_GROUP,
                    this.consumerName,
                    CLAIM_MIN_IDLE_MS,
                    cursor,
                    "COUNT",
                    READ_COUNT,
                )) as AutoclaimReply;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn({ error: message }, "xautoclaim sweep failed; skipping");
                return;
            }
            const [next, entries] = reply;
            for (const [entryId, fields] of entries ?? []) {
                if (!this.running) {
                    return;
                }
                // A null fields array marks an entry deleted from the stream.
                if (fields !== null) {
                    await this.processEntry(entryId, fields);
                }
            }
            if (next === "0-0") {
                return; // Full walk complete, regardless of page contents.
            }
            cursor = next;
        }
    }

    private async readLoop(): Promise<void> {
        let backoffMs = BACKOFF_MIN_MS;
        // First iteration sweeps immediately (the boot reclaim), then the
        // sweep repeats periodically so stranded entries are always retried.
        let nextClaimAt = 0;
        while (this.running) {
            try {
                if (Date.now() >= nextClaimAt) {
                    await this.claimPending();
                    nextClaimAt = Date.now() + this.claimIntervalMs;
                }
                const reply = (await this.redis.xreadgroup(
                    "GROUP",
                    CONSUMER_GROUP,
                    this.consumerName,
                    "COUNT",
                    READ_COUNT,
                    "BLOCK",
                    BLOCK_MS,
                    "STREAMS",
                    TICKET_STREAM,
                    ">",
                )) as StreamReply;
                backoffMs = BACKOFF_MIN_MS;
                if (!reply) {
                    continue; // BLOCK timed out with nothing new.
                }
                for (const [, entries] of reply) {
                    for (const [entryId, fields] of entries) {
                        if (!this.running) {
                            return; // Unacked entries stay pending; XAUTOCLAIM replays them.
                        }
                        await this.processEntry(entryId, fields);
                    }
                }
            } catch (err) {
                if (!this.running) {
                    return; // Interrupted by stop(); not an error.
                }
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn({ error: message, backoff_ms: backoffMs }, "stream read failed");
                await this.sleep(backoffMs);
                backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
            }
        }
    }

    /**
     * Parse, relay (with bounded in-place retry), then XACK on success. The
     * handler sets the relay fence before returning, so the ack is always
     * last (decision F ordering: post, fence, ack). Message bodies are never
     * logged.
     *
     * Exhaustion semantics: RelayError (transient dependency failure) leaves
     * the entry PENDING for the periodic reclaim (decision G: ack only on
     * success); any other error is a bug and is acked-and-dropped so it
     * cannot wedge the stream.
     */
    private async processEntry(entryId: string, fields: string[]): Promise<void> {
        const data = fieldValue(fields, "data");
        const event = data === undefined ? null : parseTicketEvent(data);
        if (event === null) {
            this.logger.warn({ entry_id: entryId }, "skipping unparseable stream entry");
            await this.ack(entryId);
            return;
        }
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_HANDLER_ATTEMPTS; attempt++) {
            try {
                await this.handler(event);
                this.logger.info(
                    {
                        entry_id: entryId,
                        kind: event.kind,
                        tenant_id: event.tenant_id,
                        ticket_id: event.ticket_id,
                    },
                    "ticket event handled",
                );
                await this.ack(entryId);
                return;
            } catch (err) {
                lastError = err;
                const message = err instanceof Error ? err.message : String(err);
                if (attempt < MAX_HANDLER_ATTEMPTS) {
                    const backoffMs = Math.min(
                        this.handlerBackoffMs * 2 ** (attempt - 1),
                        BACKOFF_MAX_MS,
                    );
                    this.logger.warn(
                        { entry_id: entryId, attempt, backoff_ms: backoffMs, error: message },
                        "relay attempt failed; retrying",
                    );
                    await this.sleep(backoffMs);
                    if (!this.running) {
                        return; // No ack: the entry stays pending for reclaim.
                    }
                }
            }
        }
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        if (lastError instanceof RelayError) {
            this.logger.warn(
                { entry_id: entryId, kind: event.kind, ticket_id: event.ticket_id, error: message },
                "relay retries exhausted; leaving entry pending for reclaim (ack only on success)",
            );
            return; // No ack.
        }
        this.logger.error(
            { entry_id: entryId, kind: event.kind, ticket_id: event.ticket_id, error: message },
            "dropping event after unexpected handler error (web store is canonical)",
        );
        await this.ack(entryId);
    }

    private async ack(entryId: string): Promise<void> {
        await this.redis.xack(TICKET_STREAM, CONSUMER_GROUP, entryId);
    }

    /** Backoff sleep that stop() cancels via `wake`, so shutdown never waits it out. */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.wake = undefined;
                resolve();
            }, ms);
            this.wake = () => {
                clearTimeout(timer);
                this.wake = undefined;
                resolve();
            };
        });
    }
}

/** Pull one value out of a flat [field, value, field, value, ...] array. */
function fieldValue(fields: string[], name: string): string | undefined {
    for (let i = 0; i + 1 < fields.length; i += 2) {
        if (fields[i] === name) {
            return fields[i + 1];
        }
    }
    return undefined;
}
