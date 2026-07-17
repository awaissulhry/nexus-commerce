/**
 * FP4 → EPO.3 — the ONE-TIMELINE: the whole life of a job in one chronological
 * thread, assembled from the linked records + the audit log. Pure read, no
 * writes. EPO.3 made it the NetSuite "created-from chain, extended to the
 * email" for real (C5/E2): every kind now carries its hop-link where a target
 * exists, transitions name their driver and carry the cancel reason, and the
 * thread gained invoices, promise changes, and stage completions.
 *
 * Money lives ONLY in `amountCents` (grain-stripped at the route edge) — never
 * interpolate a value into `label`, or it would leak past the strip.
 */
import { ORDER_STATE_LABEL, type OrderState, type TransitionVia } from "./transitions";

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
    | "review"
    | "invoice" // EPO.3
    | "promise" // EPO.3
    | "stage"; // EPO.3
  at: string; // ISO
  label: string;
  amountCents?: number;
  href?: string;
};

type DateLike = Date | string;
const iso = (d: DateLike): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const day = (d: DateLike): string => new Date(d).toLocaleDateString("en-GB"); // fixed locale — SSR parity

const PAYMENT_LABEL: Record<string, string> = { DEPOSIT: "Deposit recorded", BALANCE: "Balance recorded", OTHER: "Payment recorded" };

/** how a system driver reads on the thread (manual/cancel/reopen say nothing extra) */
const VIA_LABEL: Partial<Record<TransitionVia, string>> = {
  "start-production": "production started",
  "all-wos-done": "production complete",
  "label-purchased": "label bought",
  tracking: "carrier tracking",
  "label-voided": "label voided",
};

const titlecase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** stage completions stay readable: per-stage rows for small orders, per-WO roll-ups for big size-runs */
export const STAGE_DETAIL_MAX_WOS = 5;

export type TimelineOrder = {
  number: string;
  createdAt: DateLike;
  party?: { id: string } | null;
  conversation?: { id: string; subject: string | null; createdAt: DateLike } | null;
  bornFromQuote?: { id: string; number: string; createdAt: DateLike; sentAt: DateLike | null } | null;
  payments: { kind: string; amountCents: number; receivedAt: DateLike }[];
  workOrders: {
    id?: string;
    number: string;
    createdAt: DateLike;
    state: string;
    blockedReason: string | null;
    stages?: { stage: string; finishedAt?: DateLike | null }[];
  }[];
  shipments?: { id: string; trackingNumber?: string | null; service?: string | null; costCents?: number | null; createdAt: DateLike }[];
  invoices?: { id: string; number: string; amountCents?: number | null; sentAt?: DateLike | null; paidAt?: DateLike | null; createdAt: DateLike }[];
  reviews?: { id: string; createdAt: DateLike }[];
};

export type AuditRow = { entityType: string; action: string; after: unknown; createdAt: DateLike };

