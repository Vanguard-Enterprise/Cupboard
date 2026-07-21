import { describe, expect, it, vi } from "vitest";
import { GuildState } from "./guild-state.js";
import { handleGuildMessage, type IncomingMessage } from "./message-listener.js";
import type { TenantApi } from "./tenant-api.js";

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as import("pino").Logger;

const TICKET_ID = "0197a6a4-0000-7000-8000-00000000cccc";
const BOT_USER_ID = "bot-user-1";

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
        id: "dmsg-1",
        guildId: "guild-1",
        channelId: "thread-1",
        inThread: true,
        authorId: "user-1",
        authorIsBot: false,
        authorDisplay: "PlayerOne",
        memberRoleIds: [],
        content: "hello staff",
        ...overrides,
    };
}

function makeDeps(options: { state?: GuildState } = {}) {
    const state = options.state ?? new GuildState();
    const tenant = {
        postTicketMessage: vi.fn(async () => ({ ok: true as const, deduped: false })),
        getTicketByThread: vi.fn(async () => ({
            ok: true as const,
            ticket: { id: TICKET_ID },
        })),
        getDiscordConfig: vi.fn(async () => ({
            ok: false as const,
            kind: "not_found" as const,
            message: "guild not linked",
        })),
    };
    const deps = {
        tenant: tenant as unknown as TenantApi,
        state,
        logger: silentLogger,
        botUserId: BOT_USER_ID,
        sleep: async () => undefined,
    };
    return { deps, tenant, state };
}

describe("handleGuildMessage echo-guard", () => {
    it("ignores the bot's own messages", async () => {
        const { deps, tenant } = makeDeps();
        await handleGuildMessage(
            makeMessage({ authorId: BOT_USER_ID, authorIsBot: true }),
            deps,
        );
        expect(tenant.getTicketByThread).not.toHaveBeenCalled();
        expect(tenant.postTicketMessage).not.toHaveBeenCalled();
    });

    it("ignores every other bot and webhook", async () => {
        const { deps, tenant } = makeDeps();
        await handleGuildMessage(makeMessage({ authorIsBot: true }), deps);
        expect(tenant.postTicketMessage).not.toHaveBeenCalled();
    });

    it("ignores messages outside threads", async () => {
        const { deps, tenant } = makeDeps();
        await handleGuildMessage(makeMessage({ inThread: false }), deps);
        expect(tenant.getTicketByThread).not.toHaveBeenCalled();
    });

    it("ignores unknown threads and negative-caches the 404", async () => {
        const { deps, tenant } = makeDeps();
        tenant.getTicketByThread.mockResolvedValue({
            ok: false,
            kind: "not_found",
            message: "no ticket",
        } as never);

        await handleGuildMessage(makeMessage(), deps);
        await handleGuildMessage(makeMessage({ id: "dmsg-2" }), deps);

        expect(tenant.getTicketByThread).toHaveBeenCalledTimes(1);
        expect(tenant.postTicketMessage).not.toHaveBeenCalled();
    });
});

describe("handleGuildMessage relay", () => {
    it("resolves the thread's ticket, posts with the discord_message_id, and caches", async () => {
        const { deps, tenant, state } = makeDeps();
        await handleGuildMessage(makeMessage(), deps);

        expect(tenant.postTicketMessage).toHaveBeenCalledWith(TICKET_ID, {
            guildId: "guild-1",
            discordMessageId: "dmsg-1",
            authorDisplay: "PlayerOne",
            authorKind: "player",
            body: "hello staff",
        });
        expect(state.ticketForThread("thread-1")).toBe(TICKET_ID);

        // Second message reuses the cache: no second by-thread lookup.
        await handleGuildMessage(makeMessage({ id: "dmsg-2" }), deps);
        expect(tenant.getTicketByThread).toHaveBeenCalledTimes(1);
    });

    it("marks the author staff when they carry the bound staff role", async () => {
        const state = new GuildState();
        state.recordStaffRole("guild-1", "role-staff");
        const { deps, tenant } = makeDeps({ state });

        await handleGuildMessage(
            makeMessage({ memberRoleIds: ["role-other", "role-staff"], authorDisplay: "Mod" }),
            deps,
        );
        expect(tenant.postTicketMessage).toHaveBeenCalledWith(
            TICKET_ID,
            expect.objectContaining({ authorKind: "staff", authorDisplay: "Mod" }),
        );
    });

    it("lazily hydrates the guild config for staff detection when the binding is unknown", async () => {
        const { deps, tenant } = makeDeps(); // binding unknown, role unknown
        tenant.getDiscordConfig.mockResolvedValue({
            ok: true,
            config: {
                tenant_id: "tenant-1",
                tickets_channel_id: "chan-1",
                staff_role_id: "role-staff",
            },
        } as never);

        await handleGuildMessage(
            makeMessage({ memberRoleIds: ["role-staff"], authorDisplay: "Mod" }),
            deps,
        );

        expect(tenant.getDiscordConfig).toHaveBeenCalledWith("guild-1");
        expect(tenant.postTicketMessage).toHaveBeenCalledWith(
            TICKET_ID,
            expect.objectContaining({ authorKind: "staff" }),
        );
    });

    it("does NOT re-hydrate when the binding is known but no staff role is configured", async () => {
        const state = new GuildState();
        state.recordBinding("guild-1", "tenant-1"); // hydrated, role genuinely absent
        const { deps, tenant } = makeDeps({ state });

        await handleGuildMessage(makeMessage({ memberRoleIds: ["role-staff"] }), deps);

        expect(tenant.getDiscordConfig).not.toHaveBeenCalled();
        expect(tenant.postTicketMessage).toHaveBeenCalledWith(
            TICKET_ID,
            expect.objectContaining({ authorKind: "player" }),
        );
    });

    it("defaults to player when the staff role is unknown or not held", async () => {
        const state = new GuildState();
        state.recordStaffRole("guild-1", "role-staff");
        const { deps, tenant } = makeDeps({ state });

        await handleGuildMessage(makeMessage({ memberRoleIds: ["role-other"] }), deps);
        expect(tenant.postTicketMessage).toHaveBeenCalledWith(
            TICKET_ID,
            expect.objectContaining({ authorKind: "player" }),
        );
    });

    it("treats a deduped reply as success (no retries)", async () => {
        const { deps, tenant } = makeDeps();
        tenant.postTicketMessage.mockResolvedValue({ ok: true, deduped: true } as never);

        await handleGuildMessage(makeMessage(), deps);
        expect(tenant.postTicketMessage).toHaveBeenCalledTimes(1);
    });

    it("retries transient tenant failures, then drops without throwing", async () => {
        const { deps, tenant } = makeDeps();
        tenant.postTicketMessage.mockResolvedValue({
            ok: false,
            kind: "unreachable",
            message: "tenant service unreachable: timeout",
        } as never);

        await expect(handleGuildMessage(makeMessage(), deps)).resolves.toBeUndefined();
        expect(tenant.postTicketMessage).toHaveBeenCalledTimes(3);
    });

    it("skips empty content", async () => {
        const { deps, tenant } = makeDeps();
        await handleGuildMessage(makeMessage({ content: "   " }), deps);
        expect(tenant.postTicketMessage).not.toHaveBeenCalled();
    });
});
