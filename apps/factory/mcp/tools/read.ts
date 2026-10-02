/**
 * P11 — the factory read tools (plan section 09 §5 outline 3): counters, orders, one order, quotes, production,
 * materials, shipments, the inbox, financials and analytics. Read only; every list is bounded (at most 50 rows, most
 * tools 25 by default) and pages with an offset cursor. Money fields keep their names (…Cents) so the door strips
 * every one the person may not see (src/lib/auth/strip-financials.ts): a WORKER's connection sees no money.
 *
 * Never: message bodies, attachments, e-mail addresses, VAT or tax numbers of customers, label files, payment
 * references. Mail threads are summaries (subject, who, when, a clipped snippet).
 */
import { z } from "zod/v4";
import { prisma } from "../../src/lib/db";
import { hasPermission } from "../../src/lib/auth/rbac";
import { FIELDS, PAGES } from "../../src/lib/auth/permissions";
import { loadAnalyticsDashboard } from "../../src/lib/analytics/dashboard";
import { loadMaterialStock } from "../../src/lib/materials/stock-list";
import { loadMonthMoney, loadOrderFinancials } from "../../src/lib/financials/load";
import { depositsOutstanding, periodRollup, romeMonthKey, tiles } from "../../src/lib/financials/rollup";
import { ToolRefusal, type FactoryTool } from "./types";

const DAY = 86_400_000;
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);
const clip = (text: string | null | undefined, cap = 200) => (text == null ? null : text.length > cap ? `${text.slice(0, cap - 1)}…` : text);

const paging = {
  limit: z.coerce.number().int().min(1).max(50).optional().describe("rows per page (default 25, at most 50)"),
  cursor: z.string().regex(/^\d{1,6}$/).optional().describe("nextCursor from the previous page, with the same filters"),
};
const offsetOf = (args: Record<string, unknown>) => Number(args.cursor ?? 0);
const sizeOf = (args: Record<string, unknown>) => Number(args.limit ?? 25);
/** One page of `take + 1` rows: the rows, and the cursor of the next page when there is one. */
function page<T>(rows: T[], args: Record<string, unknown>) {
  const size = sizeOf(args);
  const more = rows.length > size;
  return { items: rows.slice(0, size), nextCursor: more ? String(offsetOf(args) + size) : null };
}

// ── factory-overview ──────────────────────────────────────────────────────────────────────────────────

const overview: FactoryTool = {
  name: "factory-overview",
  title: "Factory overview",
  description:
    "Counters across the factory, each shown only when the person this connection acts as may open its page: orders "
    + "by state and late ones, quotes by state, work orders in progress and blocked, materials below their reorder "
    + "level, shipments on the way, open inbox threads. Read only.",
  readOnly: true,
  input: z.object({}),
  async run(_args, { resolved, now }) {
    const can = (page: string) => hasPermission(resolved, page);
    const out: Record<string, unknown> = {};
    if (can(PAGES.orders)) {
      const [byState, late] = await Promise.all([
        prisma.order.groupBy({ by: ["state"], _count: { _all: true } }),
        prisma.order.count({ where: { state: { in: ["CONFIRMED", "IN_PRODUCTION", "READY"] }, promiseDateAt: { lt: now } } }),
      ]);
      out.orders = { byState: Object.fromEntries(byState.map((g) => [g.state, g._count._all])), lateOpen: late };
    }
    if (can(PAGES.quotes)) {
      const byState = await prisma.quote.groupBy({ by: ["state"], _count: { _all: true } });
      out.quotes = { byState: Object.fromEntries(byState.map((g) => [g.state, g._count._all])) };
    }
    if (can(PAGES.production)) {
      const byState = await prisma.workOrder.groupBy({ by: ["state"], _count: { _all: true } });
      out.workOrders = { byState: Object.fromEntries(byState.map((g) => [g.state, g._count._all])) };
    }
    if (can(PAGES.materials)) {
      const stock = await loadMaterialStock({ includeArchived: false });
      out.materials = { total: stock.length, low: stock.filter((m) => m.low).length, short: stock.filter((m) => m.short).length };
    }
    if (can(PAGES.shipping)) {
      out.shipments = { inTransit: await prisma.shipment.count({ where: { state: { in: ["LABEL_PURCHASED", "IN_TRANSIT"] } } }), exceptions: await prisma.shipment.count({ where: { state: "EXCEPTION" } }) };
    }
    if (can(PAGES.inbox)) out.inbox = { open: await prisma.conversation.count({ where: { state: "OPEN" } }) };
    return out;
  },
};

