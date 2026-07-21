// Shared ticket types and badge styles for the operator surface (list + detail).
// Field names pinned to the tenant tickets contract (decision R).

export type Ticket = {
  id: string;
  type: string;
  status: string;
  category: string | null;
  subject: string;
  player_account_id: string | null;
  ban_id: string | null;
  assignee_user_id: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
};

export const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;

export const STATUS_STYLES: Record<string, string> = {
  open: "bg-green-900 text-green-300",
  pending: "bg-yellow-900 text-yellow-300",
  resolved: "bg-neutral-800 text-neutral-300",
  closed: "bg-neutral-800 text-neutral-500",
};

export const TYPE_STYLES: Record<string, string> = {
  general: "bg-neutral-800 text-neutral-300",
  ban_appeal: "bg-red-950 text-red-300",
};

export function typeLabel(type: string): string {
  return type === "ban_appeal" ? "ban appeal" : type;
}
