import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { GuildState } from "./guild-state.js";
import type { DiscordPort } from "./relay.js";
import type { TenantApi } from "./tenant-api.js";
import {
    handleTicketClose,
    handleTicketOpen,
    type TicketCloseInteraction,
    type TicketOpenInteraction,
} from "./ticket-commands.js";

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as import("pino").Logger;

const TICKET_ID = "0197a6a4-0000-7000-8000-00000000dddd";

function makeDeps(options: { state?: GuildState } = {}) {
    const state = options.state ?? new GuildState();
    const tenant = {
        createTicket: vi.fn(async () => ({
            ok: true as const,
            ticket: { id: TICKET_ID, discord_channel_id: null },
        })),
        recordDiscordThread: vi.fn(async () => ({ ok: true as const })),
        getTicket: vi.fn(),
        getTicketByThread: vi.fn(async () => ({ ok: true as const, ticket: { id: TICKET_ID } })),
        getDiscordConfig: vi.fn(async () => ({
            ok: false as const,
            kind: "not_found" as const,
            message: "guild not linked",
        })),
        closeTicket: vi.fn(async () => ({ ok: true as const })),
    };
    const discord = {
        guildIds: () => ["guild-1"],
        createPrivateThread: vi.fn(async () => "thread-new"),
        postToThread: vi.fn(async () => undefined),
        addThreadMember: vi.fn(async () => undefined),
    };
    return {
        deps: {
            tenant: tenant as unknown as TenantApi,
            state,
            discord: discord as unknown as DiscordPort,
            logger: silentLogger,
        },
        tenant,
        discord,
        state,
    };
}

function openInteraction(options: {
    body?: string | null;
    category?: string | null;
    guildId?: string | null;
}) {
    const reply = vi.fn(async () => undefined);
    const interaction: TicketOpenInteraction = {
        guildId: options.guildId === undefined ? "guild-1" : options.guildId,
        user: { id: "user-7", username: "playerseven" },
        member: { displayName: "PlayerSeven" },
        options: {
            getString: ((name: string) => {
                if (name === "subject") {
                    return "Lost my kit";
                }
                if (name === "body") {
                    return options.body ?? null;
                }
                return options.category ?? null;
            }) as TicketOpenInteraction["options"]["getString"],
        },
        reply,
    };
    return { interaction, reply };
}

function replyContent(reply: ReturnType<typeof vi.fn>): string {
    const call = reply.mock.calls[0]?.[0] as { content: string; flags: number };
    expect(call.flags).toBe(MessageFlags.Ephemeral);
    return call.content;
}

