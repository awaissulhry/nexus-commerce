/** FP1.3 — shared client types for the inbox workspace (mirror the API). */

export type ListItem = {
  id: string;
  subject: string | null;
  state: "OPEN" | "SNOOZED" | "CLOSED";
  snoozeUntil: string | null;
  followUpAt: string | null;
  lastMessageAt: string | null;
  party: { id: string; name: string; kind: string } | null;
  assignee: { id: string; displayName: string } | null;
  messages: { snippet: string | null; direction: "INBOUND" | "OUTBOUND"; fromAddress: string }[];
};

export type ListResponse = {
  items: ListItem[];
  nextCursor: string | null;
  counts: Record<string, number>;
  sync: { lastSyncAt: string | null; labelName: string | null; status: string } | null;
};

export type ThreadMessage = {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  fromAddress: string;
  snippet: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  sentAt: string;
  attachments: {
    id: string;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    driveFileId: string | null;
    webViewLink: string | null;
  }[];
};

export type ThreadComment = {
  id: string;
  body: string;
  createdAt: string;
  author: { displayName: string } | null;
};

export type ThreadEvent = {
  id: string;
  action: string;
  createdAt: string;
  after: Record<string, unknown> | null;
  actor: { displayName: string } | null;
};

export type ThreadConversation = {
  id: string;
  subject: string | null;
  state: "OPEN" | "SNOOZED" | "CLOSED";
  snoozeUntil: string | null;
  followUpAt: string | null;
  gmailThreadId: string | null;
  party:
    | {
        id: string;
        name: string;
        kind: string;
        notes: string | null;
        paymentTerms?: string | null; // grain-gated — may be absent
        emails: { email: string; matchDomain: boolean }[];
        priceList: { name: string } | null;
      }
    | null;
  assignee: { id: string; displayName: string } | null;
};

export type LinkedQuote = {
  id: string;
  number: string;
  state: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED";
  netCents: number;
  marginCents: number;
  convertedOrderId: string | null;
};

export type ThreadResponse = {
  conversation: ThreadConversation;
  messages: ThreadMessage[];
  comments: ThreadComment[];
  events: ThreadEvent[];
  quotes: LinkedQuote[];
};

export type UserLite = { id: string; displayName: string; email: string };

export const ago = (iso: string | null): string => {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export const EVENT_LABELS: Record<string, string> = {
  assigned: "assigned",
  "state.changed": "changed state",
  reopened: "reopened by a reply",
  unsnoozed: "woke from snooze",
  "followup.set": "set a follow-up",
  "followup.cleared": "cleared the follow-up",
  "followup.autocancelled": "follow-up auto-cancelled by a reply",
  replied: "replied",
  "party.linked": "linked a contact",
  "comment.created": "commented",
  "attachment.saved_to_drive": "saved an attachment to Drive",
};
