import { describe, expect, it } from "vitest";
import { parseTicketEvent } from "./events.js";

describe("parseTicketEvent", () => {
    it("parses a ticket.created event with its per-kind fields", () => {
        const event = parseTicketEvent(
            JSON.stringify({
                kind: "ticket.created",
                tenant_id: "t-1",
                ticket_id: "0197a6a4-0000-7000-8000-000000000001",
                ticket_type: "ban_appeal",
                subject: "Appeal my ban",
                category: "bans",
                opener_display: "PlayerOne",
            }),
        );
        expect(event).not.toBeNull();
        expect(event?.kind).toBe("ticket.created");
        expect(event?.tenant_id).toBe("t-1");
        expect(event?.subject).toBe("Appeal my ban");
        expect(event?.opener_display).toBe("PlayerOne");
    });

    it("parses a ticket.message event", () => {
        const event = parseTicketEvent(
            JSON.stringify({
                kind: "ticket.message",
                tenant_id: "t-1",
                ticket_id: "0197a6a4-0000-7000-8000-000000000001",
                message_id: "0197a6a4-0000-7000-8000-000000000002",
                author_kind: "staff",
                author_display: "Admin",
                body: "We are looking into it.",
                origin: "web",
            }),
        );
        expect(event?.kind).toBe("ticket.message");
        expect(event?.message_id).toBe("0197a6a4-0000-7000-8000-000000000002");
        expect(event?.body).toBe("We are looking into it.");
    });

    it("parses a ticket.status event", () => {
        const event = parseTicketEvent(
            JSON.stringify({
                kind: "ticket.status",
                tenant_id: "t-1",
                ticket_id: "0197a6a4-0000-7000-8000-000000000001",
                status: "resolved",
            }),
        );
        expect(event?.kind).toBe("ticket.status");
        expect(event?.status).toBe("resolved");
    });

    it("accepts absent optional fields (producer skips nulls)", () => {
        const event = parseTicketEvent(
            JSON.stringify({
                kind: "ticket.created",
                tenant_id: "t-1",
                ticket_id: "0197a6a4-0000-7000-8000-000000000001",
            }),
        );
        expect(event).not.toBeNull();
        expect(event?.subject).toBeUndefined();
        expect(event?.category).toBeUndefined();
    });

    it("rejects garbage payloads", () => {
        expect(parseTicketEvent("not json at all")).toBeNull();
        expect(parseTicketEvent("42")).toBeNull();
        expect(parseTicketEvent("null")).toBeNull();
        expect(parseTicketEvent("[]")).toBeNull();
        expect(parseTicketEvent("{}")).toBeNull();
    });

    it("rejects an unknown kind", () => {
        expect(
            parseTicketEvent(
                JSON.stringify({ kind: "ticket.exploded", tenant_id: "t", ticket_id: "x" }),
            ),
        ).toBeNull();
    });

    it("rejects missing or non-string identifiers", () => {
        expect(
            parseTicketEvent(JSON.stringify({ kind: "ticket.status", ticket_id: "x" })),
        ).toBeNull();
        expect(
            parseTicketEvent(
                JSON.stringify({ kind: "ticket.status", tenant_id: 7, ticket_id: "x" }),
            ),
        ).toBeNull();
    });

    it("rejects wrongly typed optional fields", () => {
        expect(
            parseTicketEvent(
                JSON.stringify({
                    kind: "ticket.message",
                    tenant_id: "t-1",
                    ticket_id: "x",
                    body: { nested: true },
                }),
            ),
        ).toBeNull();
    });
});
