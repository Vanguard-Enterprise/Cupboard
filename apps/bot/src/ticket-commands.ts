/**
 * /ticket open|close handlers (PR5).
 *
 * open: POST /internal/tickets (the tenant resolves the guild binding
 * server-side), then create the private thread immediately for a linkable
 * reply and record it via POST discord-thread. The tenant also publishes
 * ticket.created for this ticket; whichever writer records a thread first
 * wins and the loser adopts via the 409 path, so the race is benign.
 *
 * close: gated to the ticket opener (opener_discord_user_id) or a holder of
 * the bound staff role, then POST /internal/tickets/{id}/status with
 * "closed" (the only status the route accepts). The confirmation the whole
 * thread sees is the relayed ticket.status line; the handler's own ack stays
 * ephemeral so the two never double up.
 */

import { MessageFlags } from "discord.js";
import type { Logger } from "pino";
import { hydrateGuildBinding, type GuildState } from "./guild-state.js";
import { renderMessage, threadName, type DiscordPort } from "./relay.js";
import type { TenantApi } from "./tenant-api.js";

export type TicketCommandDeps = {
    tenant: TenantApi;
    state: GuildState;
    discord: DiscordPort;
    logger: Logger;
};

/** The slice of ChatInputCommandInteraction the open handler touches. */
export type TicketOpenInteraction = {
    guildId: string | null;
    user: { id: string; username: string };
    member: { displayName?: string } | null;
    options: {
        getString(name: string, required: true): string;
        getString(name: string): string | null;
    };
    reply(options: { content: string; flags: MessageFlags.Ephemeral }): Promise<unknown>;
};

export async function handleTicketOpen(
    interaction: TicketOpenInteraction,
    deps: TicketCommandDeps,
): Promise<void> {
    const ephemeral = (content: string) =>
        interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (interaction.guildId === null) {
        await ephemeral("Run this command inside a Discord server linked to Cupboard.");
        return;
    }
    const subject = interaction.options.getString("subject", true).trim();
    if (subject === "") {
        await ephemeral("Give the ticket a subject.");
        return;
    }
    const body = interaction.options.getString("body")?.trim() || undefined;
    const category = interaction.options.getString("category")?.trim() || undefined;
    const display = interaction.member?.displayName ?? interaction.user.username;

    const created = await deps.tenant.createTicket({
        guildId: interaction.guildId,
        openerDiscordUserId: interaction.user.id,
        openerDisplay: display,
        subject,
        category,
        body,
    });
    if (!created.ok) {
        deps.logger.warn(
            { guild_id: interaction.guildId, kind: created.kind, error: created.message },
            "ticket open failed",
        );
        await ephemeral(
            "Could not open a ticket. This server may not be linked to Cupboard yet (an admin can run /cupboard setup), or Cupboard is briefly unreachable; please try again.",
        );
        return;
    }
    const ticket = created.ticket;
    const shortId = ticket.id.slice(0, 8);

    // Create the thread now for a linkable confirmation. A successful create
    // proves the guild is bound, so a missing channel just means this guild
    // has not been hydrated yet (e.g. joined after boot); hydrate on demand,
    // and only fall back to a threadless confirmation if that fails too (the
    // ticket.created stream event retries thread creation when it can).
    let channelId = ticket.discord_channel_id ?? deps.state.channelForGuild(interaction.guildId);
    if (channelId === undefined) {
        await hydrateGuildBinding(interaction.guildId, {
            tenant: deps.tenant,
            state: deps.state,
            logger: deps.logger,
        });
        channelId = deps.state.channelForGuild(interaction.guildId);
    }
    if (channelId === undefined) {
        deps.logger.warn(
            { ticket_id: ticket.id, guild_id: interaction.guildId },
            "tickets channel unknown; ticket opened without a thread",
        );
        await ephemeral(`Ticket ${shortId} opened: staff will follow up.`);
        return;
    }

    try {
        const threadId = await deps.discord.createPrivateThread(
            channelId,
            threadName(ticket.id, subject),
        );
        const staffRole = deps.state.staffRoleForGuild(interaction.guildId);
        const ping = staffRole !== undefined ? ` <@&${staffRole}>` : "";
        const categoryNote = category !== undefined ? ` (category: ${category})` : "";
        // Header mention policy mirrors the relay: subject and display name
        // are player text, so only the staff role may ever ping.
        await deps.discord.postToThread(
            threadId,
            `New ticket from **${display}**${categoryNote}: ${subject}${ping}`,
            { pingRoles: staffRole !== undefined ? [staffRole] : [] },
        );
        if (body !== undefined) {
            await deps.discord.postToThread(threadId, renderMessage(display, body));
        }
        await deps.discord.addThreadMember(threadId, interaction.user.id).catch(() => undefined);

        // The cache only ever learns a CONFIRMED thread: the one the tenant
        // recorded (204), or the one adopted after a 409. Anything else would
        // poison the cache with an orphan thread and diverge transcripts.
        let confirmedThreadId: string | undefined;
        const recorded = await deps.tenant.recordDiscordThread(ticket.id, {
            guildId: interaction.guildId,
            discordChannelId: channelId,
            discordThreadId: threadId,
        });
        if (recorded.ok) {
            confirmedThreadId = threadId;
        } else if (recorded.kind === "conflict") {
            // The stream consumer won the race; adopt its thread.
            const again = await deps.tenant.getTicket(ticket.id, interaction.guildId);
            if (again.ok && typeof again.ticket.discord_thread_id === "string") {
                confirmedThreadId = again.ticket.discord_thread_id;
            } else {
                deps.logger.warn(
                    { ticket_id: ticket.id },
                    "thread conflict but adoption re-fetch failed; leaving cache empty",
                );
            }
        } else {
            deps.logger.warn(
                { ticket_id: ticket.id, error: recorded.message },
                "recording ticket thread failed; leaving cache empty",
            );
        }
        if (confirmedThreadId !== undefined) {
            deps.state.recordThread(ticket.id, confirmedThreadId);
            await ephemeral(`Ticket ${shortId} opened: <#${confirmedThreadId}>`);
        } else {
            await ephemeral(`Ticket ${shortId} opened: staff will follow up.`);
        }
    } catch (err) {
        deps.logger.warn(
            { ticket_id: ticket.id, error: err instanceof Error ? err.message : String(err) },
            "ticket thread creation failed",
        );
        await ephemeral(`Ticket ${shortId} opened: staff will follow up.`);
    }
}

