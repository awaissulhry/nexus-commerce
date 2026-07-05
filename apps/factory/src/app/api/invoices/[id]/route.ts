/**
 * FP9.2 — one invoice: GET streams its stored Fattura PDF; PATCH marks it sent or
 * paid. Marking paid drops a BALANCE payment for the invoice's net amount, so the
 * order's balance zeroes (the money model is net; IVA was display-only on the PDF).
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";

export const permission = { GET: PAGES.financials, PATCH: FEATURES.invoicesManage };

export const GET = guarded(PAGES.financials, async (_req, { params }) => {
  const { id } = await params;
  const inv = await prisma.invoice.findUnique({ where: { id }, select: { pdfRef: true, number: true } });
  if (!inv?.pdfRef || !fs.existsSync(inv.pdfRef)) return NextResponse.json({ error: "No PDF for this invoice" }, { status: 404 });
  return new NextResponse(new Uint8Array(fs.readFileSync(inv.pdfRef)), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${inv.number}.pdf"`, "Cache-Control": "private, no-store" },
  });
});

const Patch = z.object({ action: z.enum(["send", "paid"]) });

export const PATCH = guarded(FEATURES.invoicesManage, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "action must be send or paid" }, { status: 400 });

  const inv = await prisma.invoice.findUnique({ where: { id }, select: { id: true, orderId: true, number: true, amountCents: true, sentAt: true, paidAt: true } });
  if (!inv) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.action === "send") {
    if (inv.sentAt) return NextResponse.json({ error: "Already sent" }, { status: 400 });
    await prisma.invoice.update({ where: { id }, data: { sentAt: new Date() } });
    void audit({ actorId: actor!.id, entityType: "invoice", entityId: id, action: "sent" });
  } else {
    if (inv.paidAt) return NextResponse.json({ error: "Already marked paid" }, { status: 400 });
    await prisma.$transaction([
      prisma.invoice.update({ where: { id }, data: { paidAt: new Date() } }),
      prisma.payment.create({ data: { orderId: inv.orderId, kind: "BALANCE", amountCents: inv.amountCents, method: "invoice", notes: `Fattura ${inv.number}` } }),
    ]);
    void audit({ actorId: actor!.id, entityType: "invoice", entityId: id, action: "paid", after: { amountCents: inv.amountCents } });
    void audit({ actorId: actor!.id, entityType: "order", entityId: inv.orderId, action: "payment-recorded", after: { kind: "BALANCE", via: "invoice", amountCents: inv.amountCents } });
  }
  await publishEventDurable("order.updated", { orderId: inv.orderId });
  await publishEventDurable("payment.recorded", { orderId: inv.orderId });
  return NextResponse.json({ ok: true });
});
