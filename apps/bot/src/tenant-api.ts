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

/** Ticket wire shape from the internal routes (fields the bot reads). */
export type TicketRecord = {
    id: string;
    type?: string;
    status?: string;
    subject?: string;
    category?: string | null;
    opener_discord_user_id?: string | null;
    discord_channel_id?: string | null;
    discord_thread_id?: string | null;
};

/** Ticket message wire shape (internal notes are already excluded server-side). */
export type TicketMessageRecord = {
    id: string;
    author_kind: string;
    author_display: string;
    body: string;
    origin: string;
};

export type ApiFailure = {
    ok: false;
    kind: "not_found" | "conflict" | "unreachable" | "unexpected";
    /** Safe-to-log summary. Never contains tokens or message bodies. */
    message: string;
};

export type CreateTicketRequest = {
    guildId: string;
    openerDiscordUserId: string;
    openerDisplay: string;
    subject: string;
    category?: string;
    body?: string;
};

export type PostTicketMessageRequest = {
    guildId: string;
    discordMessageId: string;
    authorDisplay: string;
    authorKind: "player" | "staff";
    body: string;
};

export type RecordThreadRequest = {
    guildId: string;
    discordChannelId: string;
    discordThreadId: string;
};

/** The guild's Discord binding configuration (boot-time hydration). */
export type DiscordConfigRecord = {
    tenant_id: string;
    tickets_channel_id: string;
    staff_role_id?: string | null;
};

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

    // ======================= PR5 ticket relay surface =======================
    // Every call carries guild_id; the tenant resolves the tenant server-side
    // from its guild binding and never trusts a bot-supplied tenant id.

    /** POST /internal/tickets: open a ticket from Discord. 201 {ticket}. */
    async createTicket(request: CreateTicketRequest): Promise<{ ok: true; ticket: TicketRecord } | ApiFailure> {
        const outcome = await this.request("POST", "/internal/tickets", {
            guild_id: request.guildId,
            opener_discord_user_id: request.openerDiscordUserId,
            opener_display: request.openerDisplay,
            subject: request.subject,
            ...(request.category !== undefined ? { category: request.category } : {}),
            ...(request.body !== undefined ? { body: request.body } : {}),
        });
        if ("networkError" in outcome) {
            return unreachable(outcome.networkError);
        }
        if (outcome.status === 201) {
            const body = (await readJson(outcome)) as { ticket?: TicketRecord } | null;
            if (body?.ticket?.id !== undefined) {
                return { ok: true, ticket: body.ticket };
            }
            return { ok: false, kind: "unexpected", message: "201 without a ticket payload" };
        }
        return await failureFrom(outcome);
    }

    /** GET /internal/tickets/{id}?guild_id=: ticket + non-internal messages. */
    async getTicket(
        ticketId: string,
        guildId: string,
    ): Promise<{ ok: true; ticket: TicketRecord; messages: TicketMessageRecord[] } | ApiFailure> {
        const outcome = await this.request(
            "GET",
            `/internal/tickets/${encodeURIComponent(ticketId)}?guild_id=${encodeURIComponent(guildId)}`,
        );
        if ("networkError" in outcome) {
            return unreachable(outcome.networkError);
        }
        if (outcome.status === 200) {
            const body = (await readJson(outcome)) as
                | { ticket?: TicketRecord; messages?: TicketMessageRecord[] }
                | null;
            if (body?.ticket?.id !== undefined) {
                return { ok: true, ticket: body.ticket, messages: body.messages ?? [] };
            }
            return { ok: false, kind: "unexpected", message: "200 without a ticket payload" };
        }
        return await failureFrom(outcome);
    }

    /** GET /internal/tickets/by-thread/{thread_id}?guild_id=. 404 = not a ticket thread. */
    async getTicketByThread(
        threadId: string,
        guildId: string,
    ): Promise<{ ok: true; ticket: TicketRecord } | ApiFailure> {
        const outcome = await this.request(
            "GET",
            `/internal/tickets/by-thread/${encodeURIComponent(threadId)}?guild_id=${encodeURIComponent(guildId)}`,
        );
        if ("networkError" in outcome) {
            return unreachable(outcome.networkError);
        }
        if (outcome.status === 200) {
            const body = (await readJson(outcome)) as { ticket?: TicketRecord } | null;
            if (body?.ticket?.id !== undefined) {
                return { ok: true, ticket: body.ticket };
            }
            return { ok: false, kind: "unexpected", message: "200 without a ticket payload" };
        }
        return await failureFrom(outcome);
    }

    /**
     * POST /internal/tickets/{id}/messages: relay a Discord message. 201 =
     * inserted, 200 {deduped:true} = already relayed (unique discord_message_id);
     * both are success.
     */
    async postTicketMessage(
        ticketId: string,
        request: PostTicketMessageRequest,
    ): Promise<{ ok: true; deduped: boolean } | ApiFailure> {
        const outcome = await this.request(
            "POST",
            `/internal/tickets/${encodeURIComponent(ticketId)}/messages`,
            {
                guild_id: request.guildId,
                discord_message_id: request.discordMessageId,
                author_display: request.authorDisplay,
                author_kind: request.authorKind,
                body: request.body,
            },
        );
        if ("networkError" in outcome) {
            return unreachable(outcome.networkError);
        }
        if (outcome.status === 201) {
            return { ok: true, deduped: false };
        }
        if (outcome.status === 200) {
            return { ok: true, deduped: true };
        }
        return await failureFrom(outcome);
    }

    /**
     * POST /internal/tickets/{id}/discord-thread: record the created thread.
     * 204 = recorded; 409 = a DIFFERENT thread is already recorded (the caller
     * adopts it via getTicket).
     */
    async recordDiscordThread(
        ticketId: string,
        request: RecordThreadRequest,
    ): Promise<{ ok: true } | ApiFailure> {
        const outcome = await this.request(
            "POST",
            `/internal/tickets/${encodeURIComponent(ticketId)}/discord-thread`,
            {
                guild_id: request.guildId,
                discord_channel_id: request.discordChannelId,
                discord_thread_id: request.discordThreadId,
            },
        );
        if ("networkError" in outcome) {
            return unreachable(outcome.networkError);
        }
        if (outcome.status === 204) {
            return { ok: true };
        }
        return await failureFrom(outcome);
    }

    /**
     * GET /internal/tickets/discord/config?guild_id=: the guild's binding
     * (tenant, tickets channel, staff role). 404 = unknown or unlinked guild.
     */
    async getDiscordConfig(
        guildId: string,
    ): Promise<{ ok: true; config: DiscordConfigRecord } | ApiFailure> {
        const outcome = await this.request(
            "GET",
            `/internal/tickets/discord/config?guild_id=${encodeURIComponent(guildId)}`,
        );
        if ("networkError" in outcome) {
            return unreachable(outcome.networkError);
        }
        if (outcome.status === 200) {
            const body = (await readJson(outcome)) as Partial<DiscordConfigRecord> | null;
            // Strict string guards: a JSON null (or anything non-string) must
            // never flow onward as a channel or tenant id.
            if (
                typeof body?.tenant_id === "string" &&
                typeof body.tickets_channel_id === "string"
            ) {
                return {
                    ok: true,
                    config: {
                        tenant_id: body.tenant_id,
                        tickets_channel_id: body.tickets_channel_id,
                        staff_role_id:
                            typeof body.staff_role_id === "string" ? body.staff_role_id : undefined,
                    },
                };
            }
            return { ok: false, kind: "unexpected", message: "200 without a config payload" };
        }
        return await failureFrom(outcome);
    }

    /**
     * POST /internal/tickets/{id}/status: transition a ticket from Discord.
     * The route accepts ONLY "closed" (400 otherwise) and publishes
     * ticket.status normally, which is how the in-thread confirmation lands.
     */
    async closeTicket(ticketId: string, guildId: string): Promise<{ ok: true } | ApiFailure> {
        const outcome = await this.request(
            "POST",
            `/internal/tickets/${encodeURIComponent(ticketId)}/status`,
            { guild_id: guildId, status: "closed" },
        );
        if ("networkError" in outcome) {
            return unreachable(outcome.networkError);
        }
        if (outcome.status === 204 || outcome.status === 200) {
            return { ok: true };
        }
        return await failureFrom(outcome);
    }

    /**
     * DELETE /internal/tickets/{id}/discord-thread: clear the recorded thread
     * ids after Discord reports the thread gone (Unknown Channel, 10003), so
     * the next event lazily re-creates the thread with backfill.
     */
    async clearDiscordThread(
        ticketId: string,
        guildId: string,
    ): Promise<{ ok: true } | ApiFailure> {
        const outcome = await this.request(
            "DELETE",
            `/internal/tickets/${encodeURIComponent(ticketId)}/discord-thread`,
            { guild_id: guildId },
        );
        if ("networkError" in outcome) {
            return unreachable(outcome.networkError);
        }
        if (outcome.status === 204 || outcome.status === 200) {
            return { ok: true };
        }
        return await failureFrom(outcome);
    }

    /** Shared fetch with the internal-token header and timeout; never logs. */
    private async request(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<Response | { networkError: string }> {
        try {
            return await this.fetchFn(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    "content-type": "application/json",
                    "x-internal-token": this.botApiToken,
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            return { networkError: err instanceof Error ? err.message : String(err) };
        }
    }
}

function unreachable(detail: string): ApiFailure {
    return { ok: false, kind: "unreachable", message: `tenant service unreachable: ${detail}` };
}

async function failureFrom(response: Response): Promise<ApiFailure> {
    const envelope = await readEnvelope(response);
    switch (response.status) {
        case 404:
            return { ok: false, kind: "not_found", message: envelope };
        case 409:
            return { ok: false, kind: "conflict", message: envelope };
        default:
            return {
                ok: false,
                kind: "unexpected",
                message: `unexpected status ${response.status}: ${envelope}`,
            };
    }
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
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
