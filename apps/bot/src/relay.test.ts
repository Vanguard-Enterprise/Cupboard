import { describe, expect, it, vi } from "vitest";
import type { TicketEvent } from "./events.js";
import { GuildState } from "./guild-state.js";
import {
    chunkContent,
    RelayError,
    threadName,
    TicketRelay,
    UnknownChannelError,
    type DiscordPort,
    type Fence,
} from "./relay.js";
import type { TenantApi, TicketMessageRecord, TicketRecord } from "./tenant-api.js";

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as import("pino").Logger;

const TICKET_ID = "0197a6a4-0000-7000-8000-00000000aaaa";
const MSG_ID = "0197a6a4-0000-7000-8000-00000000bbbb";

function ticketRecord(overrides: Partial<TicketRecord> = {}): TicketRecord {
    return { id: TICKET_ID, type: "general", subject: "Help me", status: "open", ...overrides };
}

function messageEvent(overrides: Partial<TicketEvent> = {}): TicketEvent {
    return {
        kind: "ticket.message",
        tenant_id: "tenant-1",
        ticket_id: TICKET_ID,
        message_id: MSG_ID,
        author_kind: "staff",
        author_display: "Admin",
        body: "We are on it.",
        origin: "web",
        ...overrides,
    };
}

type Harness = {
    relay: TicketRelay;
    state: GuildState;
    ops: string[];
    tenant: {
        getTicket: ReturnType<typeof vi.fn>;
        recordDiscordThread: ReturnType<typeof vi.fn>;
        postTicketMessage: ReturnType<typeof vi.fn>;
        getTicketByThread: ReturnType<typeof vi.fn>;
        createTicket: ReturnType<typeof vi.fn>;
        getDiscordConfig: ReturnType<typeof vi.fn>;
        closeTicket: ReturnType<typeof vi.fn>;
        clearDiscordThread: ReturnType<typeof vi.fn>;
    };
    discord: {
        createPrivateThread: ReturnType<typeof vi.fn>;
        postToThread: ReturnType<typeof vi.fn>;
    };
    fence: { isRelayed: ReturnType<typeof vi.fn>; markRelayed: ReturnType<typeof vi.fn> };
};

function makeHarness(options: {
    guilds?: string[];
    ticket?: TicketRecord;
    messages?: TicketMessageRecord[];
    relayed?: boolean;
    ready?: boolean;
}): Harness {
    const ops: string[] = [];
    const state = new GuildState();
    const tenant = {
        getTicket: vi.fn(async () => ({
            ok: true as const,
            ticket: options.ticket ?? ticketRecord(),
            messages: options.messages ?? [],
        })),
        recordDiscordThread: vi.fn(async () => {
            ops.push("record-thread");
            return { ok: true as const };
        }),
        postTicketMessage: vi.fn(),
        getTicketByThread: vi.fn(),
        createTicket: vi.fn(),
        getDiscordConfig: vi.fn(async () => ({
            ok: false as const,
            kind: "not_found" as const,
            message: "guild not linked",
        })),
        closeTicket: vi.fn(async () => ({ ok: true as const })),
        clearDiscordThread: vi.fn(async () => ({ ok: true as const })),
    };
    const discord = {
        createPrivateThread: vi.fn(async () => {
            ops.push("create-thread");
            return "thread-1";
        }),
        postToThread: vi.fn(async (_threadId: string, content: string) => {
            ops.push(`post:${content.slice(0, 30)}`);
        }),
    };
    const fence = {
        isRelayed: vi.fn(async () => options.relayed ?? false),
        markRelayed: vi.fn(async () => {
            ops.push("fence");
        }),
    };
    const port: DiscordPort = {
        isReady: () => options.ready ?? true,
        guildIds: () => options.guilds ?? ["guild-1"],
        createPrivateThread:
            discord.createPrivateThread as unknown as DiscordPort["createPrivateThread"],
        postToThread: discord.postToThread as unknown as DiscordPort["postToThread"],
        addThreadMember: async () => undefined,
    };
    const relay = new TicketRelay({
        tenant: tenant as unknown as TenantApi,
        discord: port,
        fence: fence as unknown as Fence,
        state,
        logger: silentLogger,
    });
    return { relay, state, ops, tenant, discord, fence };
}

