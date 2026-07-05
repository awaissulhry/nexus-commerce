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
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true, number: true, state: true, createdAt: true,
      party: { select: { id: true, name: true } },
      lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      payments: { select: { id: true, kind: true, amountCents: true, method: true, receivedAt: true, notes: true }, orderBy: { receivedAt: "asc" } },
      invoices: { select: { id: true, number: true, amountCents: true, sentAt: true, paidAt: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      bornFromQuote: { select: { depositPct: true } },
      workOrders: { select: { id: true } },
    },
  });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const actual = await actualCostByOrder([{ id: order.id, woIds: order.workOrders.map((w) => w.id) }]);
  const rollup = orderFinancials({
    id: order.id, number: order.number, partyId: order.party.id, partyName: order.party.name, state: order.state, createdAtISO: order.createdAt.toISOString(),
    lines: order.lines,
    payments: order.payments,
    invoices: order.invoices.map((i) => ({ amountCents: i.amountCents, paidAt: i.paidAt ? i.paidAt.toISOString() : null })),
    depositPct: order.bornFromQuote?.depositPct,
    actualCostCents: actual.get(order.id) ?? null,
  } satisfies FinOrder);

  return jsonStripped({ order: { id: order.id, number: order.number, partyName: order.party.name }, rollup, invoices: order.invoices, payments: order.payments }, resolved);
});
