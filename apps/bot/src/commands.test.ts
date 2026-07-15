import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
    type BotChannelPermissions,
    buildCommands,
    handleCupboardSetup,
    type SetupInteraction,
} from "./commands.js";
import type { BindResult, TenantApi } from "./tenant-api.js";

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as unknown as import("pino").Logger;

function mockTenant(result: BindResult) {
    const bindGuild = vi.fn(async () => result);
    return { tenant: { bindGuild } as unknown as TenantApi, bindGuild };
}

/** Setup deps with an injectable bot-permission resolver (default: allow all). */
function mockDeps(
    tenant: TenantApi,
    botPerms: BotChannelPermissions | null = { has: () => true },
) {
    const botPermissionsIn = vi.fn(async () => botPerms);
    return { deps: { tenant, logger: silentLogger, botPermissionsIn }, botPermissionsIn };
}

type InteractionOverrides = {
    guildId?: string | null;
    channelType?: ChannelType;
    hasManageGuild?: boolean;
    channelOption?: { id: string; type: ChannelType } | null;
    staffRole?: { id: string } | null;
};

function mockInteraction(overrides: InteractionOverrides = {}) {
    const {
        guildId = "guild-1",
        channelType = ChannelType.GuildText,
        hasManageGuild = true,
        channelOption = null,
        staffRole = null,
    } = overrides;
    const reply = vi.fn(async () => undefined);
    const interaction: SetupInteraction = {
        guildId,
        channelId: "chan-current",
        channel: { type: channelType },
        memberPermissions: {
            has: (permission: bigint) =>
                hasManageGuild && permission === PermissionFlagsBits.ManageGuild,
        },
        options: {
            getString: () => "the-secret-code",
            getChannel: () => channelOption,
            getRole: () => staffRole,
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

describe("buildCommands", () => {
    it("registers /cupboard with a setup subcommand and the expected options", () => {
        const [cupboard] = buildCommands();
        expect(cupboard.name).toBe("cupboard");
        const setup = cupboard.options?.find((o) => o.name === "setup");
        expect(setup).toBeDefined();
        const options = (setup as { options?: { name: string; required?: boolean }[] }).options;
        expect(options?.map((o) => o.name)).toEqual(["code", "channel", "staff_role"]);
        expect(options?.find((o) => o.name === "code")?.required).toBe(true);
    });
});

describe("handleCupboardSetup", () => {
    it("binds with the invoking channel by default and confirms with the channel mention", async () => {
        const { tenant, bindGuild } = mockTenant({ ok: true });
        const { deps, botPermissionsIn } = mockDeps(tenant);
        const { interaction, reply } = mockInteraction();
        await handleCupboardSetup(interaction, deps);

        expect(botPermissionsIn).toHaveBeenCalledWith("chan-current");

        expect(bindGuild).toHaveBeenCalledWith({
            code: "the-secret-code",
            guildId: "guild-1",
            ticketsChannelId: "chan-current",
            staffRoleId: undefined,
        });
        const content = replyContent(reply);
        expect(content).toContain("<#chan-current>");
        expect(content).not.toContain("the-secret-code");
    });

    it("prefers the explicit channel option and passes the staff role", async () => {
        const { tenant, bindGuild } = mockTenant({ ok: true });
        const { interaction } = mockInteraction({
            channelOption: { id: "chan-tickets", type: ChannelType.GuildText },
            staffRole: { id: "role-staff" },
        });
        await handleCupboardSetup(interaction, mockDeps(tenant).deps);

        expect(bindGuild).toHaveBeenCalledWith({
            code: "the-secret-code",
            guildId: "guild-1",
            ticketsChannelId: "chan-tickets",
            staffRoleId: "role-staff",
        });
    });

    it("gates on Manage Guild and never calls the tenant service", async () => {
        const { tenant, bindGuild } = mockTenant({ ok: true });
        const { interaction, reply } = mockInteraction({ hasManageGuild: false });
        await handleCupboardSetup(interaction, mockDeps(tenant).deps);

        expect(bindGuild).not.toHaveBeenCalled();
        expect(replyContent(reply)).toContain("Manage Server");
    });

    it("rejects use outside a guild", async () => {
        const { tenant, bindGuild } = mockTenant({ ok: true });
        const { interaction, reply } = mockInteraction({ guildId: null });
        await handleCupboardSetup(interaction, mockDeps(tenant).deps);

        expect(bindGuild).not.toHaveBeenCalled();
        expect(replyContent(reply)).toContain("inside the Discord server");
    });

    it("asks for a channel when invoked outside a text channel with no option", async () => {
        const { tenant, bindGuild } = mockTenant({ ok: true });
        const { interaction, reply } = mockInteraction({
            channelType: ChannelType.PublicThread,
        });
        await handleCupboardSetup(interaction, mockDeps(tenant).deps);

        expect(bindGuild).not.toHaveBeenCalled();
        expect(replyContent(reply)).toContain("text channel");
    });

    it("maps invalid_code (401) to the invalid-code reply without echoing the code", async () => {
        const { tenant } = mockTenant({
            ok: false,
            kind: "invalid_code",
            message: "invalid or expired code",
        });
        const { interaction, reply } = mockInteraction();
        await handleCupboardSetup(interaction, mockDeps(tenant).deps);

        const content = replyContent(reply);
        expect(content).toContain("invalid, expired, or already used");
        expect(content).not.toContain("the-secret-code");
    });

    it("maps guild_already_linked (409) to the already-linked reply", async () => {
        const { tenant } = mockTenant({
            ok: false,
            kind: "guild_already_linked",
            message: "guild already linked",
        });
        const { interaction, reply } = mockInteraction();
        await handleCupboardSetup(interaction, mockDeps(tenant).deps);

        expect(replyContent(reply)).toContain("already linked to a different Cupboard organization");
    });

    it("rejects a channel the bot cannot see without consuming the code", async () => {
        const { tenant, bindGuild } = mockTenant({ ok: true });
        const { deps, botPermissionsIn } = mockDeps(tenant, null);
        const { interaction, reply } = mockInteraction({
            channelOption: { id: "chan-hidden", type: ChannelType.GuildText },
        });
        await handleCupboardSetup(interaction, deps);

        expect(botPermissionsIn).toHaveBeenCalledWith("chan-hidden");
        expect(bindGuild).not.toHaveBeenCalled();
        const content = replyContent(reply);
        expect(content).toContain("cannot see");
        expect(content).toContain("<#chan-hidden>");
        expect(content).not.toContain("the-secret-code");
    });

    it("rejects when the bot lacks channel permissions, naming each missing one", async () => {
        const { tenant, bindGuild } = mockTenant({ ok: true });
        // The bot can see the channel but cannot post or open private threads.
        const { deps } = mockDeps(tenant, {
            has: (permission: bigint) => permission === PermissionFlagsBits.ViewChannel,
        });
        const { interaction, reply } = mockInteraction();
        await handleCupboardSetup(interaction, deps);

        expect(bindGuild).not.toHaveBeenCalled();
        const content = replyContent(reply);
        expect(content).toContain("Send Messages");
        expect(content).toContain("Create Private Threads");
        expect(content).not.toContain("View Channel");
        expect(content).toContain("was not used");
    });

    it("maps unreachable to the try-again reply", async () => {
        const { tenant } = mockTenant({
            ok: false,
            kind: "unreachable",
            message: "tenant service unreachable: fetch failed",
        });
        const { interaction, reply } = mockInteraction();
        await handleCupboardSetup(interaction, mockDeps(tenant).deps);

        expect(replyContent(reply)).toContain("could not be reached");
    });
});