/** The slice of ChatInputCommandInteraction the close handler touches. */
export type TicketCloseInteraction = {
    guildId: string | null;
    channelId: string;
    channel: { isThread(): boolean } | null;
    user: { id: string };
    /** Resolved role ids of the invoking member (adapter flattens them). */
    memberRoleIds: readonly string[];
    reply(options: { content: string; flags: MessageFlags.Ephemeral }): Promise<unknown>;
};

export async function handleTicketClose(
    interaction: TicketCloseInteraction,
    deps: TicketCommandDeps,
): Promise<void> {
    const ephemeral = (content: string) =>
        interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (interaction.guildId === null || interaction.channel?.isThread() !== true) {
        await ephemeral("Run /ticket close inside a ticket thread.");
        return;
    }
    // Always fetch by-thread (not just the id cache): the gate needs the
    // ticket's opener_discord_user_id, and closes are rare enough that the
    // extra read is cheap.
    const result = await deps.tenant.getTicketByThread(interaction.channelId, interaction.guildId);
    if (!result.ok) {
        if (result.kind === "not_found") {
            await ephemeral("This thread is not linked to a Cupboard ticket.");
        } else {
            await ephemeral("Cupboard could not be reached; please try again in a moment.");
        }
        return;
    }
    const ticket = result.ticket;
    deps.state.recordThread(ticket.id, interaction.channelId);

    // Gate: the ticket opener, or a holder of the bound staff role. Web-opened
    // tickets have no opener_discord_user_id, so only staff can close those.
    const staffRole = deps.state.staffRoleForGuild(interaction.guildId);
    const isStaff = staffRole !== undefined && interaction.memberRoleIds.includes(staffRole);
    const isOpener =
        typeof ticket.opener_discord_user_id === "string" &&
        ticket.opener_discord_user_id === interaction.user.id;
    if (!isStaff && !isOpener) {
        await ephemeral("Only the ticket opener or staff can close this ticket.");
        return;
    }

    const closed = await deps.tenant.closeTicket(ticket.id, interaction.guildId);
    if (!closed.ok) {
        deps.logger.warn(
            { ticket_id: ticket.id, kind: closed.kind, error: closed.message },
            "ticket close failed",
        );
        await ephemeral("Could not close the ticket; please try again in a moment.");
        return;
    }
    deps.logger.info(
        { ticket_id: ticket.id, guild_id: interaction.guildId, staff: isStaff },
        "ticket closed from discord",
    );
    // The in-thread confirmation everyone sees is the relayed ticket.status
    // line the close just triggered; this ack is ephemeral by design.
    await ephemeral(`Ticket ${ticket.id.slice(0, 8)} closed.`);
}
