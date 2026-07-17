/**
 * EPQ.5 (D-1, env-gated) — Stripe webhook. The HMAC signature over the RAW
 * body is the auth AND the anti-forgery proof (no cookies on a machine call,
 * so the CSRF double-submit is skipped — see guard.ts). Fully dark without
 * keys (404). One event matters: `checkout.session.completed` for a quote
 * deposit — it records a Payment{kind: DEPOSIT} on the converted order when
 * one exists (idempotent via the client-minted key `stripe:<sessionId>`), or
 * stores a pending ref on the accepted version's evidence otherwise (the
 * convert route promotes it to a real Payment when the order is born).
 * Money-event wording is EPF's pure builder (consumed, never re-implemented).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { notifyOwners } from "@/lib/quotes/notify-owners";
import { paymentRecordedNotice } from "@/lib/financials/notify-money";
import { stripeEnabled, stripeWebhookSecret, verifyStripeSignature } from "@/lib/stripe";

export const permission = PUBLIC;

type CheckoutSession = {
  id: string;
  amount_total?: number | null;
  payment_intent?: string | null;
  metadata?: Record<string, string> | null;
};

export const POST = guarded(PUBLIC, async (req) => {
  if (!stripeEnabled()) return NextResponse.json({ error: "not_configured" }, { status: 404 });

  const rawBody = await req.text();
  const ok = verifyStripeSignature(rawBody, req.headers.get("stripe-signature"), stripeWebhookSecret()!);
  if (!ok) return NextResponse.json({ error: "bad_signature" }, { status: 400 });

  let event: { type?: string; data?: { object?: CheckoutSession } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad_payload" }, { status: 400 });
  }
  if (event.type !== "checkout.session.completed") return NextResponse.json({ received: true });

  const session = event.data?.object;
  const quoteId = session?.metadata?.quoteId;
  if (!session?.id || !quoteId || session.metadata?.kind !== "DEPOSIT") return NextResponse.json({ received: true });

  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: {
      id: true, number: true, convertedOrderId: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { id: true, evidenceJson: true, sentSnapshot: true } },
    },
  });
  if (!quote) return NextResponse.json({ received: true }); // never make Stripe retry forever on a deleted quote

  const snapshot = (quote.versions[0]?.sentSnapshot ?? {}) as { depositCents?: number };
  const amountCents = session.amount_total ?? snapshot.depositCents ?? 0;
  const idempotencyKey = `stripe:${session.id}`;
  const orderId = quote.convertedOrderId ?? session.metadata?.orderId ?? null;

  if (orderId) {
    // the order exists — record the deposit money directly (idempotent)
    try {
      const payment = await prisma.payment.create({
        data: {
          orderId, kind: "DEPOSIT", amountCents, method: "stripe",
          notes: `Stripe Checkout — acconto preventivo ${quote.number}`,
          idempotencyKey,
        },
      });
      const order = await prisma.order.findUnique({ where: { id: orderId }, select: { number: true } });
      void audit({ entityType: "payment", entityId: payment.id, action: "recorded", after: { via: "stripe-webhook", quoteId: quote.id, amountCents } });
      await notifyOwners(paymentRecordedNotice({ orderId, orderNumber: order?.number ?? quote.number, paymentId: payment.id, amountCents, kind: "DEPOSIT" }));
      await publishEventDurable("payment.recorded", { orderId, paymentId: payment.id });
    } catch {
      // unique idempotencyKey hit — the money is already recorded; ack quietly
    }
  } else if (quote.versions[0]) {
    // no order yet — store the pending ref beside the acceptance evidence;
    // the convert route promotes it to a Payment when the order is created
    const existing = (quote.versions[0].evidenceJson ?? {}) as Record<string, unknown>;
    if (!existing.stripeDeposit) {
      await prisma.quoteVersion.update({
        where: { id: quote.versions[0].id },
        data: { evidenceJson: { ...existing, stripeDeposit: { sessionId: session.id, paymentIntent: session.payment_intent ?? null, amountCents, at: new Date().toISOString() } } as object },
      });
      void audit({ entityType: "quote", entityId: quote.id, action: "deposit.paid-pending", after: { sessionId: session.id, amountCents } });
      await notifyOwners({ title: `Deposit €${(amountCents / 100).toFixed(2)} received via Stripe for ${quote.number}`, body: "Recorded on the order at conversion", entityId: quote.id, href: `/quotes?q=${quote.id}` });
      await publishEventDurable("pricing.updated", { quoteId: quote.id });
    }
  }
  return NextResponse.json({ received: true });
}, { csrf: "skip" });
