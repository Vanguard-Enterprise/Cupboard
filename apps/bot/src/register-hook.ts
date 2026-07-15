/**
 * ESM loader-hook registration, loaded before the entrypoint via
 * `node --import ./dist/register-hook.js dist/index.js` (Dockerfile CMD and
 * the npm start script).
 *
 * Why it exists: require-in-the-middle only sees CommonJS requires, and this
 * process is pure ESM, so every dependency (pino included) arrives through
 * the ESM loader. Without import-in-the-middle registered here, the OTel
 * instrumentations wrap nothing, the pino logger never gets its trace mixin,
 * and the OTLP log pipeline exports zero records. Wrapping is proven by a
 * child-process assertion in observability.test.ts.
 *
 * Gated like observability.ts: local runs stay unhooked and fast.
 */
import { register } from "node:module";

if (process.env.OBSERVABILITY_ENABLED === "true") {
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
}
