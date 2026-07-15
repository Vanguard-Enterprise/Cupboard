/**
 * Ticket stream consumer skeleton (PR4).
 *
 * Reads `cupboard:tickets` via consumer group `bot` (XREADGROUP), parses the
 * single `data` field of each entry, logs it, and XACKs. Unparseable entries
 * are logged at warn and STILL acked, matching the crates/bus precedent:
 * poison must never linger in the pending list.
 *
 * PR5 seam: the relay pipeline slots into `handleEntry` below, between parse
 * and ack:
 *   1. XAUTOCLAIM pending entries from dead consumers on boot (before the
 *      main read loop) so a crashed pod's unacked deliveries are replayed.
 *   2. Check the relay fence, post to the Discord thread FIRST, then set the
 *      fence `SET bot:relayed:{message_id} NX EX 86400`, then XACK (decision
 *      F ordering: a crash between post and fence duplicates thread text,
 *      which is harmless; fence-before-post would silently drop messages).
 *   3. Lazy thread creation for tickets with no discord_thread_id (decision
 *      E), backfilling via GET /internal/tickets/{id}.
 */

import { hostname } from "node:os";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { CONSUMER_GROUP, parseTicketEvent, TICKET_STREAM } from "./events.js";

const READ_COUNT = 32;
const BLOCK_MS = 5000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/** One XREADGROUP reply: [stream, [entryId, [field, value, ...]][]][] */
type StreamReply = [string, [string, string[]][]][] | null;

export class TicketStreamConsumer {
    private readonly redis: Redis;
    private readonly logger: Logger;
    private readonly consumerName: string;
    private running = false;
    private loop: Promise<void> | undefined;
    /** Resolves the in-flight backoff sleep early; set only while sleeping. */
    private wake: (() => void) | undefined;

    constructor(redisUrl: string, logger: Logger) {
        this.logger = logger;
        this.consumerName = `bot-${hostname() || "unknown"}-${process.pid}`;
        this.redis = new Redis(redisUrl, {
            // Blocking XREADGROUP calls must survive reconnects instead of
            // erroring out mid-flight; the loop-level catch handles the rest.
            maxRetriesPerRequest: null,
            retryStrategy: (times) => Math.min(times * BACKOFF_MIN_MS, BACKOFF_MAX_MS),
            lazyConnect: true,
        });
        this.redis.on("error", (err) => {
            this.logger.warn({ error: err.message }, "redis connection error");
        });
    }

    /** Connect, ensure the consumer group exists, and start the read loop. */
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

    private async readLoop(): Promise<void> {
        let backoffMs = BACKOFF_MIN_MS;
        while (this.running) {
            try {
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
                    const ackIds: string[] = [];
                    for (const [entryId, fields] of entries) {
                        this.handleEntry(entryId, fields);
                        ackIds.push(entryId);
                    }
                    if (ackIds.length > 0) {
                        await this.redis.xack(TICKET_STREAM, CONSUMER_GROUP, ...ackIds);
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

    /**
     * PR4: parse + log only. PR5 replaces the log with the relay pipeline
     * described in the module doc (fence, thread post, lazy thread creation).
     * Message bodies are never logged at info.
     */
    private handleEntry(entryId: string, fields: string[]): void {
        const data = fieldValue(fields, "data");
        const event = data === undefined ? null : parseTicketEvent(data);
        if (event === null) {
            this.logger.warn({ entry_id: entryId }, "skipping unparseable stream entry");
            return;
        }
        this.logger.info(
            {
                entry_id: entryId,
                kind: event.kind,
                tenant_id: event.tenant_id,
                ticket_id: event.ticket_id,
            },
            "ticket event received",
        );
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
