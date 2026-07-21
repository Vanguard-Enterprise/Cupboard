/**
 * Slash-command definitions, registration, and the /cupboard setup handler.
 * The /ticket open|close handlers live in ticket-commands.ts.
 */

import {
    ChannelType,
    type Client,
    MessageFlags,
    PermissionFlagsBits,
    REST,
    Routes,
    SlashCommandBuilder,
} from "discord.js";
import type { Logger } from "pino";
import type { BindResult, TenantApi } from "./tenant-api.js";

export function buildCommands() {
    const cupboard = new SlashCommandBuilder()
        .setName("cupboard")
        .setDescription("Cupboard server tools")
        .addSubcommand((sub) =>
            sub
                .setName("setup")
                .setDescription("Link this Discord server to your Cupboard organization")
                .addStringOption((opt) =>
                    opt
                        .setName("code")
                        .setDescription("One-time setup code from the Cupboard admin UI")
                        .setRequired(true),
                )
                .addChannelOption((opt) =>
                    opt
                        .setName("channel")
                        .setDescription("Channel for ticket threads (defaults to this channel)")
                        .addChannelTypes(ChannelType.GuildText),
                )
                .addRoleOption((opt) =>
                    opt.setName("staff_role").setDescription("Role to ping on new tickets"),
                ),
        );
    const ticket = new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Cupboard support tickets")
        .addSubcommand((sub) =>
            sub
                .setName("open")
                .setDescription("Open a support ticket")
                .addStringOption((opt) =>
                    opt
                        .setName("subject")
                        .setDescription("What the ticket is about")
                        .setRequired(true)
                        .setMaxLength(200),
                )
                .addStringOption((opt) =>
                    opt.setName("body").setDescription("Describe the issue").setMaxLength(4000),
                )
                .addStringOption((opt) =>
                    opt.setName("category").setDescription("Optional category").setMaxLength(100),
                ),
        )
        .addSubcommand((sub) =>
            sub.setName("close").setDescription("Close the ticket in this thread"),
        );
    return [cupboard.toJSON(), ticket.toJSON()];
}

/** Register the command set globally via the REST API (idempotent overwrite). */
export async function registerCommands(options: {
    token: string;
    applicationId: string;
    logger: Logger;
}): Promise<void> {
    const rest = new REST().setToken(options.token);
    const commands = buildCommands();
    await rest.put(Routes.applicationCommands(options.applicationId), { body: commands });
    options.logger.info({ commands: commands.map((c) => c.name) }, "slash commands registered");
}

/**
 * The slice of ChatInputCommandInteraction the setup handler touches. Kept
 * structural so tests can mock it without a live Discord client.
 */
export type SetupInteraction = {
    guildId: string | null;
    channelId: string;
    channel: { type: ChannelType } | null;
    memberPermissions: { has(permission: bigint): boolean } | null;
    options: {
        getString(name: string, required: true): string;
        getChannel(name: string): { id: string; type: ChannelType } | null;
        getRole(name: string): { id: string } | null;
    };
    reply(options: { content: string; flags: MessageFlags.Ephemeral }): Promise<unknown>;
};

/** The slice of the bot's resolved channel permissions the handler checks. */
export type BotChannelPermissions = { has(permission: bigint): boolean };

export type SetupDeps = {
    tenant: TenantApi;
    logger: Logger;
    /**
     * Resolve the BOT's own permissions in a channel, or null when the bot
     * cannot see (or fetch) the channel at all. Injected so tests never need a
     * live client; index.ts wires `fetchBotChannelPermissions`.
     */
    botPermissionsIn(channelId: string): Promise<BotChannelPermissions | null>;
    /**
     * Called after a successful bind so the guild state learns the configured
     * channel and staff role (the bind response itself is a bare 204, so this
     * is the only moment the bot sees the configuration; see guild-state.ts).
     */
    onBound?(guildId: string, ticketsChannelId: string, staffRoleId: string | undefined): void;
};

/**
 * What the bot itself needs in the tickets channel to do its PR5 job (post
 * relays and open private threads). Checked BEFORE the bind call so a bad
 * channel choice never consumes the one-time code.
 */
const REQUIRED_CHANNEL_PERMISSIONS: readonly (readonly [string, bigint])[] = [
    ["View Channel", PermissionFlagsBits.ViewChannel],
    ["Send Messages", PermissionFlagsBits.SendMessages],
    ["Create Private Threads", PermissionFlagsBits.CreatePrivateThreads],
];

