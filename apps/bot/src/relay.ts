/**
 * Platform -> Discord relay (PR5, decisions D/E/F/G).
 *
 * Ordering per decision F, exactly: check the fence, post to Discord FIRST,
 * then SET bot:relayed:{message_id} NX EX 86400, then the consumer XACKs. A
 * crash between post and fence duplicates a message's text in the thread on
 * redelivery: accepted, harmless (the web store stays canonical). The reverse
 * order would silently DROP messages, which is worse.
 *
 * Binding resolution: bindings are hydrated at boot from the config route
 * (see guild-state.ts), so the cache normally answers immediately. The lazy
 * fallback here covers guilds joined after boot and hydration misses: on a
 * cache miss it hydrates each still-unknown guild until the event's tenant
 * appears. Events for tenants with no bound guild are negative-cached briefly
 * and dropped (web canonical); hydration ERRORS make the event retryable
 * instead of being mistaken for a missing binding.
 */

import type { Logger } from "pino";
import type { TicketEvent } from "./events.js";
import { hydrateGuildBinding, type GuildState } from "./guild-state.js";
import type { TenantApi, TicketRecord } from "./tenant-api.js";

export const NEGATIVE_TENANT_CACHE_MS = 60_000;
export const FENCE_TTL_SECONDS = 86_400;
/** Discord's hard per-message character cap. */
export const DISCORD_MESSAGE_LIMIT = 2000;
/** Discord's thread-name cap. */
const THREAD_NAME_LIMIT = 100;

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Mention policy for one post. Player-controlled text (subjects, display
 * names, bodies) is interpolated into posts, so NOTHING may ping by default;
 * the only live mentions ever allowed are the explicitly listed role ids
 * (the configured staff role in headers). Never user mentions: a mention in
 * a private thread would also INJECT that user into the thread.
 */
export type PostOptions = {
    pingRoles?: readonly string[];
};

/**
 * Thrown by DiscordPort implementations when the TARGET thread no longer
 * exists (Discord Unknown Channel, code 10003). The relay reacts by clearing
 * the recorded thread (tenant + local cache) and re-running the event so
 * lazy creation rebuilds the thread with backfill. Deliberately NOT used for
 * a missing tickets CHANNEL in createPrivateThread: that is a configuration
 * problem clearing thread ids cannot fix, so it stays on the retry path.
 */
export class UnknownChannelError extends Error {}

/** The Discord operations the relay needs; index.ts adapts the real client. */
export type DiscordPort = {
    /** Whether the gateway is connected and the guild cache is populated. */
    isReady(): boolean;
    /** Ids of every guild the bot is currently in. */
    guildIds(): string[];
    /** Create a private thread under a text channel; returns the thread id. */
    createPrivateThread(channelId: string, name: string): Promise<string>;
    /** Post one message (<= DISCORD_MESSAGE_LIMIT chars) under PostOptions. */
    postToThread(threadId: string, content: string, options?: PostOptions): Promise<void>;
    /** Best-effort: add a user to a private thread so they can see it. */
    addThreadMember(threadId: string, userId: string): Promise<void>;
};

export type Fence = {
    isRelayed(messageId: string): Promise<boolean>;
    markRelayed(messageId: string): Promise<void>;
};

/** Minimal slice of ioredis the fence uses (its own connection; see index.ts). */
type FenceRedis = {
    exists(key: string): Promise<number>;
    set(key: string, value: string, ex: "EX", seconds: number, nx: "NX"): Promise<unknown>;
};

/** SET NX EX relay fence (decision F). Keyed by the message's uuidv7 id. */
export class RedisFence implements Fence {
    constructor(private readonly redis: FenceRedis) {}

    async isRelayed(messageId: string): Promise<boolean> {
        return (await this.redis.exists(fenceKey(messageId))) === 1;
    }

    async markRelayed(messageId: string): Promise<void> {
        await this.redis.set(fenceKey(messageId), "1", "EX", FENCE_TTL_SECONDS, "NX");
    }
}

function fenceKey(messageId: string): string {
    return `bot:relayed:${messageId}`;
}

/**
 * Thrown for retryable failures (Discord or tenant down). The consumer
 * retries with backoff and only acks on success (decision G) up to a bounded
 * number of attempts, then drops (web canonical).
 */
export class RelayError extends Error {}

export type RelayDeps = {
    tenant: TenantApi;
    discord: DiscordPort;
    fence: Fence;
    state: GuildState;
    logger: Logger;
};

type EnsuredThread = {
    threadId: string;
    /** Message ids already posted as part of a just-created thread's backfill. */
    backfilled: ReadonlySet<string>;
};

export class TicketRelay {
    constructor(private readonly deps: RelayDeps) {}

