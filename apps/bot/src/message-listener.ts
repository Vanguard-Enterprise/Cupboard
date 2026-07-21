/**
 * Discord -> platform relay (PR5, decisions E/F).
 *
 * Echo-guard (decision F): the bot ignores its own messages, every other
 * bot/webhook, and anything outside a known ticket thread. Dedupe is
 * server-side: the POST carries discord_message_id and the tenant inserts
 * ON CONFLICT DO NOTHING on its unique index; a {deduped:true} reply is
 * success, not an error.
 *
 * Failure stance (decision G): on tenant 5xx/timeout the relay retries a few
 * times with backoff, then logs an error and DROPS the message without
 * crashing. The web store is canonical and a lost Discord->web message is
 * re-postable by its author; a crash loop would take down the whole relay.
 */

import type { Logger } from "pino";
import { hydrateGuildBinding, type GuildState } from "./guild-state.js";
import type { TenantApi } from "./tenant-api.js";

export const THREAD_NEGATIVE_CACHE_MS = 60_000;
const MAX_POST_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1000;

/** The slice of a Discord message the relay reads (structural for tests). */
export type IncomingMessage = {
    id: string;
    guildId: string | null;
    /** For thread messages this is the THREAD id. */
    channelId: string;
    inThread: boolean;
    authorId: string;
    authorIsBot: boolean;
    authorDisplay: string;
    /** Resolved role ids of the author's guild member, when available. */
    memberRoleIds: readonly string[];
    /** Message content with attachment URLs already appended by the adapter. */
    content: string;
};

export type MessageRelayDeps = {
    tenant: TenantApi;
    state: GuildState;
    logger: Logger;
    botUserId: string;
    /** Injectable for tests; defaults to a real timer. */
    sleep?: (ms: number) => Promise<void>;
};

export async function handleGuildMessage(
    message: IncomingMessage,
    deps: MessageRelayDeps,
): Promise<void> {
    // Echo-guard: own messages would loop (we post relays into these threads),
    // and other bots/webhooks are out of scope for v1 ticket transcripts.
    if (message.authorIsBot || message.authorId === deps.botUserId) {
        return;
    }
    if (message.guildId === null || !message.inThread) {
        return;
    }

    const ticketId = await resolveTicket(message, deps);
    if (ticketId === null) {
        return;
    }

    const body = message.content.trim();
    if (body === "") {
        return; // Nothing textual to relay (stickers/embeds-only, etc.).
    }

    // Staff detection: the bound staff role, hydrated at boot from the config
    // route (guild-state.ts). When the role is unknown AND the guild's binding
    // itself is unhydrated (e.g. joined after boot), hydrate once before
    // deciding; a guild that is hydrated but has no configured role, or a
    // failed hydration, defaults the author to "player": the safe direction.
    let staffRole = deps.state.staffRoleForGuild(message.guildId);
    if (
        staffRole === undefined &&
        deps.state.tenantForGuild(message.guildId) === undefined &&
        !deps.state.isGuildUnlinked(message.guildId)
    ) {
        await hydrateGuildBinding(message.guildId, {
            tenant: deps.tenant,
            state: deps.state,
            logger: deps.logger,
        });
        staffRole = deps.state.staffRoleForGuild(message.guildId);
    }
    const authorKind =
        staffRole !== undefined && message.memberRoleIds.includes(staffRole) ? "staff" : "player";

    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS; attempt++) {
        const result = await deps.tenant.postTicketMessage(ticketId, {
            guildId: message.guildId,
            discordMessageId: message.id,
            authorDisplay: message.authorDisplay,
            authorKind,
            body,
        });
        if (result.ok) {
            deps.logger.info(
                {
                    ticket_id: ticketId,
                    discord_message_id: message.id,
                    author_kind: authorKind,
                    deduped: result.deduped,
                },
                "discord message relayed",
            );
            return;
        }
        if (result.kind === "not_found") {
            // The ticket vanished under the thread (or the binding moved);
            // forget the mapping and let the next message re-resolve.
            deps.state.markThreadUnknown(message.channelId, THREAD_NEGATIVE_CACHE_MS);
            deps.logger.warn(
                { ticket_id: ticketId, thread_id: message.channelId },
                "ticket not found for thread message; dropping",
            );
            return;
        }
        if (attempt < MAX_POST_ATTEMPTS) {
            deps.logger.warn(
                { ticket_id: ticketId, attempt, error: result.message },
                "message relay attempt failed; retrying",
            );
            await sleep(RETRY_BACKOFF_MS * attempt);
        } else {
            deps.logger.error(
                { ticket_id: ticketId, discord_message_id: message.id, error: result.message },
                "dropping discord message after retries (web store is canonical; the author can repost)",
            );
        }
    }
}

/**
 * thread -> ticket resolution: cache, then GET by-thread with the message's
 * guild id. 404s are negative-cached briefly so ordinary (non-ticket) thread
 * chatter does not hammer the tenant; tenant-unreachable is NOT negative
 * cached (a real ticket thread would go silent for the TTL).
 */
async function resolveTicket(
    message: IncomingMessage,
    deps: MessageRelayDeps,
): Promise<string | null> {
    const cached = deps.state.ticketForThread(message.channelId);
    if (cached !== undefined) {
        return cached;
    }
    if (deps.state.isThreadUnknown(message.channelId)) {
        return null;
    }
    const result = await deps.tenant.getTicketByThread(message.channelId, message.guildId ?? "");
    if (result.ok) {
        deps.state.recordThread(result.ticket.id, message.channelId);
        if (message.guildId !== null && result.ticket.discord_channel_id) {
            deps.state.recordChannel(message.guildId, result.ticket.discord_channel_id);
        }
        return result.ticket.id;
    }
    if (result.kind === "not_found") {
        deps.state.markThreadUnknown(message.channelId, THREAD_NEGATIVE_CACHE_MS);
        return null;
    }
    deps.logger.warn(
        { thread_id: message.channelId, error: result.message },
        "thread lookup failed; dropping message",
    );
    return null;
}