describe("ticket.message relay (decision F ordering)", () => {
    it("posts to Discord FIRST, then sets the fence (ack is the consumer's, after)", async () => {
        const h = makeHarness({});
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordThread(TICKET_ID, "thread-9");

        await h.relay.handleEvent(messageEvent());

        const postIndex = h.ops.findIndex((op) => op.startsWith("post:"));
        const fenceIndex = h.ops.indexOf("fence");
        expect(postIndex).toBeGreaterThanOrEqual(0);
        expect(fenceIndex).toBeGreaterThan(postIndex);
        expect(h.discord.postToThread).toHaveBeenCalledWith(
            "thread-9",
            "**Admin**: We are on it.",
            undefined,
        );
    });

    it("a fence hit skips the post AND the re-mark, returning cleanly for the ack", async () => {
        const h = makeHarness({ relayed: true });
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordThread(TICKET_ID, "thread-9");

        await h.relay.handleEvent(messageEvent());

        expect(h.discord.postToThread).not.toHaveBeenCalled();
        expect(h.fence.markRelayed).not.toHaveBeenCalled();
    });

    it("never posts an origin=discord event (belt and braces echo-guard)", async () => {
        const h = makeHarness({});
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordThread(TICKET_ID, "thread-9");

        await h.relay.handleEvent(messageEvent({ origin: "discord" }));

        expect(h.discord.postToThread).not.toHaveBeenCalled();
        expect(h.fence.isRelayed).not.toHaveBeenCalled();
    });

    it("never relays an event missing message_id", async () => {
        const h = makeHarness({});
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordThread(TICKET_ID, "thread-9");

        await h.relay.handleEvent(messageEvent({ message_id: undefined }));

        expect(h.discord.postToThread).not.toHaveBeenCalled();
    });

    it("creates the thread lazily with header + backfill and skips re-posting a backfilled message", async () => {
        const backfill: TicketMessageRecord[] = [
            {
                id: "m-1",
                author_kind: "player",
                author_display: "PlayerOne",
                body: "My base is gone",
                origin: "web",
            },
            {
                id: MSG_ID,
                author_kind: "staff",
                author_display: "Admin",
                body: "We are on it.",
                origin: "web",
            },
        ];
        const h = makeHarness({
            ticket: ticketRecord({ discord_channel_id: "chan-1" }),
            messages: backfill,
        });
        h.state.recordBinding("guild-1", "tenant-1");

        await h.relay.handleEvent(messageEvent());

        expect(h.discord.createPrivateThread).toHaveBeenCalledWith(
            "chan-1",
            expect.stringContaining("Help me"),
        );
        const posts = h.discord.postToThread.mock.calls.map((c) => c[1] as string);
        // Header + backfill note + both backfilled messages, and NOT a second
        // copy of the triggering message.
        expect(posts.some((p) => p.includes("Help me"))).toBe(true);
        expect(posts.some((p) => p.includes("Backfilling 2"))).toBe(true);
        expect(posts.filter((p) => p.includes("We are on it.")).length).toBe(1);
        // The tenant already excluded internal notes; the bot posts the list
        // verbatim (trust, not re-filtering).
        expect(posts.some((p) => p.includes("My base is gone"))).toBe(true);
        expect(h.tenant.recordDiscordThread).toHaveBeenCalledWith(TICKET_ID, {
            guildId: "guild-1",
            discordChannelId: "chan-1",
            discordThreadId: "thread-1",
        });
        expect(h.fence.markRelayed).toHaveBeenCalledWith(MSG_ID);
        expect(h.state.threadForTicket(TICKET_ID)).toBe("thread-1");
    });

    it("adopts the recorded thread on a 409 discord-thread conflict", async () => {
        const h = makeHarness({ ticket: ticketRecord({ discord_channel_id: "chan-1" }) });
        h.state.recordBinding("guild-1", "tenant-1");
        h.tenant.recordDiscordThread.mockResolvedValueOnce({
            ok: false,
            kind: "conflict",
            message: "different thread recorded",
        });
        // The refetch after the conflict returns the canonical thread.
        h.tenant.getTicket
            .mockResolvedValueOnce({
                ok: true,
                ticket: ticketRecord({ discord_channel_id: "chan-1" }),
                messages: [],
            })
            .mockResolvedValueOnce({
                ok: true,
                ticket: ticketRecord({
                    discord_channel_id: "chan-1",
                    discord_thread_id: "thread-real",
                }),
                messages: [],
            });

        await h.relay.handleEvent(messageEvent());

        expect(h.state.threadForTicket(TICKET_ID)).toBe("thread-real");
        const lastPost = h.discord.postToThread.mock.calls.at(-1);
        expect(lastPost?.[0]).toBe("thread-real");
        expect(lastPost?.[1]).toContain("We are on it.");
    });
});

