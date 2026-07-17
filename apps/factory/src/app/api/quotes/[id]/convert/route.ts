/**
 * FP3.4 — convert an accepted quote into an Order (minimal record — the Orders
 * board is FP4). Lines snapshot from the quote. Quotes never reserve stock
 * here (Katana verdict): material reservation happens at production start (FP6).
 * EPQ.2 — the conversion rings every OTHER active Owner (S6).
 * FS4 (C-3) — order+lines+quote in one transaction; double-convert race-safe.
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

/** FS4 — thrown inside the convert transaction when the race was lost; rolls the order back. */
class AlreadyConvertedError extends Error {}

export const POST = guarded(FEATURES.quotesConvert, async (_req, { params, actor }) => {
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      lines: true,
      // EPQ.5 — a Stripe deposit paid before conversion waits on the version's
      // evidence as a pending ref; conversion promotes it to a real Payment
      versions: { orderBy: { version: "desc" }, take: 1, select: { evidenceJson: true } },
    },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (quote.state !== "ACCEPTED") return NextResponse.json({ error: "Only accepted quotes convert to orders" }, { status: 400 });
  if (quote.convertedOrderId) return NextResponse.json({ error: "Already converted", orderId: quote.convertedOrderId }, { status: 409 });

  const number = await nextNumber("order");
  // FS4 (C-3) — order + lines + quote linkage commit or vanish TOGETHER, and
  // the quote write re-asserts convertedOrderId IS NULL inside the transaction
  // so two racing converts can't both mint an order (the loser rolls back,
  // including its order). Side effects (audit/notify/event/chat) stay outside.
  let order: { id: string; number: string };
  try {
    order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
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
      const linked = await tx.quote.updateMany({
        where: { id, convertedOrderId: null },
        data: { convertedOrderId: created.id },
      });
      if (linked.count === 0) throw new AlreadyConvertedError();
      return created;
    });
  } catch (err) {
    if (err instanceof AlreadyConvertedError) {
      const current = await prisma.quote.findUnique({ where: { id }, select: { convertedOrderId: true } });
      return NextResponse.json({ error: "Already converted", orderId: current?.convertedOrderId ?? null }, { status: 409 });
    }
    throw err;
  }

  // EPQ.5 — promote a pending Stripe deposit (webhook arrived pre-conversion)
  // into a Payment on the newborn order; the idempotency key makes a webhook
  // retry after this point a no-op.
  const pending = (quote.versions[0]?.evidenceJson as { stripeDeposit?: { sessionId?: string; amountCents?: number } } | null)?.stripeDeposit;
  if (pending?.sessionId && (pending.amountCents ?? 0) > 0) {
    try {
      const payment = await prisma.payment.create({
        data: {
          orderId: order.id, kind: "DEPOSIT", amountCents: pending.amountCents!, method: "stripe",
          notes: `Stripe Checkout — acconto preventivo ${quote.number} (paid before conversion)`,
          idempotencyKey: `stripe:${pending.sessionId}`,
        },
      });
      void audit({ actorId: actor!.id, entityType: "payment", entityId: payment.id, action: "recorded", after: { via: "quote-convert", quoteId: id, amountCents: pending.amountCents } });
      await publishEventDurable("payment.recorded", { orderId: order.id, paymentId: payment.id });
    } catch {
      // idempotency key already used — the webhook beat us to it; nothing to do
    }
  }

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