    /**
     * Entry point the consumer calls per stream event, BEFORE it XACKs.
     *
     * Deleted-thread recovery (chosen flow, same-pass): when Discord reports
     * the target thread gone (10003), clear the recorded thread ids (tenant
     * DELETE route + local cache) and re-run the SAME event immediately, so
     * lazy creation rebuilds the thread with backfill without waiting for a
     * redelivery. If the second pass hits 10003 again the error degrades to a
     * retryable RelayError (the entry stays pending).
     */
    async handleEvent(event: TicketEvent): Promise<void> {
        try {
            await this.dispatch(event);
        } catch (err) {
            if (!(err instanceof UnknownChannelError)) {
                throw err;
            }
            await this.recoverDeletedThread(event, err);
            try {
                await this.dispatch(event);
            } catch (err2) {
                if (err2 instanceof UnknownChannelError) {
                    throw new RelayError(`thread still missing after clear: ${err2.message}`);
                }
                throw err2;
            }
        }
    }

    private async dispatch(event: TicketEvent): Promise<void> {
        switch (event.kind) {
            case "ticket.created":
                return this.handleCreated(event);
            case "ticket.message":
                return this.handleMessage(event);
            case "ticket.status":
                return this.handleStatus(event);
        }
    }

    /** Clear a deleted thread everywhere so lazy creation can rebuild it. */
    private async recoverDeletedThread(
        event: TicketEvent,
        cause: UnknownChannelError,
    ): Promise<void> {
        const guildId = await this.resolveGuild(event);
        if (guildId === null) {
            throw new RelayError("cannot clear deleted thread: no guild binding");
        }
        this.deps.logger.warn(
            { ticket_id: event.ticket_id, error: cause.message },
            "ticket thread deleted on discord; clearing recorded thread and recreating",
        );
        this.deps.state.forgetThread(event.ticket_id);
        const cleared = await this.deps.tenant.clearDiscordThread(event.ticket_id, guildId);
        if (!cleared.ok) {
            throw new RelayError(`clearing deleted thread failed: ${cleared.message}`);
        }
    }

    /** ticket.created: make sure the private thread exists (with backfill). */
    private async handleCreated(event: TicketEvent): Promise<void> {
        const guildId = await this.resolveGuild(event);
        if (guildId === null) {
            return;
        }
        await this.ensureThread(event, guildId);
    }

    /** ticket.message: decision F pipeline (fence check, post, fence set). */
    private async handleMessage(event: TicketEvent): Promise<void> {
        // Belt and braces: the tenant never publishes origin='discord'
        // messages (it is the loop-prevention invariant), but a bug there must
        // not become an echo loop here.
        if (event.origin === "discord") {
            this.deps.logger.warn(
                { ticket_id: event.ticket_id },
                "dropping discord-origin event the producer should never publish",
            );
            return;
        }
        if (event.message_id === undefined) {
            this.deps.logger.warn(
                { ticket_id: event.ticket_id },
                "dropping ticket.message without message_id (fence key required)",
            );
            return;
        }
        if (event.body === undefined || event.body === "") {
            this.deps.logger.warn(
                { ticket_id: event.ticket_id, message_id: event.message_id },
                "dropping ticket.message without a body",
            );
            return;
        }
        if (await this.fenceCheck(event.message_id)) {
            return; // Already posted on an earlier delivery; the ack still runs.
        }

        const guildId = await this.resolveGuild(event);
        if (guildId === null) {
            return;
        }
        const ensured = await this.ensureThread(event, guildId);
        if (ensured === null) {
            return;
        }
        // A just-created thread's backfill already contains this message (and
        // fenced it); do not post it twice.
        if (!ensured.backfilled.has(event.message_id)) {
            await this.post(
                ensured.threadId,
                renderMessage(event.author_display ?? event.author_kind ?? "unknown", event.body),
            );
        }
        await this.fenceMark(event.message_id);
    }

    /**
     * ticket.status: compact status line, but only into an EXISTING thread. A
     * bare status line is not worth creating a thread for; the next message
     * event creates it with full backfill.
     */
    private async handleStatus(event: TicketEvent): Promise<void> {
        if (event.status === undefined) {
            this.deps.logger.warn({ ticket_id: event.ticket_id }, "dropping ticket.status without status");
            return;
        }
        let threadId = this.deps.state.threadForTicket(event.ticket_id);
        if (threadId === undefined) {
            const guildId = await this.resolveGuild(event);
            if (guildId === null) {
                return;
            }
            const res = await this.deps.tenant.getTicket(event.ticket_id, guildId);
            if (!res.ok) {
                if (res.kind === "not_found") {
                    return;
                }
                throw new RelayError(`ticket fetch failed: ${res.message}`);
            }
            this.adoptTicket(guildId, res.ticket);
            threadId = res.ticket.discord_thread_id ?? undefined;
        }
        if (threadId === undefined) {
            return; // No thread yet: skip by design.
        }
        await this.post(threadId, `Status changed to **${event.status}**.`);
    }