describe("ticket.status relay", () => {
    it("skips status events for tickets with no thread (no creation)", async () => {
        const h = makeHarness({ ticket: ticketRecord() });
        h.state.recordBinding("guild-1", "tenant-1");

        await h.relay.handleEvent({
            kind: "ticket.status",
            tenant_id: "tenant-1",
            ticket_id: TICKET_ID,
            status: "resolved",
        });

        expect(h.discord.createPrivateThread).not.toHaveBeenCalled();
        expect(h.discord.postToThread).not.toHaveBeenCalled();
    });

    it("posts a compact status line into an existing thread", async () => {
        const h = makeHarness({});
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordThread(TICKET_ID, "thread-9");

        await h.relay.handleEvent({
            kind: "ticket.status",
            tenant_id: "tenant-1",
            ticket_id: TICKET_ID,
            status: "resolved",
        });

        expect(h.discord.postToThread).toHaveBeenCalledWith(
            "thread-9",
            "Status changed to **resolved**.",
            undefined,
        );
    });
});

describe("lazy binding hydration (fallback for guilds joined after boot)", () => {
    it("hydrates unknown guilds via the config route and caches every answer", async () => {
        const h = makeHarness({
            guilds: ["guild-a", "guild-b"],
            ticket: ticketRecord({ discord_thread_id: "thread-b" }),
        });
        h.tenant.getDiscordConfig
            .mockResolvedValueOnce({
                ok: true,
                config: { tenant_id: "tenant-other", tickets_channel_id: "chan-a" },
            })
            .mockResolvedValueOnce({
                ok: true,
                config: {
                    tenant_id: "tenant-1",
                    tickets_channel_id: "chan-b",
                    staff_role_id: "role-b",
                },
            });

        await h.relay.handleEvent(messageEvent());

        expect(h.state.guildForTenant("tenant-1")).toBe("guild-b");
        expect(h.state.channelForGuild("guild-b")).toBe("chan-b");
        expect(h.state.staffRoleForGuild("guild-b")).toBe("role-b");
        // The other guild's binding was learned as a side effect.
        expect(h.state.tenantForGuild("guild-a")).toBe("tenant-other");
        // The message landed in the ticket's recorded thread.
        expect(h.discord.postToThread).toHaveBeenCalledWith(
            "thread-b",
            expect.stringContaining("We are on it."),
            undefined,
        );
    });

    it("negative-caches a tenant with no bound guild and drops without re-asking", async () => {
        const h = makeHarness({ guilds: ["guild-a"] });
        // Default getDiscordConfig mock answers 404 (unlinked).

        await h.relay.handleEvent(messageEvent());
        await h.relay.handleEvent(messageEvent({ message_id: "other-id" }));

        expect(h.tenant.getDiscordConfig).toHaveBeenCalledTimes(1);
        expect(h.discord.postToThread).not.toHaveBeenCalled();
    });

    it("treats a hydration error as retryable instead of a missing binding", async () => {
        const h = makeHarness({ guilds: ["guild-a"] });
        h.tenant.getDiscordConfig.mockResolvedValue({
            ok: false,
            kind: "unreachable",
            message: "tenant service unreachable: timeout",
        });

        await expect(h.relay.handleEvent(messageEvent())).rejects.toThrow(/hydration/);
        expect(h.state.isTenantUnknown("tenant-1")).toBe(false);
    });
});

describe("ordering guard (consumer must start after ready + hydration)", () => {
    it("throws a retryable RelayError when the client is not ready", async () => {
        const h = makeHarness({ ready: false });

        await expect(h.relay.handleEvent(messageEvent())).rejects.toBeInstanceOf(RelayError);
        // Crucially: NOT negative-cached, so nothing is silently dropped.
        expect(h.state.isTenantUnknown("tenant-1")).toBe(false);
        expect(h.tenant.getDiscordConfig).not.toHaveBeenCalled();
    });

    it("throws a retryable RelayError when the guild cache is empty", async () => {
        const h = makeHarness({ guilds: [] });

        await expect(h.relay.handleEvent(messageEvent())).rejects.toBeInstanceOf(RelayError);
        expect(h.state.isTenantUnknown("tenant-1")).toBe(false);
    });
});

