/**
 * Env-driven configuration. Every required variable is validated up front so a
 * misconfigured pod crash-loops with one clear message instead of failing
 * halfway through boot.
 */

export type Config = {
    /** Discord bot token (OpenBao `cupboard/staging/bot` -> DISCORD_BOT_TOKEN). */
    discordBotToken: string;
    /** Redis connection URL for the ticket stream consumer. */
    redisUrl: string;
    /**
     * Bearer for tenant `/internal/tickets/*` (decision E: the bot-scoped token,
     * never the shared INTERNAL_API_TOKEN).
     */
    botApiToken: string;
    /** Base URL of the tenant service, e.g. http://cupboard-tenant:8080. */
    tenantInternalUrl: string;
};

const REQUIRED = [
    "DISCORD_BOT_TOKEN",
    "REDIS_URL",
    "BOT_API_TOKEN",
    "TENANT_INTERNAL_URL",
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const missing = REQUIRED.filter((name) => {
        const value = env[name];
        return value === undefined || value.trim() === "";
    });
    if (missing.length > 0) {
        throw new Error(
            `missing required environment variable(s): ${missing.join(", ")}. ` +
                "The bot needs DISCORD_BOT_TOKEN, REDIS_URL, BOT_API_TOKEN, and TENANT_INTERNAL_URL to start.",
        );
    }
    return {
        discordBotToken: env.DISCORD_BOT_TOKEN!,
        redisUrl: env.REDIS_URL!,
        botApiToken: env.BOT_API_TOKEN!,
        // Trim a trailing slash so path joins in tenant-api.ts stay predictable.
        tenantInternalUrl: env.TENANT_INTERNAL_URL!.replace(/\/+$/, ""),
    };
}