    /**
     * tenant -> guild resolution: cache (normally filled by boot hydration),
     * then the lazy fallback described in the module doc. Returns null (drop
     * the event) for tenants with no bound guild.
     */
    private async resolveGuild(event: TicketEvent): Promise<string | null> {
        const cached = this.deps.state.guildForTenant(event.tenant_id);
        if (cached !== undefined) {
            return cached;
        }
        if (this.deps.state.isTenantUnknown(event.tenant_id)) {
            return null;
        }
        // Ordering guard: before ClientReady the guild cache is empty, and a
        // hydration sweep over zero guilds would wrongly negative-cache the
        // tenant and DROP the boot backlog. The consumer only starts after
        // ready + hydration (index.ts), but an ordering bug must surface as a
        // retryable error, never a silent drop.
        const guildIds = this.deps.discord.guildIds();
        if (!this.deps.discord.isReady() || guildIds.length === 0) {
            throw new RelayError("discord client not ready (empty guild cache); event will retry");
        }
        let sawError = false;
        for (const guildId of guildIds) {
            if (
                this.deps.state.tenantForGuild(guildId) !== undefined ||
                this.deps.state.isGuildUnlinked(guildId)
            ) {
                continue;
            }
            const outcome = await hydrateGuildBinding(guildId, {
                tenant: this.deps.tenant,
                state: this.deps.state,
                logger: this.deps.logger,
            });
            if (outcome === "error") {
                sawError = true;
            }
            const found = this.deps.state.guildForTenant(event.tenant_id);
            if (found !== undefined) {
                return found;
            }
        }
        if (sawError) {
            // Tenant down mid-hydration is retryable, not a missing binding.
            throw new RelayError("binding hydration failed; event will retry");
        }
        this.deps.state.markTenantUnknown(event.tenant_id, NEGATIVE_TENANT_CACHE_MS);
        this.deps.logger.warn(
            { tenant_id: event.tenant_id },
            "no bound guild for tenant; dropping event (web store is canonical)",
        );
        return null;
    }

    /**
     * Lazy thread creation (decision E): cached thread, else the recorded one
     * from GET, else create in the configured channel, post a header +
     * backfill of the returned messages (already internal-note-free: the
     * tenant's internal GET excludes notes and the bot deliberately does not
     * re-filter), then record it via POST discord-thread. A 409 means another
     * writer recorded a different thread first: adopt theirs.
     */
    private async ensureThread(event: TicketEvent, guildId: string): Promise<EnsuredThread | null> {
        const cachedThread = this.deps.state.threadForTicket(event.ticket_id);
        if (cachedThread !== undefined) {
            return { threadId: cachedThread, backfilled: EMPTY_SET };
        }

        const res = await this.deps.tenant.getTicket(event.ticket_id, guildId);
        if (!res.ok) {
            if (res.kind === "not_found") {
                this.deps.logger.warn(
                    { ticket_id: event.ticket_id, guild_id: guildId },
                    "ticket not readable for its guild; dropping event",
                );
                return null;
            }
            throw new RelayError(`ticket fetch failed: ${res.message}`);
        }
        this.adoptTicket(guildId, res.ticket);
        if (res.ticket.discord_thread_id) {
            return { threadId: res.ticket.discord_thread_id, backfilled: EMPTY_SET };
        }

        const channelId = res.ticket.discord_channel_id ?? this.deps.state.channelForGuild(guildId);
        if (channelId === undefined) {
            // Defensive: hydration and setup both record the channel alongside
            // the binding, so a bound guild without a channel should not occur.
            this.deps.logger.error(
                { ticket_id: event.ticket_id, guild_id: guildId },
                "tickets channel unknown for bound guild; dropping event",
            );
            return null;
        }

        let threadId: string;
        try {
            threadId = await this.deps.discord.createPrivateThread(
                channelId,
                threadName(event.ticket_id, res.ticket.subject),
            );
        } catch (err) {
            throw new RelayError(`thread creation failed: ${describe(err)}`);
        }
        // The header is the ONLY post allowed a live mention, and only the
        // configured staff role: subject and display names are player text.
        const staffRole = this.deps.state.staffRoleForGuild(guildId);
        await this.post(threadId, this.headerText(event, res.ticket, staffRole), {
            pingRoles: staffRole !== undefined ? [staffRole] : [],
        });
        if (res.ticket.opener_discord_user_id) {
            await this.deps.discord
                .addThreadMember(threadId, res.ticket.opener_discord_user_id)
                .catch(() => undefined); // Best-effort; staff can add them.
        }
        if (res.messages.length > 0) {
            await this.post(threadId, `Backfilling ${res.messages.length} earlier message(s):`);
            for (const message of res.messages) {
                // Post-then-fence per message (decision F ordering). Fencing
                // each backfilled id here, not just tracking a per-call set,
                // keeps a queued created-then-messages backlog from posting
                // every message a second time when its own event arrives.
                await this.post(threadId, renderMessage(message.author_display, message.body));
                await this.fenceMark(message.id);
            }
        }

        const recorded = await this.deps.tenant.recordDiscordThread(event.ticket_id, {
            guildId,
            discordChannelId: channelId,
            discordThreadId: threadId,
        });
        if (!recorded.ok) {
            if (recorded.kind === "conflict") {
                // Concurrent creation (e.g. /ticket open racing this event):
                // the recorded thread is canonical; adopt it and abandon ours.
                this.deps.logger.error(
                    { ticket_id: event.ticket_id, orphan_thread_id: threadId },
                    "different thread already recorded; adopting it (orphan thread left in place)",
                );
                const again = await this.deps.tenant.getTicket(event.ticket_id, guildId);
                if (again.ok && again.ticket.discord_thread_id) {
                    this.deps.state.recordThread(event.ticket_id, again.ticket.discord_thread_id);
                    return { threadId: again.ticket.discord_thread_id, backfilled: EMPTY_SET };
                }
                throw new RelayError("thread conflict reported but no recorded thread is readable");
            }
            throw new RelayError(`recording thread failed: ${recorded.message}`);
        }
        this.deps.state.recordThread(event.ticket_id, threadId);
        return { threadId, backfilled: new Set(res.messages.map((m) => m.id)) };
    }