describe("mention safety", () => {
    it("headers ping ONLY the staff role; relayed bodies ping nothing", async () => {
        const h = makeHarness({
            ticket: ticketRecord({
                discord_channel_id: "chan-1",
                subject: "@everyone <@&999> pwned",
            }),
        });
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordStaffRole("guild-1", "role-staff");

        await h.relay.handleEvent(messageEvent());

        const headerCall = h.discord.postToThread.mock.calls.find((c) =>
            (c[1] as string).startsWith("New "),
        );
        expect(headerCall?.[2]).toEqual({ pingRoles: ["role-staff"] });
        // The relayed message itself carries no mention allowance at all.
        const bodyCall = h.discord.postToThread.mock.calls.find((c) =>
            (c[1] as string).includes("We are on it."),
        );
        expect(bodyCall?.[2]).toBeUndefined();
    });

    it("headers allow NO roles when no staff role is configured", async () => {
        const h = makeHarness({ ticket: ticketRecord({ discord_channel_id: "chan-1" }) });
        h.state.recordBinding("guild-1", "tenant-1");

        await h.relay.handleEvent(messageEvent());

        const headerCall = h.discord.postToThread.mock.calls.find((c) =>
            (c[1] as string).startsWith("New "),
        );
        expect(headerCall?.[2]).toEqual({ pingRoles: [] });
    });
});

describe("backfill fencing", () => {
    it("fences EVERY backfilled message id so queued sibling events skip them", async () => {
        const backfill: TicketMessageRecord[] = [
            { id: "m-1", author_kind: "player", author_display: "P", body: "one", origin: "web" },
            { id: "m-2", author_kind: "staff", author_display: "S", body: "two", origin: "web" },
        ];
        const h = makeHarness({
            ticket: ticketRecord({ discord_channel_id: "chan-1" }),
            messages: backfill,
        });
        h.state.recordBinding("guild-1", "tenant-1");

        // A created event triggers thread creation with backfill.
        await h.relay.handleEvent({
            kind: "ticket.created",
            tenant_id: "tenant-1",
            ticket_id: TICKET_ID,
            subject: "Help me",
        });

        expect(h.fence.markRelayed).toHaveBeenCalledWith("m-1");
        expect(h.fence.markRelayed).toHaveBeenCalledWith("m-2");

        // The queued ticket.message events behind it now hit the fence.
        h.fence.isRelayed.mockResolvedValue(true);
        const postsBefore = h.discord.postToThread.mock.calls.length;
        await h.relay.handleEvent(messageEvent({ message_id: "m-2", body: "two" }));
        expect(h.discord.postToThread.mock.calls.length).toBe(postsBefore);
    });
});

