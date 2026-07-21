/**
 * cupboard-bot entrypoint. Boot order matters:
 *   1. Observability (the NodeSDK must patch modules before they are loaded,
 *      so everything else, INCLUDING the pino logger, is imported dynamically
 *      afterwards; a hoisted pino would be constructed before sdk.start()
 *      registers the pino instrumentation and the OTLP log pipeline would
 *      export nothing). The ESM loader hook this relies on is registered by
 *      register-hook.ts, which node loads first via --import.
 *   2. Config (fail fast on missing env).
 *   3. Discord client (Guilds + GuildMessages + MessageContent for the PR5
 *      two-way relay; message-content is the privileged intent Frank toggled
 *      in the developer portal) + the ticket stream consumer feeding the
 *      relay pipeline.
 *
 * The deployment has no probes (headless worker), so crash equals restart:
 * unrecoverable states (invalidated session, unhandled rejection) exit nonzero
 * instead of lingering silently.
 */

import { startObservability } from "./observability.js";

async function main(): Promise<void> {
    const stopObservability = await startObservability();

    // Only after sdk.start(): the pino instrumentation must wrap the module.
    const { logger } = await import("./logger.js");

    process.on("unhandledRejection", (reason) => {
        logger.error({ error: reason }, "unhandled promise rejection, exiting");
        process.exit(1);
    });

    const { loadConfig } = await import("./config.js");
    const config = loadConfig();

    const { ChannelType, Client, Events, GatewayIntentBits, MessageFlags } = await import(
        "discord.js"
    );
    const { fetchBotChannelPermissions, handleCupboardSetup, registerCommands } = await import(
        "./commands.js"
    );
    const { handleTicketClose, handleTicketOpen } = await import("./ticket-commands.js");
    const { handleGuildMessage } = await import("./message-listener.js");
    const { TenantApi } = await import("./tenant-api.js");
    const { TicketStreamConsumer } = await import("./consumer.js");
    const { RedisFence, TicketRelay, UnknownChannelError } = await import("./relay.js");
    const { GuildState, hydrateGuildBinding } = await import("./guild-state.js");
    const { Redis } = await import("ioredis");

    const tenant = new TenantApi({
        baseUrl: config.tenantInternalUrl,
        botApiToken: config.botApiToken,
    });
    const state = new GuildState();
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    // The relay fence rides its OWN Redis connection: the consumer's
    // connection spends its life inside blocking XREADGROUP reads, and ioredis
    // serializes commands per connection, so a fence EXISTS/SET queued behind
    // a BLOCK 5000 read could stall for the full block interval.
    const fenceRedis = new Redis(config.redisUrl, {
        lazyConnect: true,
        retryStrategy: (times: number) => Math.min(times * 500, 30_000),
    });
    fenceRedis.on("error", (err) => {
        logger.warn({ error: err.message }, "fence redis connection error");
    });
    await fenceRedis.connect();

    /** Discord "Unknown Channel": the target channel/thread no longer exists. */
    const isUnknownChannel = (err: unknown): boolean =>
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === 10003;

    const fetchThread = async (threadId: string) => {
        let channel;
        try {
            channel = await client.channels.fetch(threadId);
        } catch (err) {
            if (isUnknownChannel(err)) {
                throw new UnknownChannelError(`thread ${threadId} no longer exists`);
            }
            throw err;
        }
        if (channel === null || !channel.isThread()) {
            throw new UnknownChannelError(`thread ${threadId} is missing or not a thread`);
        }
        return channel;
    };

    const discordPort: import("./relay.js").DiscordPort = {
        isReady: () => client.isReady(),
        guildIds: () => [...client.guilds.cache.keys()],
        createPrivateThread: async (channelId, name) => {
            // Deliberately NOT UnknownChannelError on a missing tickets
            // channel: that is stale configuration, not a deleted thread, and
            // stays on the retry path (see relay.ts).
            const channel = await client.channels.fetch(channelId);
            if (channel === null || channel.type !== ChannelType.GuildText) {
                throw new Error("tickets channel is missing or not a text channel");
            }
            const thread = await channel.threads.create({
                name,
                type: ChannelType.PrivateThread,
                invitable: false,
                reason: "Cupboard ticket",
            });
            return thread.id;
        },
        postToThread: async (threadId, content, options) => {
            const channel = await fetchThread(threadId);
            try {
                await channel.send({
                    content,
                    // Player-controlled text is interpolated into every post:
                    // nothing may ping except the explicitly allowed role ids
                    // (the staff role in headers). Never user mentions; in a
                    // private thread a live user mention also injects them.
                    allowedMentions: { parse: [], users: [], roles: [...(options?.pingRoles ?? [])] },
                });
            } catch (err) {
                if (isUnknownChannel(err)) {
                    throw new UnknownChannelError(`thread ${threadId} no longer exists`);
                }
                throw err;
            }
        },
        addThreadMember: async (threadId, userId) => {
            const channel = await fetchThread(threadId);
            await channel.members.add(userId);
        },
    };

    const relay = new TicketRelay({
        tenant,
        discord: discordPort,
        fence: new RedisFence(fenceRedis),
        state,
        logger,
    });
    const consumer = new TicketStreamConsumer(config.redisUrl, logger, (event) =>
        relay.handleEvent(event),
    );

    client.once(Events.ClientReady, async (readyClient) => {
        logger.info(
            { user_id: readyClient.user.id, guilds: readyClient.guilds.cache.size },
            "discord gateway ready",
        );
        try {
            await registerCommands({
                token: config.discordBotToken,
                applicationId: readyClient.application.id,
                logger,
            });
        } catch (err) {
            logger.error({ error: err }, "slash command registration failed");
        }
        // Boot-time binding hydration (see guild-state.ts): relearn every
        // guild's tenant/channel/staff-role so a restart loses nothing. 404s
        // are unlinked guilds; errors retry lazily per event.
        let linked = 0;
        for (const guildId of readyClient.guilds.cache.keys()) {
            if ((await hydrateGuildBinding(guildId, { tenant, state, logger })) === "linked") {
                linked += 1;
            }
        }
        logger.info(
            { guilds: readyClient.guilds.cache.size, linked },
            "guild bindings hydrated",
        );
        // The consumer starts ONLY here, after ready + hydration: started any
        // earlier it would drain the boot backlog (and reclaimed entries)
        // against an empty guild cache. The relay's ready guard additionally
        // turns any ordering regression into retries instead of drops.
        try {
            await consumer.start();
        } catch (err) {
            logger.error({ error: err }, "ticket stream consumer failed to start, exiting");
            process.exit(1);
        }
    });

    // Gateway death must be visible: discord.js surfaces connection failures
    // as ShardError, which is silently dropped without a listener.
    client.on(Events.ShardError, (err, shardId) => {
        logger.error({ error: err, shard_id: shardId }, "shard connection error");
    });
    client.on(Events.Error, (err) => {
        logger.error({ error: err }, "discord client error");
    });
    client.once(Events.Invalidated, () => {
        // The session cannot recover (e.g. a reset token); exit nonzero so
        // Kubernetes restarts the pod instead of leaving it Running and mute.
        logger.error("discord session invalidated, exiting for restart");
        process.exit(1);
    });

    // Discord -> platform relay (PR5). The adapter flattens the discord.js
    // Message into the structural slice the handler tests against; attachment
    // URLs ride along as extra lines (uploads themselves are a deferral).
    client.on(Events.MessageCreate, async (message) => {
        try {
            const content = [message.content, ...message.attachments.map((a) => a.url)]
                .filter((part) => part !== "")
                .join("\n");
            await handleGuildMessage(
                {
                    id: message.id,
                    guildId: message.guildId,
                    channelId: message.channelId,
                    inThread: message.channel.isThread(),
                    authorId: message.author.id,
                    authorIsBot: message.author.bot,
                    authorDisplay: message.member?.displayName ?? message.author.username,
                    memberRoleIds: message.member ? [...message.member.roles.cache.keys()] : [],
                    content,
                },
                { tenant, state, logger, botUserId: client.user?.id ?? "" },
            );
        } catch (err) {
            logger.error({ error: err }, "discord message relay failed");
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) {
            return;
        }
        try {
            if (interaction.commandName === "cupboard") {
                if (interaction.options.getSubcommand() === "setup") {
                    await handleCupboardSetup(interaction, {
                        tenant,
                        logger,
                        botPermissionsIn: (channelId) =>
                            fetchBotChannelPermissions(client, channelId),
                        onBound: (guildId, channelId, staffRoleId) => {
                            state.recordChannel(guildId, channelId);
                            state.recordStaffRole(guildId, staffRoleId);
                        },
                    });
                }
                return;
            }
            if (interaction.commandName === "ticket") {
                const deps = { tenant, state, discord: discordPort, logger };
                switch (interaction.options.getSubcommand()) {
                    case "open":
                        await handleTicketOpen(
                            {
                                guildId: interaction.guildId,
                                user: {
                                    id: interaction.user.id,
                                    username: interaction.user.username,
                                },
                                // APIInteractionGuildMember (uncached) has no
                                // displayName; fall back to the username.
                                member:
                                    interaction.member !== null &&
                                    "displayName" in interaction.member
                                        ? { displayName: interaction.member.displayName }
                                        : null,
                                options: interaction.options,
                                reply: (opts) => interaction.reply(opts),
                            },
                            deps,
                        );
                        return;
                    case "close":
                        await handleTicketClose(
                            {
                                guildId: interaction.guildId,
                                channelId: interaction.channelId,
                                channel: interaction.channel,
                                user: { id: interaction.user.id },
                                // GuildMemberRoleManager (cached) vs raw role
                                // id array (uncached interaction payload).
                                memberRoleIds:
                                    interaction.member === null
                                        ? []
                                        : Array.isArray(interaction.member.roles)
                                          ? interaction.member.roles
                                          : [...interaction.member.roles.cache.keys()],
                                reply: (opts) => interaction.reply(opts),
                            },
                            deps,
                        );
                        return;
                    default:
                        return;
                }
            }
        } catch (err) {
            logger.error({ error: err }, "interaction handling failed");
            if (!interaction.replied && !interaction.deferred) {
                await interaction
                    .reply({
                        content: "Something went wrong; please try again.",
                        flags: MessageFlags.Ephemeral,
                    })
                    .catch(() => undefined);
            }
        }
    });

    await client.login(config.discordBotToken);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        logger.info({ signal }, "shutting down");
        await client.destroy();
        await consumer.stop();
        fenceRedis.disconnect();
        await stopObservability();
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
    // The pino logger may not exist yet (observability boots first); bare
    // console keeps the fatal reason visible in pod logs regardless.
    console.error("fatal boot error:", err);
    process.exit(1);
});
