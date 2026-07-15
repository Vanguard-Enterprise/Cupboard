import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const VALID_ENV = {
    DISCORD_BOT_TOKEN: "token-123",
    REDIS_URL: "redis://localhost:6379",
    BOT_API_TOKEN: "bot-api-token",
    TENANT_INTERNAL_URL: "http://cupboard-tenant:8080",
};

describe("loadConfig", () => {
    it("returns a config when every required variable is set", () => {
        const config = loadConfig({ ...VALID_ENV });
        expect(config.discordBotToken).toBe("token-123");
        expect(config.redisUrl).toBe("redis://localhost:6379");
        expect(config.botApiToken).toBe("bot-api-token");
        expect(config.tenantInternalUrl).toBe("http://cupboard-tenant:8080");
    });

    it("trims a trailing slash from TENANT_INTERNAL_URL", () => {
        const config = loadConfig({
            ...VALID_ENV,
            TENANT_INTERNAL_URL: "http://cupboard-tenant:8080/",
        });
        expect(config.tenantInternalUrl).toBe("http://cupboard-tenant:8080");
    });

    it.each(["DISCORD_BOT_TOKEN", "REDIS_URL", "BOT_API_TOKEN", "TENANT_INTERNAL_URL"])(
        "fails fast and names %s when it is missing",
        (name) => {
            const env: Record<string, string | undefined> = { ...VALID_ENV };
            delete env[name];
            expect(() => loadConfig(env)).toThrowError(new RegExp(name));
        },
    );

    it("treats a blank value as missing", () => {
        expect(() => loadConfig({ ...VALID_ENV, BOT_API_TOKEN: "   " })).toThrowError(
            /BOT_API_TOKEN/,
        );
    });

    it("lists every missing variable in one message", () => {
        expect(() => loadConfig({})).toThrowError(
            /DISCORD_BOT_TOKEN, REDIS_URL, BOT_API_TOKEN, TENANT_INTERNAL_URL/,
        );
    });
});