describe("deleted-thread recovery (Unknown Channel 10003)", () => {
    it("clears the recorded thread and recreates with backfill in the same pass", async () => {
        const backfill: TicketMessageRecord[] = [
            { id: "m-1", author_kind: "player", author_display: "P", body: "one", origin: "web" },
        ];
        const h = makeHarness({ messages: backfill });
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordThread(TICKET_ID, "thread-dead");
        h.state.recordChannel("guild-1", "chan-1");
        // First post (into the cached dead thread) reports Unknown Channel;
        // everything after the clear succeeds.
        h.discord.postToThread.mockImplementationOnce(async () => {
            throw new UnknownChannelError("thread thread-dead no longer exists");
        });
        // After the clear the tenant returns the ticket without a thread.
        h.tenant.getTicket.mockResolvedValue({
            ok: true,
            ticket: ticketRecord(),
            messages: backfill,
        });

        await h.relay.handleEvent(messageEvent());

        expect(h.tenant.clearDiscordThread).toHaveBeenCalledWith(TICKET_ID, "guild-1");
        // Recreated lazily: new thread, backfill posted, message relayed there.
        expect(h.discord.createPrivateThread).toHaveBeenCalledWith(
            "chan-1",
            expect.stringContaining("Help me"),
        );
        const posts = h.discord.postToThread.mock.calls
            .slice(1) // Skip the failed post into the dead thread.
            .map((c) => [c[0], c[1]] as [string, string]);
        expect(posts.every(([threadId]) => threadId === "thread-1")).toBe(true);
        expect(posts.some(([, content]) => content.includes("one"))).toBe(true);
        expect(posts.some(([, content]) => content.includes("We are on it."))).toBe(true);
        expect(h.state.threadForTicket(TICKET_ID)).toBe("thread-1");
    });

    it("degrades to a retryable RelayError when the clear route fails", async () => {
        const h = makeHarness({});
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordThread(TICKET_ID, "thread-dead");
        h.discord.postToThread.mockImplementation(async () => {
            throw new UnknownChannelError("gone");
        });
        h.tenant.clearDiscordThread.mockResolvedValue({
            ok: false,
            kind: "unreachable",
            message: "tenant service unreachable: timeout",
        });

        await expect(h.relay.handleEvent(messageEvent())).rejects.toBeInstanceOf(RelayError);
    });

    it("degrades to a retryable RelayError when the second pass also hits 10003", async () => {
        const h = makeHarness({});
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordThread(TICKET_ID, "thread-dead");
        h.state.recordChannel("guild-1", "chan-1");
        h.discord.postToThread.mockImplementation(async () => {
            throw new UnknownChannelError("gone again");
        });

        await expect(h.relay.handleEvent(messageEvent())).rejects.toBeInstanceOf(RelayError);
        expect(h.tenant.clearDiscordThread).toHaveBeenCalledTimes(1);
    });
});

describe("/ticket close followed by its ticket.status event", () => {
    it("posts exactly ONE in-thread status line (the close ack stays ephemeral)", async () => {
        const { handleTicketClose } = await import("./ticket-commands.js");
        const h = makeHarness({});
        h.state.recordBinding("guild-1", "tenant-1");
        h.state.recordStaffRole("guild-1", "role-staff");
        h.state.recordThread(TICKET_ID, "thread-9");
        h.tenant.getTicketByThread.mockResolvedValue({
            ok: true,
            ticket: ticketRecord({ opener_discord_user_id: "user-7" }),
        });
        const reply = vi.fn(async () => undefined);

        // 1. The close command: tenant write + ephemeral ack, nothing posted.
        await handleTicketClose(
            {
                guildId: "guild-1",
                channelId: "thread-9",
                channel: { isThread: () => true },
                user: { id: "user-7" },
                memberRoleIds: [],
                reply,
            },
            {
                tenant: h.tenant as unknown as TenantApi,
                state: h.state,
                discord: {
                    isReady: () => true,
                    guildIds: () => ["guild-1"],
                    createPrivateThread: h.discord
                        .createPrivateThread as unknown as DiscordPort["createPrivateThread"],
                    postToThread: h.discord.postToThread as unknown as DiscordPort["postToThread"],
                    addThreadMember: async () => undefined,
                },
                logger: silentLogger,
            },
        );
        expect(h.tenant.closeTicket).toHaveBeenCalledWith(TICKET_ID, "guild-1");
        expect(h.discord.postToThread).not.toHaveBeenCalled();

        // 2. The relayed ticket.status event the close triggered.
        await h.relay.handleEvent({
            kind: "ticket.status",
            tenant_id: "tenant-1",
            ticket_id: TICKET_ID,
            status: "closed",
        });

        const statusPosts = h.discord.postToThread.mock.calls.filter((c) =>
            (c[1] as string).includes("closed"),
        );
        expect(statusPosts.length).toBe(1);
        expect(statusPosts[0]?.[0]).toBe("thread-9");
    });
});

describe("rendering helpers", () => {
    it("caps thread names at 100 chars", () => {
        expect(threadName(TICKET_ID, "x".repeat(300)).length).toBe(100);
        expect(threadName(TICKET_ID, "short")).toBe(`ticket-${TICKET_ID.slice(0, 8)}: short`);
    });

    it("chunks long content to Discord's 2000-char limit", () => {
        const chunks = chunkContent("a".repeat(4100));
        expect(chunks.length).toBe(3);
        expect(chunks[0]?.length).toBe(2000);
        expect(chunks[2]).toBe("a".repeat(100));
    });
});
