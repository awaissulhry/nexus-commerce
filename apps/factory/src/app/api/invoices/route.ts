/**
 * FP9.2 — create an invoice from an order: next INV-n, a stored Italian Fattura
 * PDF (cost-free by construction), amount defaulting to the order's net total.
 * VAT is a display rate on the PDF only — the money model stays net (FP9 is not
 * accounting). The PDF lives locally beside the DB ($0 infra).
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { nextNumber } from "@/lib/counters";
import { orderTotals } from "@/lib/orders/money";
import { renderInvoicePdf } from "@/lib/financials/render-invoice";

export const permission = FEATURES.invoicesManage;

const Body = z.object({ orderId: z.string().min(1), netCents: z.number().int().positive().optional() });

export const POST = guarded(FEATURES.invoicesManage, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "orderId required" }, { status: 400 });

  const order = await prisma.order.findUnique({
    where: { id: parsed.data.orderId },
    select: { id: true, number: true, party: { select: { name: true } }, lines: { select: { description: true, qty: true, netPriceCents: true, costCents: true } } },
  });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.lines.length === 0) return NextResponse.json({ error: "Add a line to the order first" }, { status: 400 });

  const amountCents = parsed.data.netCents ?? orderTotals(order.lines).netCents;
  if (amountCents <= 0) return NextResponse.json({ error: "Invoice amount must be positive" }, { status: 400 });

  const vatRow = await prisma.appSetting.findUnique({ where: { key: "financials.defaults" } });
  const vatRatePct = (vatRow?.value as { vatRatePct?: number } | null)?.vatRatePct ?? 22;
  const nameRow = await prisma.appSetting.findUnique({ where: { key: "factory.name" } });
  const factoryName = (nameRow?.value as { name?: string })?.name ?? "Nexus Factory";

  const number = await nextNumber("invoice");
  const pdf = await renderInvoicePdf(
    { number, dateISO: new Date().toISOString(), orderNumber: order.number, partyName: order.party.name, lines: order.lines.map((l) => ({ description: l.description, qty: l.qty, netUnitCents: l.netPriceCents })), netCents: amountCents, vatRatePct },
    factoryName,
  );
  const dir = path.join(process.cwd(), "data", "invoices");
  fs.mkdirSync(dir, { recursive: true });
  const invoice = await prisma.invoice.create({ data: { orderId: order.id, number, amountCents }, select: { id: true, number: true, amountCents: true } });
  const pdfPath = path.join(dir, `${invoice.id}.pdf`);
  fs.writeFileSync(pdfPath, pdf);
  await prisma.invoice.update({ where: { id: invoice.id }, data: { pdfRef: pdfPath } });

  void audit({ actorId: actor!.id, entityType: "invoice", entityId: invoice.id, action: "created", after: { orderId: order.id, number, amountCents } });
  await publishEventDurable("order.updated", { orderId: order.id });

  return NextResponse.json({ ok: true, invoice }, { status: 201 });
});
