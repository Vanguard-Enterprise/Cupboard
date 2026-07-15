/**
 * cupboard-bot entrypoint. Boot order matters:
 *   1. Observability (the NodeSDK must patch modules before they are loaded,
 *      so everything else, INCLUDING the pino logger, is imported dynamically
 *      afterwards; a hoisted pino would be constructed before sdk.start()
 *      registers the pino instrumentation and the OTLP log pipeline would
 *      export nothing). The ESM loader hook this relies on is registered by
 *      register-hook.ts, which node loads first via --import.
 *   2. Config (fail fast on missing env).
 *   3. Discord client (Guilds intent only in PR4; the message-content intent
 *      and message relay wiring are PR5) + the ticket stream consumer.
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

    const { Client, Events, GatewayIntentBits, MessageFlags } = await import("discord.js");
    const { fetchBotChannelPermissions, handleCupboardSetup, registerCommands } = await import(
        "./commands.js"
    );
    const { TenantApi } = await import("./tenant-api.js");
    const { TicketStreamConsumer } = await import("./consumer.js");

    const tenant = new TenantApi({
        baseUrl: config.tenantInternalUrl,
        botApiToken: config.botApiToken,
    });
    const consumer = new TicketStreamConsumer(config.redisUrl, logger);
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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

    client.on(Events.InteractionCreate, async (interaction) => {
        // PR5 seam: /ticket open|close subcommand dispatch branches here.
        if (!interaction.isChatInputCommand() || interaction.commandName !== "cupboard") {
            return;
        }
        try {
            if (interaction.options.getSubcommand() === "setup") {
                await handleCupboardSetup(interaction, {
                    tenant,
                    logger,
                    botPermissionsIn: (channelId) => fetchBotChannelPermissions(client, channelId),
                });
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

    await consumer.start();
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
