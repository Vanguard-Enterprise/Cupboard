/**
 * The TICKET_STREAM wire contract (crates/domain/src/events.rs `TicketEvent`).
 * Entries on `cupboard:tickets` carry one field, `data`, whose value is a JSON
 * object with a `kind` discriminator and per-kind optional fields. Optional
 * fields are ABSENT when null (skip_serializing_if on the producer), so every
 * per-kind field here is `?`.
 */

export const TICKET_STREAM = "cupboard:tickets";
export const CONSUMER_GROUP = "bot";

export type TicketEventKind = "ticket.created" | "ticket.message" | "ticket.status";

export type TicketEvent = {
    kind: TicketEventKind;
    tenant_id: string;
    ticket_id: string;

    // ticket.created
    ticket_type?: string;
    subject?: string;
    category?: string;
    opener_display?: string;

    // ticket.message
    message_id?: string;
    author_kind?: string;
    author_display?: string;
    body?: string;
    origin?: string;

    // ticket.status
    status?: string;
};

const KINDS: ReadonlySet<string> = new Set<TicketEventKind>([
    "ticket.created",
    "ticket.message",
    "ticket.status",
]);

function optionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === "string";
}

/**
 * Parse the `data` field of one stream entry. Returns null for anything that
 * is not a valid TicketEvent; callers log a warning and still XACK (the
 * crates/bus precedent: a poison entry must never linger in the pending list).
 */
export function parseTicketEvent(raw: string): TicketEvent | null {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.kind !== "string" || !KINDS.has(obj.kind)) {
        return null;
    }
    if (typeof obj.tenant_id !== "string" || typeof obj.ticket_id !== "string") {
        return null;
    }
    const optionalFields = [
        "ticket_type",
        "subject",
        "category",
        "opener_display",
        "message_id",
        "author_kind",
        "author_display",
        "body",
        "origin",
        "status",
    ] as const;
    for (const field of optionalFields) {
        if (!optionalString(obj[field])) {
            return null;
        }
    }
    return obj as TicketEvent;
}
