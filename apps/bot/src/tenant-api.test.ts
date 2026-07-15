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
