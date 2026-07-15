/**
 * Typed client for the tenant service's bot-facing internal surface
 * (decision E). Authenticated with the bot-scoped BOT_API_TOKEN, which the
 * tenant service accepts ONLY on /internal/tickets/*.
 *
 * Security invariants: the token and the plaintext one-time bind code are
 * never logged and never echoed back to callers in error messages.
 */

export type BindRequest = {
    /** Plaintext one-time code minted in the admin UI. */
    code: string;
    guildId: string;
    ticketsChannelId: string;
    staffRoleId?: string;
};

export type BindResult =
    | { ok: true }
    | {
          ok: false;
          kind: "invalid_code" | "guild_already_linked" | "unreachable" | "unexpected";
          /** Safe-to-log summary. Never contains the code or the token. */
          message: string;
      };

/** The shared error envelope the tenant service returns on failures. */
type ErrorEnvelope = { error?: string; message?: string };

export type TenantApiOptions = {
    baseUrl: string;
    botApiToken: string;
    /** Per-request timeout in milliseconds. */
    timeoutMs?: number;
    /** Injectable for tests. */
    fetchFn?: typeof fetch;
};

export class TenantApi {
    private readonly baseUrl: string;
    private readonly botApiToken: string;
    private readonly timeoutMs: number;
    private readonly fetchFn: typeof fetch;

    constructor(options: TenantApiOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.botApiToken = options.botApiToken;
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.fetchFn = options.fetchFn ?? fetch;
    }

    /**
     * POST /internal/tickets/discord/bind. 204 = bound. 401 covers both a bad
     * internal token and an invalid/expired/used code; the tenant service
     * deliberately keeps the message generic, and so do we.
     */
    async bindGuild(request: BindRequest): Promise<BindResult> {
        const body: Record<string, string> = {
            code: request.code,
            guild_id: request.guildId,
            tickets_channel_id: request.ticketsChannelId,
        };
        if (request.staffRoleId !== undefined) {
            body.staff_role_id = request.staffRoleId;
        }

        let response: Response;
        try {
            response = await this.fetchFn(`${this.baseUrl}/internal/tickets/discord/bind`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-internal-token": this.botApiToken,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            return { ok: false, kind: "unreachable", message: `tenant service unreachable: ${detail}` };
        }

        if (response.status === 204) {
            return { ok: true };
        }

        const envelope = await readEnvelope(response);
        switch (response.status) {
            case 401:
                // Bad token and invalid/expired/used code are indistinguishable
                // by design; treat both as an invalid code toward the invoker
                // (a token misconfiguration surfaces in operator logs, not chat).
                return { ok: false, kind: "invalid_code", message: envelope };
            case 409:
                return { ok: false, kind: "guild_already_linked", message: envelope };
            default:
                return {
                    ok: false,
                    kind: "unexpected",
                    message: `unexpected status ${response.status}: ${envelope}`,
                };
        }
    }
}

async function readEnvelope(response: Response): Promise<string> {
    try {
        const parsed = (await response.json()) as ErrorEnvelope;
        return parsed.message ?? parsed.error ?? "no error detail";
    } catch {
        return "no error detail";
    }
}
