/**
 * In-memory binding and thread state for the multi-guild bot (PR5).
 *
 * Populated from three sources:
 *   - Boot-time hydration: on ClientReady, `hydrateGuildBinding` calls
 *     GET /internal/tickets/discord/config?guild_id= for every guild the bot
 *     is in (tenant id, tickets channel, staff role). This makes the state
 *     restart-proof: a fresh pod relearns every binding before the relay
 *     handles its first event.
 *   - The lazy per-event fallback in relay.ts, which hydrates guilds joined
 *     after boot (or hydration misses) on demand.
 *   - /cupboard setup, which teaches the channel and staff role at bind time
 *     (the bind response is a bare 204, so the tenant id still arrives via
 *     hydration).
 * Ticket payloads additionally teach thread/channel mappings as they flow.
 *
 * Negative caches keep 404s from hammering the tenant: unlinked guilds and
 * unbindable tenants are remembered briefly; hydration ERRORS are never
 * negative-cached (they retry lazily).
 */

import type { Logger } from "pino";
import type { TenantApi } from "./tenant-api.js";

/** How long an unlinked guild's 404 is trusted before re-asking. */
export const GUILD_UNLINKED_CACHE_MS = 60_000;

export class GuildState {
    private readonly tenantByGuildMap = new Map<string, string>();
    private readonly guildByTenantMap = new Map<string, string>();
    private readonly channelByGuildMap = new Map<string, string>();
    private readonly staffRoleByGuildMap = new Map<string, string>();
    private readonly ticketByThreadMap = new Map<string, string>();
    private readonly threadByTicketMap = new Map<string, string>();
    /** Negative caches: id -> epoch ms after which a retry is allowed. */
    private readonly unknownTenants = new Map<string, number>();
    private readonly unknownThreads = new Map<string, number>();
    private readonly unlinkedGuilds = new Map<string, number>();

    recordBinding(guildId: string, tenantId: string): void {
        this.tenantByGuildMap.set(guildId, tenantId);
        this.guildByTenantMap.set(tenantId, guildId);
        this.unknownTenants.delete(tenantId);
        this.unlinkedGuilds.delete(guildId);
    }

    tenantForGuild(guildId: string): string | undefined {
        return this.tenantByGuildMap.get(guildId);
    }

    guildForTenant(tenantId: string): string | undefined {
        return this.guildByTenantMap.get(tenantId);
    }

    recordChannel(guildId: string, channelId: string): void {
        this.channelByGuildMap.set(guildId, channelId);
    }

    channelForGuild(guildId: string): string | undefined {
        return this.channelByGuildMap.get(guildId);
    }

    recordStaffRole(guildId: string, roleId: string | undefined): void {
        if (roleId === undefined) {
            this.staffRoleByGuildMap.delete(guildId);
        } else {
            this.staffRoleByGuildMap.set(guildId, roleId);
        }
    }

    staffRoleForGuild(guildId: string): string | undefined {
        return this.staffRoleByGuildMap.get(guildId);
    }

    recordThread(ticketId: string, threadId: string): void {
        this.threadByTicketMap.set(ticketId, threadId);
        this.ticketByThreadMap.set(threadId, ticketId);
        this.unknownThreads.delete(threadId);
    }

    threadForTicket(ticketId: string): string | undefined {
        return this.threadByTicketMap.get(ticketId);
    }

    /** Drop a ticket's thread mapping (e.g. the thread was deleted on Discord). */
    forgetThread(ticketId: string): void {
        const threadId = this.threadByTicketMap.get(ticketId);
        if (threadId !== undefined) {
            this.ticketByThreadMap.delete(threadId);
            this.threadByTicketMap.delete(ticketId);
        }
    }

    ticketForThread(threadId: string): string | undefined {
        return this.ticketByThreadMap.get(threadId);
    }

    markTenantUnknown(tenantId: string, ttlMs: number): void {
        this.unknownTenants.set(tenantId, Date.now() + ttlMs);
    }

    isTenantUnknown(tenantId: string): boolean {
        return this.checkNegative(this.unknownTenants, tenantId);
    }

    markThreadUnknown(threadId: string, ttlMs: number): void {
        this.unknownThreads.set(threadId, Date.now() + ttlMs);
    }

    isThreadUnknown(threadId: string): boolean {
        return this.checkNegative(this.unknownThreads, threadId);
    }

    markGuildUnlinked(guildId: string, ttlMs: number): void {
        this.unlinkedGuilds.set(guildId, Date.now() + ttlMs);
    }

    isGuildUnlinked(guildId: string): boolean {
        return this.checkNegative(this.unlinkedGuilds, guildId);
    }

    private checkNegative(cache: Map<string, number>, key: string): boolean {
        const until = cache.get(key);
        if (until === undefined) {
            return false;
        }
        if (Date.now() >= until) {
            cache.delete(key);
            return false;
        }
        return true;
    }
}

/**
 * Fetch one guild's binding config and fold it into the state. "unlinked"
 * (404) is negative-cached briefly; "error" (tenant unreachable etc.) is NOT
 * cached so the next event or command retries lazily.
 */
export async function hydrateGuildBinding(
    guildId: string,
    deps: { tenant: TenantApi; state: GuildState; logger: Logger },
): Promise<"linked" | "unlinked" | "error"> {
    const result = await deps.tenant.getDiscordConfig(guildId);
    if (result.ok) {
        deps.state.recordBinding(guildId, result.config.tenant_id);
        deps.state.recordChannel(guildId, result.config.tickets_channel_id);
        deps.state.recordStaffRole(guildId, result.config.staff_role_id ?? undefined);
        deps.logger.info(
            { guild_id: guildId, tenant_id: result.config.tenant_id },
            "guild binding hydrated",
        );
        return "linked";
    }
    if (result.kind === "not_found") {
        deps.state.markGuildUnlinked(guildId, GUILD_UNLINKED_CACHE_MS);
        return "unlinked";
    }
    deps.logger.warn(
        { guild_id: guildId, error: result.message },
        "guild binding hydration failed; will retry lazily",
    );
    return "error";
}
