-- Phase 6 PR5: thread-to-ticket resolution for the Discord relay
-- (GET /internal/tickets/by-thread/{thread_id}). The bot resolves an incoming Discord
-- reply to its ticket by thread id on every relayed message, so the lookup must not
-- scan tickets. Partial: only synced tickets carry a thread id.
CREATE INDEX ix_tickets_tenant_thread ON tickets (tenant_id, discord_thread_id)
    WHERE discord_thread_id IS NOT NULL;
