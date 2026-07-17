/**
 * FP9.2 → EPF1 — create an invoice from an order. EPF1 (D-02/D-03/D-05/D-17):
 * the amount defaults DEPOSIT-AWARE (net − payments received, floor 0) and is
 * capped so Σ invoices ≤ net (400 with the remaining invoiceable amount);
 * numbering is year-keyed (`INV-2026-001`) and minted + created + audited in
 * ONE transaction — a failure burns no number. The PDF renders AFTER commit;
 * if that fails the row stands with pdfRef=null and GET re-renders on demand.
 * VAT stays a display rate on the PDF only (FP9 is not accounting).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { publishEventDurable } from "@/lib/events";
import { nextNumberTx, type CounterStore } from "@/lib/counters";
import { orderTotals } from "@/lib/orders/money";
import { resolveInvoiceAmount } from "@/lib/financials/invoice-policy";
import { renderAndStoreInvoicePdf } from "@/lib/financials/invoice-pdf";
import { romeYear } from "@/lib/financials/rome-time";

export const permission = FEATURES.invoicesManage;

const Body = z.object({ orderId: z.string().min(1), netCents: z.number().int().positive().optional() });

export const POST = guarded(FEATURES.invoicesManage, async (req, { actor, resolved }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "orderId required" }, { status: 400 });

  const order = await prisma.order.findUnique({
    where: { id: parsed.data.orderId },
    select: {
      id: true,
      number: true,
      lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      payments: { select: { amountCents: true } },
      invoices: { select: { amountCents: true } },
    },
  });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.lines.length === 0) return NextResponse.json({ error: "Add a line to the order first" }, { status: 400 });

  const netCents = orderTotals(order.lines).netCents;
  const paidCents = order.payments.reduce((s, p) => s + (p.amountCents ?? 0), 0);
  const invoicedCents = order.invoices.reduce((s, i) => s + (i.amountCents ?? 0), 0);
  const amount = resolveInvoiceAmount(netCents, paidCents, invoicedCents, parsed.data.netCents);
  if (!amount.ok) {
    const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
    const error =
      amount.reason === "nothing-invoiceable"
        ? `Nothing left to invoice — ${eur(paidCents)} of ${eur(netCents)} is already received.`
        : `That would over-invoice ${order.number} — ${eur(amount.remainingInvoiceableCents)} remains invoiceable (Σ invoices ≤ order net).`;
    return NextResponse.json({ error, remainingInvoiceableCents: amount.remainingInvoiceableCents }, { status: 400 });
  }

  // ONE transaction: mint + create + audit — commit or burn nothing (D-05/D-17).
  // The audit write is IN the transaction: an unauditable money write rolls back.
  const year = romeYear(new Date().toISOString());
  const invoice = await prisma.$transaction(async (tx) => {
    const number = await nextNumberTx(tx as unknown as CounterStore, "invoice", year);
    const inv = await tx.invoice.create({
      data: { orderId: order.id, number, amountCents: amount.amountCents },
      select: { id: true, number: true, amountCents: true },
    });
    await tx.auditLog.create({
      data: { actorId: actor!.id, entityType: "invoice", entityId: inv.id, action: "created", after: { orderId: order.id, number, amountCents: amount.amountCents } },
    });
    return inv;
  });

  // derived output, after commit — failure leaves pdfRef null (GET repairs)
  await renderAndStoreInvoicePdf(invoice.id);

  await publishEventDurable("order.updated", { orderId: order.id });

  return jsonStripped({ ok: true, invoice }, resolved, { status: 201 });
});