describe("handleTicketOpen", () => {
    it("creates the ticket, the thread in the cached channel, records it, and links it", async () => {
        const state = new GuildState();
        state.recordChannel("guild-1", "chan-tickets");
        const { deps, tenant, discord } = makeDeps({ state });
        const { interaction, reply } = openInteraction({ body: "It vanished" });

        await handleTicketOpen(interaction, deps);

        expect(tenant.createTicket).toHaveBeenCalledWith({
            guildId: "guild-1",
            openerDiscordUserId: "user-7",
            openerDisplay: "PlayerSeven",
            subject: "Lost my kit",
            category: undefined,
            body: "It vanished",
        });
        expect(discord.createPrivateThread).toHaveBeenCalledWith(
            "chan-tickets",
            expect.stringContaining("Lost my kit"),
        );
        expect(tenant.recordDiscordThread).toHaveBeenCalledWith(TICKET_ID, {
            guildId: "guild-1",
            discordChannelId: "chan-tickets",
            discordThreadId: "thread-new",
        });
        expect(discord.addThreadMember).toHaveBeenCalledWith("thread-new", "user-7");
        expect(replyContent(reply)).toContain("<#thread-new>");
        expect(state.ticketForThread("thread-new")).toBe(TICKET_ID);
    });

    it("replies with a friendly failure when the guild is not bound", async () => {
        const { deps, tenant, discord } = makeDeps();
        tenant.createTicket.mockResolvedValue({
            ok: false,
            kind: "not_found",
            message: "no binding for guild",
        } as never);
        const { interaction, reply } = openInteraction({});

        await handleTicketOpen(interaction, deps);

        expect(discord.createPrivateThread).not.toHaveBeenCalled();
        expect(replyContent(reply)).toContain("not be linked");
    });

    it("hydrates the guild config when the channel is unknown, then threads there", async () => {
        const { deps, tenant, discord } = makeDeps(); // no cached channel
        tenant.getDiscordConfig.mockResolvedValue({
            ok: true,
            config: { tenant_id: "tenant-1", tickets_channel_id: "chan-hydrated" },
        } as never);
        const { interaction, reply } = openInteraction({});

        await handleTicketOpen(interaction, deps);

        expect(discord.createPrivateThread).toHaveBeenCalledWith(
            "chan-hydrated",
            expect.stringContaining("Lost my kit"),
        );
        expect(replyContent(reply)).toContain("<#thread-new>");
    });

    it("still confirms (threadless) when hydration cannot find a channel either", async () => {
        const { deps, discord } = makeDeps(); // no cached channel; config 404s

        const { interaction, reply } = openInteraction({});
        await handleTicketOpen(interaction, deps);

        expect(discord.createPrivateThread).not.toHaveBeenCalled();
        expect(replyContent(reply)).toContain("staff will follow up");
    });

    it("headers ping only the staff role; player subject text cannot ping", async () => {
        const state = new GuildState();
        state.recordChannel("guild-1", "chan-tickets");
        state.recordStaffRole("guild-1", "role-staff");
        const { deps, discord } = makeDeps({ state });
        const { interaction } = openInteraction({});

        await handleTicketOpen(interaction, deps);

        const headerCall = discord.postToThread.mock.calls[0] as unknown[];
        expect(headerCall?.[2]).toEqual({ pingRoles: ["role-staff"] });
    });

    it("leaves the thread cache EMPTY when recording fails (no orphan poisoning)", async () => {
        const state = new GuildState();
        state.recordChannel("guild-1", "chan-tickets");
        const { deps, tenant } = makeDeps({ state });
        tenant.recordDiscordThread.mockResolvedValue({
            ok: false,
            kind: "unreachable",
            message: "tenant service unreachable: timeout",
        } as never);
        const { interaction, reply } = openInteraction({});

        await handleTicketOpen(interaction, deps);

        expect(state.threadForTicket(TICKET_ID)).toBeUndefined();
        expect(state.ticketForThread("thread-new")).toBeUndefined();
        // No link to the unconfirmed thread in the reply either.
        expect(replyContent(reply)).not.toContain("<#thread-new>");
    });

    it("leaves the cache empty when a 409 adoption re-fetch fails too", async () => {
        const state = new GuildState();
        state.recordChannel("guild-1", "chan-tickets");
        const { deps, tenant } = makeDeps({ state });
        tenant.recordDiscordThread.mockResolvedValue({
            ok: false,
            kind: "conflict",
            message: "different thread recorded",
        } as never);
        tenant.getTicket.mockResolvedValue({
            ok: false,
            kind: "unreachable",
            message: "tenant service unreachable: timeout",
        } as never);
        const { interaction, reply } = openInteraction({});

        await handleTicketOpen(interaction, deps);

        expect(state.threadForTicket(TICKET_ID)).toBeUndefined();
        expect(replyContent(reply)).toContain("staff will follow up");
    });

    it("adopts the consumer's thread when recording conflicts", async () => {
        const state = new GuildState();
        state.recordChannel("guild-1", "chan-tickets");
        const { deps, tenant } = makeDeps({ state });
        tenant.recordDiscordThread.mockResolvedValue({
            ok: false,
            kind: "conflict",
            message: "different thread recorded",
        } as never);
        tenant.getTicket.mockResolvedValue({
            ok: true,
            ticket: { id: TICKET_ID, discord_thread_id: "thread-consumer" },
            messages: [],
        } as never);
        const { interaction, reply } = openInteraction({});

        await handleTicketOpen(interaction, deps);

        expect(replyContent(reply)).toContain("<#thread-consumer>");
        expect(state.threadForTicket(TICKET_ID)).toBe("thread-consumer");
    });

    it("rejects use outside a guild", async () => {
        const { deps, tenant } = makeDeps();
        const { interaction, reply } = openInteraction({ guildId: null });

        await handleTicketOpen(interaction, deps);

        expect(tenant.createTicket).not.toHaveBeenCalled();
        expect(replyContent(reply)).toContain("inside a Discord server");
    });
});

