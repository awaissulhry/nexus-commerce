/**
 * FP4 — the ONE-TIMELINE: the whole life of a job in one chronological thread,
 * assembled from the linked records + the audit log. Pure read, no writes.
 *
 * Money lives ONLY in `amountCents` (grain-stripped at the route edge) — never
 * interpolate a value into `label`, or it would leak past the strip.
 */
import { ORDER_STATE_LABEL, type OrderState } from "./transitions";

export type TimelineEvent = {
  kind:
    | "email"
    | "quote"
    | "quote-sent"
    | "quote-accepted"
    | "order"
    | "payment"
    | "workorder"
    | "transition"
    | "shipment"
    | "review";
  at: string; // ISO
  label: string;
  amountCents?: number;
  href?: string;
};

type DateLike = Date | string;
const iso = (d: DateLike): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

const PAYMENT_LABEL: Record<string, string> = { DEPOSIT: "Deposit recorded", BALANCE: "Balance recorded", OTHER: "Payment recorded" };

export type TimelineOrder = {
  number: string;
  createdAt: DateLike;
  conversation?: { id: string; subject: string | null; createdAt: DateLike } | null;
  bornFromQuote?: { id: string; number: string; createdAt: DateLike; sentAt: DateLike | null } | null;
  payments: { kind: string; amountCents: number; receivedAt: DateLike }[];
  workOrders: { number: string; createdAt: DateLike; state: string; blockedReason: string | null }[];
  shipments?: { id: string; trackingCode?: string | null; createdAt: DateLike }[];
  reviews?: { id: string; createdAt: DateLike }[];
};

export type AuditRow = { entityType: string; action: string; after: unknown; createdAt: DateLike };

export function buildTimeline(order: TimelineOrder, audits: AuditRow[] = []): TimelineEvent[] {
  const ev: TimelineEvent[] = [];

  if (order.conversation) {
    ev.push({ kind: "email", at: iso(order.conversation.createdAt), label: `Email — ${order.conversation.subject ?? "thread"}`, href: `/inbox?focus=${order.conversation.id}` });
  }
  if (order.bornFromQuote) {
    const q = order.bornFromQuote;
    ev.push({ kind: "quote", at: iso(q.createdAt), label: `Quote ${q.number} drafted`, href: `/quotes?q=${q.id}` });
    if (q.sentAt) ev.push({ kind: "quote-sent", at: iso(q.sentAt), label: `Quote ${q.number} sent`, href: `/quotes?q=${q.id}` });
  }
  // quote accepted — timestamp only exists in the audit trail
  for (const a of audits) {
    if (a.entityType === "quote" && a.action === "accepted") ev.push({ kind: "quote-accepted", at: iso(a.createdAt), label: "Quote accepted by customer" });
  }

  ev.push({ kind: "order", at: iso(order.createdAt), label: `Order ${order.number} confirmed` });

  for (const p of order.payments) {
    ev.push({ kind: "payment", at: iso(p.receivedAt), label: PAYMENT_LABEL[p.kind] ?? PAYMENT_LABEL.OTHER, amountCents: p.amountCents });
  }
  for (const wo of order.workOrders) {
    const blocked = wo.state === "BLOCKED" ? ` · blocked: ${wo.blockedReason ?? "awaiting deposit"}` : "";
    ev.push({ kind: "workorder", at: iso(wo.createdAt), label: `Work order ${wo.number} created${blocked}` });
  }
  for (const s of order.shipments ?? []) {
    ev.push({ kind: "shipment", at: iso(s.createdAt), label: `Shipment${s.trackingCode ? ` ${s.trackingCode}` : ""}` });
  }
  for (const r of order.reviews ?? []) {
    ev.push({ kind: "review", at: iso(r.createdAt), label: "Review received" });
  }
  // order state transitions from the audit trail (the WO-unblock + lifecycle moves)
  for (const a of audits) {
    if (a.entityType === "order" && a.action === "state-changed") {
      const to = (a.after as { to?: OrderState } | null)?.to;
      if (to && to !== "CONFIRMED") ev.push({ kind: "transition", at: iso(a.createdAt), label: `→ ${ORDER_STATE_LABEL[to] ?? to}` });
    }
  }

  return ev.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