    private adoptTicket(guildId: string, ticket: TicketRecord): void {
        if (ticket.discord_channel_id) {
            this.deps.state.recordChannel(guildId, ticket.discord_channel_id);
        }
        if (ticket.discord_thread_id) {
            this.deps.state.recordThread(ticket.id, ticket.discord_thread_id);
        }
    }

    private headerText(
        event: TicketEvent,
        ticket: TicketRecord,
        staffRole: string | undefined,
    ): string {
        const opener = event.opener_display ?? "a player";
        const category = ticket.category ? ` (category: ${ticket.category})` : "";
        const ping = staffRole !== undefined ? ` <@&${staffRole}>` : "";
        return `New ${ticket.type ?? "ticket"} from **${opener}**${category}: ${ticket.subject ?? ""}${ping}`;
    }

    /**
     * Chunked post. Discord failures become retryable RelayErrors, except a
     * deleted thread (UnknownChannelError), which propagates for the
     * clear-and-recreate recovery in handleEvent.
     */
    private async post(threadId: string, content: string, options?: PostOptions): Promise<void> {
        try {
            for (const chunk of chunkContent(content)) {
                await this.deps.discord.postToThread(threadId, chunk, options);
            }
        } catch (err) {
            if (err instanceof UnknownChannelError) {
                throw err;
            }
            throw new RelayError(`discord post failed: ${describe(err)}`);
        }
    }

    /** Fence read; Redis trouble is retryable, never a silent skip. */
    private async fenceCheck(messageId: string): Promise<boolean> {
        try {
            return await this.deps.fence.isRelayed(messageId);
        } catch (err) {
            throw new RelayError(`fence read failed: ${describe(err)}`);
        }
    }

    /** Fence write; a failure after the post retries the event (decision F: duplicate over drop). */
    private async fenceMark(messageId: string): Promise<void> {
        try {
            await this.deps.fence.markRelayed(messageId);
        } catch (err) {
            throw new RelayError(`fence write failed: ${describe(err)}`);
        }
    }
}

export function renderMessage(authorDisplay: string, body: string): string {
    return `**${authorDisplay}**: ${body}`;
}

/** Split into Discord-sized chunks (plain UTF-16 slices; fine for v1 text). */
export function chunkContent(content: string): string[] {
    if (content.length <= DISCORD_MESSAGE_LIMIT) {
        return [content];
    }
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += DISCORD_MESSAGE_LIMIT) {
        chunks.push(content.slice(i, i + DISCORD_MESSAGE_LIMIT));
    }
    return chunks;
}

export function threadName(ticketId: string, subject?: string): string {
    const base = `ticket-${ticketId.slice(0, 8)}`;
    const name = subject ? `${base}: ${subject}` : base;
    return name.length > THREAD_NAME_LIMIT ? `${name.slice(0, THREAD_NAME_LIMIT - 3)}...` : name;
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
