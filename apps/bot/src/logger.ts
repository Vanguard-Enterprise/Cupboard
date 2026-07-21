import pino from "pino";

// Error instances have non-enumerable `message`/`stack`, so the default
// serializer renders them as `{}` and drops the cause of the failure. Map
// pino's standard error serializer onto the keys the codebase actually uses
// (`error` and `err`) so logs preserve message, stack, and status fields.
export const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    formatters: {
        level: (label) => ({ level: label }),
    },
    base: undefined,
    serializers: {
        error: pino.stdSerializers.err,
        err: pino.stdSerializers.err,
    },
});
