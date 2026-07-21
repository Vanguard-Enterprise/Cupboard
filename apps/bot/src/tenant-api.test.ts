import { describe, expect, it, vi } from "vitest";
import { TenantApi } from "./tenant-api.js";

function makeApi(fetchFn: typeof fetch) {
    return new TenantApi({
        baseUrl: "http://tenant:8080/",
        botApiToken: "secret-token",
        timeoutMs: 50,
        fetchFn,
    });
}

const request = {
    code: "one-time-code",
    guildId: "g1",
    ticketsChannelId: "c1",
} as const;

describe("TenantApi.bindGuild", () => {
    it("POSTs the bind payload with the internal-token header and maps 204 to ok", async () => {
        const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
        const result = await makeApi(fetchFn as unknown as typeof fetch).bindGuild({
            ...request,
            staffRoleId: "r1",
        });

        expect(result).toEqual({ ok: true });
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://tenant:8080/internal/tickets/discord/bind");
        expect((init.headers as Record<string, string>)["x-internal-token"]).toBe("secret-token");
        expect(JSON.parse(init.body as string)).toEqual({
            code: "one-time-code",
            guild_id: "g1",
            tickets_channel_id: "c1",
            staff_role_id: "r1",
        });
    });

    it("omits staff_role_id when it is not provided", async () => {
        const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
        await makeApi(fetchFn as unknown as typeof fetch).bindGuild(request);
        const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(init.body as string)).not.toHaveProperty("staff_role_id");
    });

    it("maps 401 to invalid_code", async () => {
        const fetchFn = vi.fn(
            async () =>
                new Response(JSON.stringify({ error: "unauthorized", message: "invalid code" }), {
                    status: 401,
                }),
        );
        const result = await makeApi(fetchFn as unknown as typeof fetch).bindGuild(request);
        expect(result).toEqual({ ok: false, kind: "invalid_code", message: "invalid code" });
    });

    it("maps 409 to guild_already_linked", async () => {
        const fetchFn = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ error: "conflict", message: "guild already linked" }),
                    { status: 409 },
                ),
        );
        const result = await makeApi(fetchFn as unknown as typeof fetch).bindGuild(request);
        expect(result).toEqual({
            ok: false,
            kind: "guild_already_linked",
            message: "guild already linked",
        });
    });

    it("maps other statuses to unexpected and survives a non-JSON body", async () => {
        const fetchFn = vi.fn(async () => new Response("oops", { status: 500 }));
        const result = await makeApi(fetchFn as unknown as typeof fetch).bindGuild(request);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("unexpected");
            expect(result.message).toContain("500");
        }
    });

    it("maps network failures to unreachable and never includes the code", async () => {
        const fetchFn = vi.fn(async () => {
            throw new Error("connect ECONNREFUSED");
        });
        const result = await makeApi(fetchFn as unknown as typeof fetch).bindGuild(request);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("unreachable");
            expect(result.message).not.toContain("one-time-code");
        }
    });
});

