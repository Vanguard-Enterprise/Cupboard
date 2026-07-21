import { hostname } from "node:os";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeSDK, logs as sdkLogs, metrics as sdkMetrics } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
    ATTR_SERVICE_INSTANCE_ID,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_NAMESPACE,
} from "@opentelemetry/semantic-conventions";

const { AggregationTemporality } = sdkMetrics;

const enabled = process.env.OBSERVABILITY_ENABLED === "true";
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let sdk: NodeSDK | undefined;
let pyroscopeStarted = false;

/**
 * Start the OTel NodeSDK (traces, metrics, logs over gRPC OTLP) plus
 * best-effort Pyroscope profiling. Gated on OBSERVABILITY_ENABLED=true so
 * local runs stay silent. Returns a shutdown function for graceful exit.
 */
export async function startObservability(): Promise<() => Promise<void>> {
    if (!enabled) {
        return async () => undefined;
    }
    if (!endpoint) {
        throw new Error("OBSERVABILITY_ENABLED=true but OTEL_EXPORTER_OTLP_ENDPOINT is empty");
    }

    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

    // service.instance.id MUST be unique per process for Mimir to keep each
    // pod's cumulative counters as separate series. Append the PID so restarts
    // within the same pod name still get distinct IDs.
    const serviceInstanceId = `${hostname() || (process.env.OTEL_SERVICE_NAME ?? "cupboard-bot")}-${process.pid}`;

    const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "cupboard-bot",
        [ATTR_SERVICE_NAMESPACE]: process.env.OTEL_SERVICE_NAMESPACE ?? "cupboard",
        [ATTR_SERVICE_INSTANCE_ID]: serviceInstanceId,
        "deployment.environment": process.env.DEPLOYMENT_ENV ?? "local",
        team: "cupboard",
    });

    sdk = new NodeSDK({
        resource,
        traceExporter: new OTLPTraceExporter({ url: endpoint }),
        metricReaders: [
            new sdkMetrics.PeriodicExportingMetricReader({
                // Pin every instrument kind to cumulative temporality. The SDK's
                // default selector returns delta for some kinds; Mimir's OTLP
                // endpoint then mis-handles the counter-reset semantics and
                // badly inflates rate()/increase() results.
                exporter: new OTLPMetricExporter({
                    url: endpoint,
                    temporalityPreference: AggregationTemporality.CUMULATIVE,
                }),
                exportIntervalMillis: 30_000,
            }),
        ],
        logRecordProcessors: [
            new sdkLogs.BatchLogRecordProcessor(new OTLPLogExporter({ url: endpoint })),
        ],
        instrumentations: getNodeAutoInstrumentations({
            "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
    });

    sdk.start();

    // Pyroscope is best-effort: keep the try/catch so a missing prebuild
    // (e.g. when Node bumps an ABI ahead of @datadog/pprof) never blocks
    // tracing/metrics from coming up.
    if (process.env.PYROSCOPE_SERVER_ADDRESS) {
        try {
            const { default: Pyroscope } = await import("@pyroscope/nodejs");
            Pyroscope.init({
                appName: process.env.OTEL_SERVICE_NAME ?? "cupboard-bot",
                serverAddress: process.env.PYROSCOPE_SERVER_ADDRESS,
                tags: {
                    environment: process.env.DEPLOYMENT_ENV ?? "local",
                    namespace: process.env.OTEL_SERVICE_NAMESPACE ?? "cupboard",
                },
            });
            Pyroscope.start();
            pyroscopeStarted = true;
        } catch (err) {
            // Bare console on purpose: this module must never import the pino
            // logger (pino has to load AFTER sdk.start() so the instrumentation
            // wraps it), and this warning is a boot-path one-off anyway.
            console.warn(
                "pyroscope unavailable, continuing without profiling:",
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    return async () => {
        if (sdk) {
            await sdk.shutdown();
        }
        if (pyroscopeStarted) {
            const { default: Pyroscope } = await import("@pyroscope/nodejs");
            await Pyroscope.stop();
        }
    };
}