// ── factory-orders / factory-order ────────────────────────────────────────────────────────────────────

const ORDER_STATES = ["CONFIRMED", "IN_PRODUCTION", "READY", "SHIPPED", "DELIVERED", "CLOSED", "CANCELLED"] as const;

const orders: FactoryTool = {
  name: "factory-orders",
  title: "Factory orders",
  description:
    "Factory orders, newest first: number, customer, state, promise date and whether it is late, urgent, lines and "
    + "pieces, and the order's net value (shown only to a person who may see prices). Filter by state, by a number or "
    + "customer name, or to late ones. Read only.",
  readOnly: true,
  input: z.object({
    state: z.enum(ORDER_STATES).optional().describe("only orders in this state"),
    search: z.string().trim().min(1).max(80).optional().describe("an order number, client reference or customer name, or part of one"),
    lateOnly: z.boolean().optional().describe("only open orders past their promise date"),
    ...paging,
  }),
  async run(args, { now }) {
    const search = args.search as string | undefined;
    const rows = await prisma.order.findMany({
      where: {
        ...(args.state ? { state: args.state as (typeof ORDER_STATES)[number] } : {}),
        ...(search ? { OR: [{ number: { contains: search } }, { clientRef: { contains: search } }, { party: { name: { contains: search } } }] } : {}),
        ...(args.lateOnly ? { state: { in: ["CONFIRMED", "IN_PRODUCTION", "READY"] }, promiseDateAt: { lt: now } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: offsetOf(args),
      take: sizeOf(args) + 1,
      select: {
        id: true, number: true, state: true, promiseDateAt: true, urgent: true, clientRef: true, createdAt: true,
        party: { select: { name: true } },
        lines: { select: { qty: true, netPriceCents: true } },
      },
    });
    const { items, nextCursor } = page(rows, args);
    return {
      orders: items.map((o) => ({
        id: o.id,
        number: o.number,
        customer: o.party.name,
        state: o.state,
        promiseDate: iso(o.promiseDateAt),
        late: !!o.promiseDateAt && o.promiseDateAt < now && ["CONFIRMED", "IN_PRODUCTION", "READY"].includes(o.state),
        urgent: o.urgent,
        clientRef: o.clientRef,
        lines: o.lines.length,
        pieces: o.lines.reduce((sum, l) => sum + l.qty, 0),
        netCents: o.lines.reduce((sum, l) => sum + l.qty * l.netPriceCents, 0),
        createdAt: iso(o.createdAt),
      })),
      nextCursor,
    };
  },
};

const order: FactoryTool = {
  name: "factory-order",
  title: "Factory order",
  description:
    "One factory order by its number or id: customer, state, promise dates, lines (with prices and costs only for a "
    + "person who may see them), its work orders and their stages, shipments and tracking, and the money taken and "
    + "invoiced (only for a person who may see prices). Read only.",
  readOnly: true,
  input: z.object({
    order: z.string().trim().min(1).max(64).describe("the order number (e.g. ORD-214) or its id"),
  }),
  async run(args, { now }) {
    const ref = String(args.order);
    const row = await prisma.order.findFirst({
      where: { OR: [{ id: ref }, { number: ref }] },
      select: {
        id: true, number: true, state: true, promiseDateAt: true, originalPromiseDateAt: true, urgent: true, clientRef: true,
        cancelReason: true, createdAt: true,
        party: { select: { name: true } },
        lines: { select: { description: true, qty: true, netPriceCents: true, costCents: true }, take: 50 },
        workOrders: {
          take: 50,
          select: {
            number: true, state: true, blockedReason: true, label: true,
            stages: { orderBy: { sort: "asc" }, select: { stage: true, startedAt: true, finishedAt: true, assignee: { select: { displayName: true } } } },
          },
        },
        shipments: { take: 20, select: { state: true, service: true, trackingNumber: true, trackingUrl: true, createdAt: true } },
        invoices: { take: 20, select: { number: true, amountCents: true, sentAt: true, paidAt: true } },
        payments: { take: 50, select: { kind: true, amountCents: true, receivedAt: true } },
      },
    });
    if (!row) throw new ToolRefusal("Order not found");
    return {
      id: row.id,
      number: row.number,
      customer: row.party.name,
      state: row.state,
      promiseDate: iso(row.promiseDateAt),
      originalPromiseDate: iso(row.originalPromiseDateAt),
      late: !!row.promiseDateAt && row.promiseDateAt < now && ["CONFIRMED", "IN_PRODUCTION", "READY"].includes(row.state),
      urgent: row.urgent,
      clientRef: row.clientRef,
      cancelReason: row.cancelReason,
      createdAt: iso(row.createdAt),
      lines: row.lines.map((l) => ({ description: l.description, qty: l.qty, netPriceCents: l.netPriceCents, costCents: l.costCents })),
      workOrders: row.workOrders.map((w) => ({
        number: w.number,
        label: w.label,
        state: w.state,
        blockedReason: w.blockedReason,
        stages: w.stages.map((s) => ({ stage: s.stage, startedAt: iso(s.startedAt), finishedAt: iso(s.finishedAt), assignee: s.assignee?.displayName ?? null })),
      })),
      shipments: row.shipments.map((s) => ({ state: s.state, service: s.service, trackingNumber: s.trackingNumber, trackingUrl: s.trackingUrl, createdAt: iso(s.createdAt) })),
      invoices: row.invoices.map((i) => ({ number: i.number, amountCents: i.amountCents, sentAt: iso(i.sentAt), paidAt: iso(i.paidAt) })),
      paidCents: row.payments.reduce((sum, p) => sum + p.amountCents, 0),
    };
  },
};

// ── factory-quotes ────────────────────────────────────────────────────────────────────────────────────

const QUOTE_STATES = ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"] as const;

const quotes: FactoryTool = {
  name: "factory-quotes",
  title: "Factory quotes",
  description:
    "The quote pipeline: how many quotes are in each state, then the quotes newest first with customer, state, how long "
    + "a sent one has waited, whether and when the customer viewed it, validity, the lost reason, and the value and "
    + "margin (only for a person who may see them). Filter by state. Read only.",
  readOnly: true,
  input: z.object({
    state: z.enum(QUOTE_STATES).optional().describe("only quotes in this state"),
    ...paging,
  }),
  async run(args, { now }) {
    const [byState, rows] = await Promise.all([
      prisma.quote.groupBy({ by: ["state"], _count: { _all: true } }),
      prisma.quote.findMany({
        where: args.state ? { state: args.state as (typeof QUOTE_STATES)[number] } : {},
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: offsetOf(args),
        take: sizeOf(args) + 1,
        select: {
          id: true, number: true, state: true, sentAt: true, validUntilAt: true, viewCount: true, lastViewedAt: true,
          lostReason: true, convertedOrderId: true, createdAt: true, party: { select: { name: true } },
          lines: { select: { qty: true, netPriceCents: true, marginCents: true } },
        },
      }),
    ]);
    const { items, nextCursor } = page(rows, args);
    return {
      byState: Object.fromEntries(byState.map((g) => [g.state, g._count._all])),
      quotes: items.map((q) => ({
        id: q.id,
        number: q.number,
        customer: q.party.name,
        state: q.state,
        sentAt: iso(q.sentAt),
        daysWaiting: q.state === "SENT" && q.sentAt ? Math.floor((now.getTime() - q.sentAt.getTime()) / DAY) : null,
        viewed: q.viewCount > 0,
        lastViewedAt: iso(q.lastViewedAt),
        validUntil: iso(q.validUntilAt),
        lostReason: q.lostReason,
        convertedToOrder: !!q.convertedOrderId,
        netCents: q.lines.reduce((sum, l) => sum + l.qty * l.netPriceCents, 0),
        marginCents: q.lines.reduce((sum, l) => sum + l.qty * l.marginCents, 0),
        createdAt: iso(q.createdAt),
      })),
      nextCursor,
    };
  },
};

// ── factory-production ────────────────────────────────────────────────────────────────────────────────

const production: FactoryTool = {
  name: "factory-production",
  title: "Factory production",
  description:
    "Work orders still to finish (ready, in progress, blocked), late ones first: their order and promise date, the "
    + "stage each is at and who works on it, why a blocked one is blocked; and how many work orders are in each state. "
    + "Read only.",
  readOnly: true,
  input: z.object({
    blockedOnly: z.boolean().optional().describe("only blocked work orders"),
    ...paging,
  }),
  async run(args, { now }) {
    const [byState, rows] = await Promise.all([
      prisma.workOrder.groupBy({ by: ["state"], _count: { _all: true } }),
      prisma.workOrder.findMany({
        where: { state: args.blockedOnly ? "BLOCKED" : { in: ["READY", "IN_PROGRESS", "BLOCKED"] } },
        orderBy: [{ order: { promiseDateAt: "asc" } }, { priority: "desc" }, { id: "asc" }],
        skip: offsetOf(args),
        take: sizeOf(args) + 1,
        select: {
          id: true, number: true, state: true, label: true, blockedReason: true, priority: true,
          order: { select: { number: true, promiseDateAt: true, urgent: true, party: { select: { name: true } } } },
          stages: { orderBy: { sort: "asc" }, select: { stage: true, startedAt: true, finishedAt: true, assignee: { select: { displayName: true } } } },
        },
      }),
    ]);
    const { items, nextCursor } = page(rows, args);
    return {
      byState: Object.fromEntries(byState.map((g) => [g.state, g._count._all])),
      workOrders: items.map((w) => {
        const current = w.stages.find((s) => !s.finishedAt) ?? null;
        return {
          id: w.id,
          number: w.number,
          label: w.label,
          state: w.state,
          blockedReason: w.blockedReason,
          order: w.order.number,
          customer: w.order.party.name,
          promiseDate: iso(w.order.promiseDateAt),
          late: !!w.order.promiseDateAt && w.order.promiseDateAt < now,
          urgent: w.order.urgent,
          stage: current ? { name: current.stage, started: !!current.startedAt, assignee: current.assignee?.displayName ?? null } : null,
          stagesDone: w.stages.filter((s) => s.finishedAt).length,
          stagesTotal: w.stages.length,
        };
      }),
      nextCursor,
    };
  },
};

// ── factory-materials ─────────────────────────────────────────────────────────────────────────────────

const materials: FactoryTool = {
  name: "factory-materials",
  title: "Factory materials",
  description:
    "Materials with their stock as the Materials page counts it: in stock, committed to work orders, expected on open "
    + "purchase orders, available, and whether it is below its reorder level or short; plus the latest stock movements. "
    + "The supplier cost only for a person who may see costs. Read only.",
  readOnly: true,
  input: z.object({
    lowOnly: z.boolean().optional().describe("only materials below their reorder level or short"),
    search: z.string().trim().min(1).max(80).optional().describe("a material name, or part of one"),
    ...paging,
  }),
  async run(args) {
    const search = (args.search as string | undefined)?.toLowerCase();
    const all = (await loadMaterialStock({ includeArchived: false }))
      .filter((m) => (!args.lowOnly || m.low || m.short) && (!search || m.name.toLowerCase().includes(search)));
    const offset = offsetOf(args);
    const { items, nextCursor } = page(all.slice(offset, offset + sizeOf(args) + 1), args);
    const movements = await prisma.movementLedger.findMany({
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { type: true, qty: true, reason: true, refType: true, createdAt: true, material: { select: { name: true, unit: true } } },
    });
    return {
      materials: items.map((m) => ({
        id: m.id, name: m.name, unit: m.unit, costCents: m.costCents, reorderLevel: m.reorderLevel,
        inStock: m.inStock, committed: m.committed, expected: m.expected, available: m.available, low: m.low, short: m.short,
      })),
      total: all.length,
      nextCursor,
      latestMovements: movements.map((mv) => ({ material: mv.material.name, unit: mv.material.unit, type: mv.type, qty: mv.qty, reason: clip(mv.reason, 120), ref: mv.refType, at: iso(mv.createdAt) })),
    };
  },
};

// ── factory-shipments ─────────────────────────────────────────────────────────────────────────────────

const SHIPMENT_STATES = ["CREATED", "LABEL_PURCHASED", "IN_TRANSIT", "DELIVERED", "EXCEPTION", "CANCELLED"] as const;

const shipments: FactoryTool = {
  name: "factory-shipments",
  title: "Factory shipments",
  description:
    "Shipments newest first: the order and customer, state, carrier service, tracking number and link, and the "
    + "shipping cost (only for a person who may see prices). Filter by state. Read only: buying or voiding labels stays "
    + "in the factory app.",
  readOnly: true,
  input: z.object({
    state: z.enum(SHIPMENT_STATES).optional().describe("only shipments in this state"),
    ...paging,
  }),
  async run(args) {
    const rows = await prisma.shipment.findMany({
      where: args.state ? { state: args.state as (typeof SHIPMENT_STATES)[number] } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: offsetOf(args),
      take: sizeOf(args) + 1,
      select: {
        id: true, state: true, service: true, trackingNumber: true, trackingUrl: true, costCents: true, createdAt: true, updatedAt: true,
        order: { select: { number: true, party: { select: { name: true } } } },
      },
    });
    const { items, nextCursor } = page(rows, args);
    return {
      shipments: items.map((s) => ({
        id: s.id, order: s.order.number, customer: s.order.party.name, state: s.state, service: s.service,
        trackingNumber: s.trackingNumber, trackingUrl: s.trackingUrl, costCents: s.costCents, createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt),
      })),
      nextCursor,
    };
  },
};

// ── factory-inbox ─────────────────────────────────────────────────────────────────────────────────────

const inbox: FactoryTool = {
  name: "factory-inbox",
  title: "Factory inbox",
  description:
    "Mail threads, most recent first: subject, customer or supplier, state, who it is assigned to, when the last "
    + "message came and from which side, and a short snippet. Summaries only — no message bodies, attachments or "
    + "e-mail addresses. Read only: answering stays in the factory app.",
  readOnly: true,
  input: z.object({
    state: z.enum(["OPEN", "SNOOZED", "CLOSED"]).optional().describe("only threads in this state (default open)"),
    ...paging,
  }),
  async run(args) {
    const rows = await prisma.conversation.findMany({
      where: { state: (args.state as "OPEN" | "SNOOZED" | "CLOSED" | undefined) ?? "OPEN" },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      skip: offsetOf(args),
      take: sizeOf(args) + 1,
      select: {
        id: true, subject: true, state: true, lastMessageAt: true, lastMessageDirection: true, followUpAt: true, snoozeUntil: true,
        party: { select: { name: true, kind: true } },
        assignee: { select: { displayName: true } },
        messages: { orderBy: { sentAt: "desc" }, take: 1, select: { snippet: true } },
      },
    });
    const { items, nextCursor } = page(rows, args);
    return {
      threads: items.map((c) => ({
        id: c.id,
        subject: clip(c.subject, 160),
        with: c.party ? { name: c.party.name, kind: c.party.kind } : null,
        state: c.state,
        assignee: c.assignee?.displayName ?? null,
        lastMessageAt: iso(c.lastMessageAt),
        lastFrom: c.lastMessageDirection,
        followUpAt: iso(c.followUpAt),
        snoozedUntil: iso(c.snoozeUntil),
        snippet: clip(c.messages[0]?.snippet?.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]"), 200),
      })),
      nextCursor,
    };
  },
};

// ── factory-financials ────────────────────────────────────────────────────────────────────────────────

const financials: FactoryTool = {
  name: "factory-financials",
  title: "Factory financials",
  description:
    "The money of the factory, as the Financials page folds it: outstanding, deposits due, invoiced and paid this "
    + "month; deposits still to collect (largest first); and month by month the orders, net value, invoiced, paid, "
    + "outstanding and actual margin. Needs permission to see all money. Read only: invoices and payments stay in the "
    + "factory app.",
  readOnly: true,
  input: z.object({
    months: z.coerce.number().int().min(1).max(24).optional().describe("how many months back the month-by-month table goes (default 6)"),
  }),
  async run(args, { resolved, now }) {
    // The door checked financials.view; this read is money top to bottom.
    if (!hasPermission(resolved, FIELDS.financialsView)) throw new ToolRefusal("factory-financials needs permission to see all money.");
    const fins = await loadOrderFinancials(undefined, { sorted: false, docDates: true });
    const month = await loadMonthMoney(romeMonthKey(now.toISOString()));
    const months = Number(args.months ?? 6);
    return {
      tiles: tiles(fins, month),
      depositsToCollect: depositsOutstanding(fins).sort((a, b) => b.shortfallCents - a.shortfallCents).slice(0, 20),
      byMonth: periodRollup(fins).sort((a, b) => b.monthKey.localeCompare(a.monthKey)).slice(0, months),
    };
  },
};

// ── factory-analytics ─────────────────────────────────────────────────────────────────────────────────

const analytics: FactoryTool = {
  name: "factory-analytics",
  title: "Factory analytics",
  description:
    "The analytics the factory's Analytics page shows, over a recent window (default 90 days): work orders finished "
    + "per week, how long each stage takes and which one is the bottleneck, the on-time rate of shipped orders, quote "
    + "win/loss and why, and the margin by customer, month and product (margins only for a person who may see them). "
    + "Read only.",
  readOnly: true,
  input: z.object({
    days: z.coerce.number().int().min(7).max(730).optional().describe("the window in days (default 90)"),
  }),
  async run(args, { now }) {
    const days = Number(args.days ?? 90);
    const data = await loadAnalyticsDashboard({ gte: new Date(now.getTime() - days * DAY), lte: now });
    return {
      days,
      ...data,
      marginByParty: data.marginByParty.slice(0, 20),
      marginByProduct: (data.marginByProduct as unknown[]).slice(0, 20),
    };
  },
};

export const READ_TOOLS: FactoryTool[] = [overview, orders, order, quotes, production, materials, shipments, inbox, financials, analytics];
