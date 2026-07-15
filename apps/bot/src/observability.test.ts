import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Child-process assertion that the production wiring actually wraps pino:
 * register the ESM loader hook (what register-hook.ts does), enable the pino
 * instrumentation with a real tracer provider (what NodeSDK does inside
 * startObservability), THEN import pino, and check the emitted record carries
 * the active span's trace_id. Spawned under plain node because vitest's own
 * module runner does not load dependencies through node's ESM loader, so the
 * hook cannot be exercised in-process. No collector is required: trace
 * correlation is injected by the same instrumentation that feeds the OTLP log
 * pipeline, so a present trace_id proves the logger got wrapped.
 */
function verifyScript(withHook: boolean): string {
    return `
${withHook ? 'import { register } from "node:module";\nregister("@opentelemetry/instrumentation/hook.mjs", import.meta.url);' : ""}
const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
const { node } = await import("@opentelemetry/sdk-node");

const pinoInstr = getNodeAutoInstrumentations().find((i) =>
    i.instrumentationName.includes("pino"),
);
const provider = new node.NodeTracerProvider();
provider.register();
pinoInstr.setTracerProvider(provider);

const { default: pino } = await import("pino");
const lines = [];
const logger = pino({}, { write: (s) => lines.push(s) });
let expected = "";
provider.getTracer("verify").startActiveSpan("s", (span) => {
    expected = span.spanContext().traceId;
    logger.info("hello");
    span.end();
});
const record = JSON.parse(lines[0]);
console.log(JSON.stringify({ traceId: expected, recordTraceId: record.trace_id ?? null }));
`;
}

async function runVerify(withHook: boolean): Promise<{ traceId: string; recordTraceId: string | null }> {
    const { stdout } = await run(
        process.execPath,
        ["--input-type=module", "-e", verifyScript(withHook)],
        { cwd: packageRoot, timeout: 25_000 },
    );
    const lastLine = stdout.trim().split("\n").at(-1) ?? "";
    return JSON.parse(lastLine);
}

describe("pino OTel instrumentation", () => {
    it("wraps a pino imported after loader-hook registration and instrumentation start", async () => {
        const result = await runVerify(true);
        expect(result.recordTraceId).toBe(result.traceId);
        expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
    }, 30_000);

    it("does NOT wrap without the loader hook (why register-hook.ts must exist)", async () => {
        const result = await runVerify(false);
        expect(result.recordTraceId).toBeNull();
    }, 30_000);
});