export function buildTimeline(order: TimelineOrder, audits: AuditRow[] = []): TimelineEvent[] {
  const ev: TimelineEvent[] = [];
  const partyHref = order.party ? `/contacts?c=${order.party.id}` : undefined;

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
    if (a.entityType === "quote" && a.action === "accepted") {
      ev.push({ kind: "quote-accepted", at: iso(a.createdAt), label: "Quote accepted by customer", href: order.bornFromQuote ? `/quotes?q=${order.bornFromQuote.id}` : undefined });
    }
  }

  ev.push({ kind: "order", at: iso(order.createdAt), label: `Order ${order.number} confirmed` });

  for (const p of order.payments) {
    // page-level Financials hop until EPF ships its ?o= reader (D-1)
    ev.push({ kind: "payment", at: iso(p.receivedAt), label: PAYMENT_LABEL[p.kind] ?? PAYMENT_LABEL.OTHER, amountCents: p.amountCents, href: "/financials" });
  }
  for (const wo of order.workOrders) {
    const blocked = wo.state === "BLOCKED" ? ` · blocked: ${wo.blockedReason ?? "awaiting deposit"}` : "";
    const href = wo.id ? `/production?wo=${wo.id}` : undefined;
    ev.push({ kind: "workorder", at: iso(wo.createdAt), label: `Work order ${wo.number} created${blocked}`, href });
  }
  // EPO.3 — stage completions: readable depth for the common case, roll-ups for size-runs
  const withStages = order.workOrders.filter((w) => (w.stages ?? []).length > 0);
  if (withStages.length > 0 && order.workOrders.length <= STAGE_DETAIL_MAX_WOS) {
    for (const wo of withStages) {
      for (const s of wo.stages ?? []) {
        if (s.finishedAt) ev.push({ kind: "stage", at: iso(s.finishedAt), label: `${wo.number} · ${titlecase(s.stage)} finished`, href: wo.id ? `/production?wo=${wo.id}` : undefined });
      }
    }
  } else {
    for (const wo of withStages) {
      if (wo.state !== "DONE") continue;
      const finished = (wo.stages ?? []).map((s) => s.finishedAt).filter(Boolean) as DateLike[];
      if (finished.length === 0) continue;
      const last = finished.map(iso).sort().at(-1)!;
      ev.push({ kind: "stage", at: last, label: `Work order ${wo.number} completed`, href: wo.id ? `/production?wo=${wo.id}` : undefined });
    }
  }
  for (const s of order.shipments ?? []) {
    const via = s.service ? ` · ${s.service}` : "";
    // page-level Shipping hop — the shipment drawer has no deep-link yet (EPS)
    ev.push({ kind: "shipment", at: iso(s.createdAt), label: `Label bought${s.trackingNumber ? ` — ${s.trackingNumber}` : ""}${via}`, amountCents: s.costCents ?? undefined, href: "/shipping" });
  }
  // EPO.3 — invoices join the thread (issued / paid as separate moments)
  for (const inv of order.invoices ?? []) {
    ev.push({ kind: "invoice", at: iso(inv.createdAt), label: `Invoice ${inv.number} issued`, amountCents: inv.amountCents ?? undefined, href: "/financials" });
    if (inv.paidAt) ev.push({ kind: "invoice", at: iso(inv.paidAt), label: `Invoice ${inv.number} paid`, amountCents: inv.amountCents ?? undefined, href: "/financials" });
  }
  for (const r of order.reviews ?? []) {
    ev.push({ kind: "review", at: iso(r.createdAt), label: "Review received", href: partyHref });
  }
  // order state transitions from the audit trail — now with driver + cancel reason
  for (const a of audits) {
    if (a.entityType === "order" && a.action === "state-changed") {
      const after = (a.after as { to?: OrderState; via?: TransitionVia; reason?: string } | null) ?? {};
      const to = after.to;
      // plain CONFIRMED rows duplicate the "order confirmed" entry — but a
      // reopen (CANCELLED→CONFIRMED, via on the EPO.1 audit) is its own moment
      if (!to || (to === "CONFIRMED" && after.via !== "reopen")) continue;
      if (to === "CONFIRMED") {
        ev.push({ kind: "transition", at: iso(a.createdAt), label: "→ Reopened" });
        continue;
      }
      const viaNote = after.via && VIA_LABEL[after.via] ? ` · ${VIA_LABEL[after.via]}` : "";
      const reason = to === "CANCELLED" && after.reason ? ` — ${after.reason}` : "";
      ev.push({ kind: "transition", at: iso(a.createdAt), label: `→ ${ORDER_STATE_LABEL[to] ?? to}${viaNote}${reason}` });
    }
    // EPO.3 — promise changes were audited but invisible here
    if (a.entityType === "order" && a.action === "promise-changed") {
      const p = (a.after as { promiseDateAt?: string | null } | null)?.promiseDateAt;
      ev.push({ kind: "promise", at: iso(a.createdAt), label: p ? `Promise date → ${day(p)}` : "Promise date cleared" });
    }
  }

  return ev.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