describe("PR5 internal ticket routes", () => {
    it("createTicket POSTs the snake_case payload and unwraps the 201 ticket", async () => {
        const fetchFn = vi.fn(
            async () =>
                new Response(JSON.stringify({ ticket: { id: "t-1", subject: "Help" } }), {
                    status: 201,
                }),
        );
        const result = await makeApi(fetchFn as unknown as typeof fetch).createTicket({
            guildId: "g1",
            openerDiscordUserId: "u1",
            openerDisplay: "PlayerOne",
            subject: "Help",
            body: "please",
        });
        expect(result).toEqual({ ok: true, ticket: { id: "t-1", subject: "Help" } });
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://tenant:8080/internal/tickets");
        expect((init.headers as Record<string, string>)["x-internal-token"]).toBe("secret-token");
        expect(JSON.parse(init.body as string)).toEqual({
            guild_id: "g1",
            opener_discord_user_id: "u1",
            opener_display: "PlayerOne",
            subject: "Help",
            body: "please",
        });
    });

    it("getTicket queries with guild_id and maps 404 to not_found", async () => {
        const fetchFn = vi.fn(
            async () =>
                new Response(JSON.stringify({ error: "not_found", message: "no such ticket" }), {
                    status: 404,
                }),
        );
        const result = await makeApi(fetchFn as unknown as typeof fetch).getTicket("t-1", "g1");
        expect(result).toEqual({ ok: false, kind: "not_found", message: "no such ticket" });
        const [url] = fetchFn.mock.calls[0] as unknown as [string];
        expect(url).toBe("http://tenant:8080/internal/tickets/t-1?guild_id=g1");
    });

    it("getTicketByThread hits the by-thread route", async () => {
        const fetchFn = vi.fn(
            async () => new Response(JSON.stringify({ ticket: { id: "t-1" } }), { status: 200 }),
        );
        const result = await makeApi(fetchFn as unknown as typeof fetch).getTicketByThread(
            "thr-1",
            "g1",
        );
        expect(result).toEqual({ ok: true, ticket: { id: "t-1" } });
        const [url] = fetchFn.mock.calls[0] as unknown as [string];
        expect(url).toBe("http://tenant:8080/internal/tickets/by-thread/thr-1?guild_id=g1");
    });

    it("postTicketMessage maps 201 to inserted and 200 to deduped", async () => {
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ message: {} }), { status: 201 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ deduped: true }), { status: 200 }),
            );
        const api = makeApi(fetchFn as unknown as typeof fetch);
        const req = {
            guildId: "g1",
            discordMessageId: "d1",
            authorDisplay: "Mod",
            authorKind: "staff" as const,
            body: "on it",
        };
        expect(await api.postTicketMessage("t-1", req)).toEqual({ ok: true, deduped: false });
        expect(await api.postTicketMessage("t-1", req)).toEqual({ ok: true, deduped: true });
        const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toEqual({
            guild_id: "g1",
            discord_message_id: "d1",
            author_display: "Mod",
            author_kind: "staff",
            body: "on it",
        });
    });

    it("getDiscordConfig parses the binding and maps 404 to not_found", async () => {
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        tenant_id: "tenant-1",
                        tickets_channel_id: "chan-1",
                        staff_role_id: "role-1",
                    }),
                    { status: 200 },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ error: "not_found", message: "guild not linked" }), {
                    status: 404,
                }),
            );
        const api = makeApi(fetchFn as unknown as typeof fetch);
        expect(await api.getDiscordConfig("g1")).toEqual({
            ok: true,
            config: { tenant_id: "tenant-1", tickets_channel_id: "chan-1", staff_role_id: "role-1" },
        });
        expect(await api.getDiscordConfig("g2")).toEqual({
            ok: false,
            kind: "not_found",
            message: "guild not linked",
        });
        const [url] = fetchFn.mock.calls[0] as unknown as [string];
        expect(url).toBe("http://tenant:8080/internal/tickets/discord/config?guild_id=g1");
    });

    it("getDiscordConfig rejects a null tickets_channel_id (strict string guard)", async () => {
        const fetchFn = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ tenant_id: "tenant-1", tickets_channel_id: null }),
                    { status: 200 },
                ),
        );
        const result = await makeApi(fetchFn as unknown as typeof fetch).getDiscordConfig("g1");
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe("unexpected");
        }
    });

    it("getDiscordConfig normalizes a non-string staff_role_id to undefined", async () => {
        const fetchFn = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        tenant_id: "tenant-1",
                        tickets_channel_id: "chan-1",
                        staff_role_id: null,
                    }),
                    { status: 200 },
                ),
        );
        const result = await makeApi(fetchFn as unknown as typeof fetch).getDiscordConfig("g1");
        expect(result).toEqual({
            ok: true,
            config: {
                tenant_id: "tenant-1",
                tickets_channel_id: "chan-1",
                staff_role_id: undefined,
            },
        });
    });

    it("clearDiscordThread DELETEs with the guild id and maps 204 to ok", async () => {
        const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
        const result = await makeApi(fetchFn as unknown as typeof fetch).clearDiscordThread(
            "t-1",
            "g1",
        );
        expect(result).toEqual({ ok: true });
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://tenant:8080/internal/tickets/t-1/discord-thread");
        expect(init.method).toBe("DELETE");
        expect(JSON.parse(init.body as string)).toEqual({ guild_id: "g1" });
    });

    it("closeTicket POSTs status closed and maps 204 to ok, 400 to unexpected", async () => {
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ error: "bad_request", message: "only closed is accepted" }),
                    { status: 400 },
                ),
            );
        const api = makeApi(fetchFn as unknown as typeof fetch);
        expect(await api.closeTicket("t-1", "g1")).toEqual({ ok: true });
        const second = await api.closeTicket("t-1", "g1");
        expect(second.ok).toBe(false);
        if (!second.ok) {
            expect(second.kind).toBe("unexpected");
        }
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://tenant:8080/internal/tickets/t-1/status");
        expect(JSON.parse(init.body as string)).toEqual({ guild_id: "g1", status: "closed" });
    });

    it("recordDiscordThread maps 204 to ok and 409 to conflict", async () => {
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ error: "conflict", message: "different thread recorded" }),
                    { status: 409 },
                ),
            );
        const api = makeApi(fetchFn as unknown as typeof fetch);
        const req = { guildId: "g1", discordChannelId: "c1", discordThreadId: "thr-1" };
        expect(await api.recordDiscordThread("t-1", req)).toEqual({ ok: true });
        expect(await api.recordDiscordThread("t-1", req)).toEqual({
            ok: false,
            kind: "conflict",
            message: "different thread recorded",
        });
    });
});
