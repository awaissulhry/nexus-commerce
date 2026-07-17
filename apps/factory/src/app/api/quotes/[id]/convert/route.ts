/**
 * FP3.4 — convert an accepted quote into an Order (minimal record — the Orders
 * board is FP4). Lines snapshot from the quote. Quotes never reserve stock
 * here (Katana verdict): material reservation happens at production start (FP6).
 * EPQ.2 — the conversion rings every OTHER active Owner (S6).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { nextNumber } from "@/lib/counters";
import { notifyOwners } from "@/lib/quotes/notify-owners";
import { readSelections } from "@/lib/quotes/selections";
import { ensureOrderSpace } from "@/lib/chat/chat-service";

export const permission = FEATURES.quotesConvert;

export const POST = guarded(FEATURES.quotesConvert, async (_req, { params, actor }) => {
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { lines: true },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (quote.state !== "ACCEPTED") return NextResponse.json({ error: "Only accepted quotes convert to orders" }, { status: 400 });
  if (quote.convertedOrderId) return NextResponse.json({ error: "Already converted", orderId: quote.convertedOrderId }, { status: 409 });

  const number = await nextNumber("order");
  const order = await prisma.order.create({
    data: {
      number,
      partyId: quote.partyId,
      bornFromQuoteId: quote.id,
      conversationId: quote.conversationId,
      state: "CONFIRMED",
      promiseDateAt: quote.promiseDateAt,
      lines: {
        create: quote.lines.map((l) => {
          // EPQ.3 — size-run lines land in the ORDER's convention: option ids
          // in selections (production's cert-gate/reserve readers expect a
          // plain array) and the {size: qty} matrix in OrderLine.sizeRun (so
          // Start-production explodes per-size WOs exactly like FP4 entry).
          const sel = readSelections(l.selections);
          return {
            description: l.description ?? "Custom item",
            selections: sel.optionIds as unknown as object,
            sizeRun: sel.sizeRun ?? undefined,
            qty: l.qty,
            netPriceCents: l.netPriceCents,
            costCents: l.costCents,
          };
        }),
      },
    },
    select: { id: true, number: true },
  });
  await prisma.quote.update({ where: { id }, data: { convertedOrderId: order.id } });
  void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "converted", after: { orderId: order.id, orderNumber: order.number } });
  void audit({ actorId: actor!.id, entityType: "order", entityId: order.id, action: "created", after: { via: "quote", quoteId: id, deposit: quote.depositPct } });
  // EPQ.2 — tell every other active Owner; the link lands on the new order
  await notifyOwners({
    title: `Quote ${quote.number} converted to ${order.number}`,
    entityId: id,
    href: `/orders?o=${order.id}`,
    excludeUserId: actor!.id,
  });
  await publishEventDurable("pricing.updated", { quoteId: id, orderId: order.id });
  void ensureOrderSpace(order.id).catch(() => {}); // FC1 — order space (fire-and-forget, never blocks the convert)
  return NextResponse.json({ order });
});
