/**
 * EPQ.5 (D-1, env-gated) — PUBLIC: create a Stripe Checkout Session for the
 * accepted quote's deposit. Token is the auth (latest send only); the route is
 * fully DARK without STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (404 — the
 * page never shows the button either; bank-transfer instructions remain the
 * always-on fallback). The deposit amount comes from the FROZEN snapshot —
 * exactly what the customer accepted, never recomputed here.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { hashToken } from "@/lib/quotes/public";
import { createDepositCheckoutSession, stripeEnabled } from "@/lib/stripe";

export const permission = PUBLIC;

export const POST = guarded(PUBLIC, async (req, { params }) => {
  const { token } = await params;
  if (!stripeEnabled()) return NextResponse.json({ error: "payments_unavailable" }, { status: 404 });

  const quote = await prisma.quote.findUnique({
    where: { acceptTokenHash: hashToken(token) },
    select: {
      id: true, number: true, state: true, convertedOrderId: true,
      versions: { orderBy: { version: "desc" }, take: 1, select: { sentSnapshot: true, evidenceJson: true } },
    },
  });
  if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (quote.state !== "ACCEPTED" && !quote.convertedOrderId) {
    return NextResponse.json({ error: "not_accepted" }, { status: 409 });
  }
  const snapshot = (quote.versions[0]?.sentSnapshot ?? {}) as { depositCents?: number };
  const depositCents = snapshot.depositCents ?? 0;
  if (depositCents <= 0) return NextResponse.json({ error: "no_deposit" }, { status: 400 });

  // already paid? (Stripe pending ref on the version, or a DEPOSIT on the order)
  if ((quote.versions[0]?.evidenceJson as { stripeDeposit?: unknown } | null)?.stripeDeposit) {
    return NextResponse.json({ error: "already_paid" }, { status: 409 });
  }
  if (quote.convertedOrderId) {
    const paid = await prisma.payment.findFirst({ where: { orderId: quote.convertedOrderId, kind: "DEPOSIT" }, select: { id: true } });
    if (paid) return NextResponse.json({ error: "already_paid" }, { status: 409 });
  }

  const publicBase = process.env.FACTORY_PUBLIC_URL || req.nextUrl.origin;
  try {
    const session = await createDepositCheckoutSession({
      amountCents: depositCents,
      label: `Acconto preventivo ${quote.number}`,
      successUrl: `${publicBase}/q/${token}?paid=1`,
      cancelUrl: `${publicBase}/q/${token}`,
      metadata: {
        quoteId: quote.id,
        quoteNumber: quote.number,
        kind: "DEPOSIT",
        ...(quote.convertedOrderId ? { orderId: quote.convertedOrderId } : {}),
      },
    });
    void audit({ entityType: "quote", entityId: quote.id, action: "deposit.checkout-created", after: { sessionId: session.id, amountCents: depositCents } });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    // graceful: Stripe down/refusal never strands the customer — bank transfer stays on screen
    console.error("[quotes] stripe checkout failed:", (err as Error).message);
    return NextResponse.json({ error: "stripe_error" }, { status: 502 });
  }
});