describe("handleTicketClose", () => {
    function closeInteraction(
        options: {
            inThread?: boolean;
            guildId?: string | null;
            userId?: string;
            memberRoleIds?: string[];
        } = {},
    ) {
        const reply = vi.fn(async () => undefined);
        const interaction: TicketCloseInteraction = {
            guildId: options.guildId === undefined ? "guild-1" : options.guildId,
            channelId: "thread-1",
            channel: { isThread: () => options.inThread ?? true },
            user: { id: options.userId ?? "user-7" },
            memberRoleIds: options.memberRoleIds ?? [],
            reply,
        };
        return { interaction, reply };
    }

    it("lets the ticket opener close: POSTs status closed and confirms ephemerally", async () => {
        const { deps, tenant } = makeDeps();
        tenant.getTicketByThread.mockResolvedValue({
            ok: true,
            ticket: { id: TICKET_ID, opener_discord_user_id: "user-7" },
        } as never);
        const { interaction, reply } = closeInteraction({ userId: "user-7" });

        await handleTicketClose(interaction, deps);

        expect(tenant.closeTicket).toHaveBeenCalledWith(TICKET_ID, "guild-1");
        expect(replyContent(reply)).toContain("closed");
    });

    it("lets a staff-role holder close someone else's ticket", async () => {
        const state = new GuildState();
        state.recordStaffRole("guild-1", "role-staff");
        const { deps, tenant } = makeDeps({ state });
        tenant.getTicketByThread.mockResolvedValue({
            ok: true,
            ticket: { id: TICKET_ID, opener_discord_user_id: "someone-else" },
        } as never);
        const { interaction } = closeInteraction({
            userId: "mod-1",
            memberRoleIds: ["role-staff"],
        });

        await handleTicketClose(interaction, deps);
        expect(tenant.closeTicket).toHaveBeenCalledWith(TICKET_ID, "guild-1");
    });

    it("rejects a non-opener without the staff role (web-opened tickets included)", async () => {
        const state = new GuildState();
        state.recordStaffRole("guild-1", "role-staff");
        const { deps, tenant } = makeDeps({ state });
        tenant.getTicketByThread.mockResolvedValue({
            ok: true,
            ticket: { id: TICKET_ID, opener_discord_user_id: null },
        } as never);
        const { interaction, reply } = closeInteraction({ memberRoleIds: ["role-other"] });

        await handleTicketClose(interaction, deps);

        expect(tenant.closeTicket).not.toHaveBeenCalled();
        expect(replyContent(reply)).toContain("opener or staff");
    });

    it("surfaces a close failure as a retry ephemeral", async () => {
        const { deps, tenant } = makeDeps();
        tenant.getTicketByThread.mockResolvedValue({
            ok: true,
            ticket: { id: TICKET_ID, opener_discord_user_id: "user-7" },
        } as never);
        tenant.closeTicket.mockResolvedValue({
            ok: false,
            kind: "unreachable",
            message: "tenant service unreachable: timeout",
        } as never);
        const { interaction, reply } = closeInteraction({ userId: "user-7" });

        await handleTicketClose(interaction, deps);
        expect(replyContent(reply)).toContain("try again");
    });

    it("rejects use outside a thread", async () => {
        const { deps, tenant } = makeDeps();
        const { interaction, reply } = closeInteraction({ inThread: false });

        await handleTicketClose(interaction, deps);
        expect(tenant.closeTicket).not.toHaveBeenCalled();
        expect(replyContent(reply)).toContain("inside a ticket thread");
    });

    it("rejects a thread that maps to no ticket", async () => {
        const { deps, tenant } = makeDeps();
        tenant.getTicketByThread.mockResolvedValue({
            ok: false,
            kind: "not_found",
            message: "no",
        } as never);
        const { interaction, reply } = closeInteraction();

        await handleTicketClose(interaction, deps);
        expect(tenant.closeTicket).not.toHaveBeenCalled();
        expect(replyContent(reply)).toContain("not linked to a Cupboard ticket");
    });
});
