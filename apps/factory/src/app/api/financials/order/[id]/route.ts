/**
 * FP9.2 — one order's money detail for the drawer: the rollup plus its invoices
 * and payments, so the Owner can invoice, send, and mark paid without leaving the
 * financials page. Money grain-stripped.
 */
import { NextResponse } from "next/server";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { orderFinancials, type FinOrder } from "@/lib/financials/rollup";
import { actualCostByOrder } from "@/lib/financials/actual-cost";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (_req, { params, resolved }) => {
  const { id } = await params;
  // EPF2 (P2: VAT/gross never visible on-screen) — the drawer renders a
  // display-only VAT line from the configured rate; still not accounting.
  const vatRowP = prisma.appSetting.findUnique({ where: { key: "financials.defaults" } });
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true, number: true, state: true, createdAt: true,
      party: { select: { id: true, name: true } },
      lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      payments: { select: { id: true, kind: true, amountCents: true, method: true, receivedAt: true, notes: true }, orderBy: { receivedAt: "asc" } },
      invoices: { select: { id: true, number: true, amountCents: true, sentAt: true, paidAt: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      bornFromQuote: { select: { depositPct: true } },
      workOrders: { select: { id: true, state: true } },
    },
  });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const actual = await actualCostByOrder([{ id: order.id, woIds: order.workOrders.map((w) => w.id) }]);
  const rollup = orderFinancials({
    id: order.id, number: order.number, partyId: order.party.id, partyName: order.party.name, state: order.state, createdAtISO: order.createdAt.toISOString(),
    lines: order.lines,
    // EPF1 (D-13/D-14): document dates feed the Rome-month buckets; WO states
    // drive actualIsPending — the drawer agrees with tiles by construction.
    payments: order.payments.map((p) => ({ kind: p.kind, amountCents: p.amountCents, receivedAtISO: p.receivedAt.toISOString() })),
    invoices: order.invoices.map((i) => ({ amountCents: i.amountCents, paidAt: i.paidAt ? i.paidAt.toISOString() : null, issuedAtISO: i.createdAt.toISOString(), number: i.number })),
    depositPct: order.bornFromQuote?.depositPct,
    actualCostCents: actual.get(order.id) ?? null,
    actualComplete: order.workOrders.length > 0 && order.workOrders.every((w) => w.state === "DONE"),
  } satisfies FinOrder);

  const vatRatePct = ((await vatRowP)?.value as { vatRatePct?: number } | null)?.vatRatePct ?? 22;
  return jsonStripped({ order: { id: order.id, number: order.number, partyName: order.party.name }, rollup, invoices: order.invoices, payments: order.payments, vatRatePct }, resolved);
});