/**
 * Real-client implementation of `SetupDeps.botPermissionsIn`. The command
 * option picker is scoped to the INVOKING USER's visibility, so a channel the
 * bot cannot see is a real input; that case (and any fetch error) maps to null.
 */
export async function fetchBotChannelPermissions(
    client: Client,
    channelId: string,
): Promise<BotChannelPermissions | null> {
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel === null || channel.type !== ChannelType.GuildText) {
            return null;
        }
        const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
        return channel.permissionsFor(me);
    } catch {
        return null;
    }
}

/**
 * Handle `/cupboard setup <code> [channel] [staff_role]`.
 *
 * All replies are ephemeral, and the one-time code is never echoed back or
 * logged. The guild id comes from the interaction itself; the tenant service
 * resolves which tenant it binds to server-side (decision D).
 */
export async function handleCupboardSetup(
    interaction: SetupInteraction,
    deps: SetupDeps,
): Promise<void> {
    const ephemeral = (content: string) =>
        interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (interaction.guildId === null) {
        await ephemeral("Run this command inside the Discord server you want to link.");
        return;
    }

    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) !== true) {
        await ephemeral("You need the Manage Server permission to run /cupboard setup.");
        return;
    }

    // Default the tickets channel to wherever the command ran, but only if
    // that is a plain guild text channel (the option itself is already
    // restricted to text channels).
    const channelOption = interaction.options.getChannel("channel");
    let ticketsChannelId: string;
    if (channelOption !== null) {
        if (channelOption.type !== ChannelType.GuildText) {
            await ephemeral("The tickets channel must be a text channel.");
            return;
        }
        ticketsChannelId = channelOption.id;
    } else if (interaction.channel?.type === ChannelType.GuildText) {
        ticketsChannelId = interaction.channelId;
    } else {
        await ephemeral(
            "Run this command in a text channel, or pass the channel option to pick one.",
        );
        return;
    }

    // Preflight the bot's own access to the chosen channel. Rejecting here is
    // free: the one-time code is only consumed by a bind call that reaches the
    // tenant service, so the invoker can fix permissions and retry.
    const botPerms = await deps.botPermissionsIn(ticketsChannelId);
    if (botPerms === null) {
        await ephemeral(
            `I cannot see <#${ticketsChannelId}>. Give the bot access to that channel and run /cupboard setup again; your code was not used.`,
        );
        return;
    }
    const missing = REQUIRED_CHANNEL_PERMISSIONS.filter(([, bit]) => !botPerms.has(bit)).map(
        ([name]) => name,
    );
    if (missing.length > 0) {
        await ephemeral(
            `I am missing the following permission${missing.length > 1 ? "s" : ""} in <#${ticketsChannelId}>: ${missing.join(", ")}. Grant ${missing.length > 1 ? "them" : "it"} to the bot and run /cupboard setup again; your code was not used.`,
        );
        return;
    }

    const code = interaction.options.getString("code", true);
    const staffRole = interaction.options.getRole("staff_role");

    const result: BindResult = await deps.tenant.bindGuild({
        code,
        guildId: interaction.guildId,
        ticketsChannelId,
        staffRoleId: staffRole?.id,
    });

    if (result.ok) {
        deps.logger.info(
            { guild_id: interaction.guildId, tickets_channel_id: ticketsChannelId },
            "guild bound",
        );
        deps.onBound?.(interaction.guildId, ticketsChannelId, staffRole?.id);
        await ephemeral(
            `This server is now linked; tickets will sync to <#${ticketsChannelId}>.`,
        );
        return;
    }

    deps.logger.warn(
        { guild_id: interaction.guildId, kind: result.kind, message: result.message },
        "guild bind failed",
    );
    switch (result.kind) {
        case "invalid_code":
            await ephemeral(
                "That setup code is invalid, expired, or already used. Mint a new one in the Cupboard admin UI and try again.",
            );
            return;
        case "guild_already_linked":
            await ephemeral(
                "This Discord server is already linked to a different Cupboard organization.",
            );
            return;
        case "unreachable":
        case "unexpected":
            await ephemeral(
                "Cupboard could not be reached to complete the link. Please try again in a moment.",
            );
            return;
    }
}
