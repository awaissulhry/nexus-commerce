/**
 * FP9.2 → EPF1 — one invoice: GET streams its Fattura PDF, RE-RENDERING it on
 * demand when missing (the D-05 repair path — the row is the truth, the PDF is
 * derived). PATCH marks it sent or paid. EPF1 (D-02/D-03/D-17): mark-paid
 * guards Σ payments + amount ≤ order net (409 `{overpayCents}` unless
 * `allowOverpay: true`), then updates + records the BALANCE payment + audits
 * in ONE transaction, and bells the Owner (`invoice.paid`, cross-review M3).
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { orderTotals, overpayCents } from "@/lib/orders/money";
import { renderAndStoreInvoicePdf } from "@/lib/financials/invoice-pdf";
import { invoicePaidNotice } from "@/lib/financials/notify-money";
import { notifyOwners } from "@/lib/quotes/notify-owners";

export const permission = { GET: PAGES.financials, PATCH: FEATURES.invoicesManage };

export const GET = guarded(PAGES.financials, async (_req, { params }) => {
  const { id } = await params;
  const inv = await prisma.invoice.findUnique({ where: { id }, select: { pdfRef: true, number: true } });
  if (!inv) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let pdfPath = inv.pdfRef && fs.existsSync(inv.pdfRef) ? inv.pdfRef : null;
  if (!pdfPath) pdfPath = await renderAndStoreInvoicePdf(id); // EPF1 repair path
  if (!pdfPath) return NextResponse.json({ error: "The PDF could not be rendered — try again" }, { status: 500 });

  return new NextResponse(new Uint8Array(fs.readFileSync(pdfPath)), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${inv.number}.pdf"`, "Cache-Control": "private, no-store" },
  });
});

const Patch = z.object({ action: z.enum(["send", "paid"]), allowOverpay: z.boolean().optional() });

export const PATCH = guarded(FEATURES.invoicesManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "action must be send or paid" }, { status: 400 });

  const inv = await prisma.invoice.findUnique({ where: { id }, select: { id: true, orderId: true, number: true, amountCents: true, sentAt: true, paidAt: true } });
  if (!inv) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.action === "send") {
    if (inv.sentAt) return NextResponse.json({ error: "Already sent" }, { status: 400 });
    await prisma.invoice.update({ where: { id }, data: { sentAt: new Date() } });
    await audit({ actorId: actor!.id, entityType: "invoice", entityId: id, action: "sent" });
  } else {
    if (inv.paidAt) return NextResponse.json({ error: "Already marked paid" }, { status: 400 });

    // EPF1 (D-02/D-03): a deposit-holding order must zero out, never go negative
    const order = await prisma.order.findUnique({
      where: { id: inv.orderId },
      select: { number: true, lines: { select: { netPriceCents: true, costCents: true, qty: true } }, payments: { select: { amountCents: true } } },
    });
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    const netCents = orderTotals(order.lines).netCents;
    const paidCents = order.payments.reduce((s, p) => s + (p.amountCents ?? 0), 0);
    const over = overpayCents(netCents, paidCents, inv.amountCents);
    if (over > 0 && !parsed.data.allowOverpay) {
      return NextResponse.json(
        { error: `Marking ${inv.number} paid would overpay ${order.number} by €${(over / 100).toFixed(2)} — the order already holds €${(paidCents / 100).toFixed(2)} of €${(netCents / 100).toFixed(2)}.`, overpayCents: over },
        { status: 409 },
      );
    }

    // ONE transaction: flag + payment + audits (awaited — an unauditable money write rolls back)
    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({ where: { id }, data: { paidAt: new Date() } });
      const pay = await tx.payment.create({
        data: { orderId: inv.orderId, kind: "BALANCE", amountCents: inv.amountCents, method: "invoice", notes: `Fattura ${inv.number}` },
        select: { id: true },
      });
      await tx.auditLog.create({ data: { actorId: actor!.id, entityType: "invoice", entityId: id, action: "paid", after: { amountCents: inv.amountCents, overpayCents: over > 0 ? over : undefined } } });
      await tx.auditLog.create({ data: { actorId: actor!.id, entityType: "order", entityId: inv.orderId, action: "payment-recorded", after: { kind: "BALANCE", via: "invoice", paymentId: pay.id, amountCents: inv.amountCents } } });
    });
    await notifyOwners(invoicePaidNotice({ orderId: inv.orderId, invoiceId: id, invoiceNumber: inv.number, amountCents: inv.amountCents }));
    await publishEventDurable("payment.recorded", { orderId: inv.orderId });
  }
  await publishEventDurable("order.updated", { orderId: inv.orderId });
  return NextResponse.json({ ok: true });
});
