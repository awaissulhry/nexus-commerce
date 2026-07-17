/**
 * FP3.4 — PUBLIC customer view of a quote (token-authed, no session). Returns
 * the latest FROZEN version snapshot — exactly what was sent, no cost/margin.
 * EPQ.1 — supersede semantics: Quote.acceptTokenHash always holds the LATEST
 * send's token, so a hit there serves the offer as today. A miss falls through
 * to QuoteVersion.acceptTokenHash — an OLDER send's token — which renders as
 * superseded: that version's own frozen snapshot, no accept path, and no leak
 * of the new token (the customer uses the newest email's link).
 * EPQ.2 — every open records a view (event row + Quote counters, version from
 * the resolved token — superseded links count too), fire-and-forget so the
 * customer's page never blocks; the FIRST view of a SENT quote rings every
 * active Owner. sha256(ip) only — the raw address is never stored.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { hashToken } from "@/lib/quotes/public";
import { recordQuoteView, viewerMeta } from "@/lib/quotes/views";
import { isQuoteLapsed, isSupersededToken } from "@/lib/quotes/transitions";
import { loadBankDetails } from "@/lib/quotes/compliance-settings";
import { stripeEnabled } from "@/lib/stripe";

export const permission = PUBLIC;

/**
 * EPQ.5 — deposit payment block for an ACCEPTED quote: how much, whether the
 * Stripe button may show (env-gated, not yet paid), and the bank-transfer
 * fallback text. `paid` = a DEPOSIT payment on the converted order OR a Stripe
 * pending ref already stored on the version's evidence.
 */
async function depositBlock(q: {
  state: string;
  convertedOrderId: string | null;
  versions: { sentSnapshot: unknown; evidenceJson?: unknown }[];
}) {
  if (q.state !== "ACCEPTED" && !q.convertedOrderId) return null;
  const snap = (q.versions[0]?.sentSnapshot ?? {}) as { depositCents?: number };
  const depositCents = snap.depositCents ?? 0;
  if (depositCents <= 0) return null;
  let paid = Boolean((q.versions[0]?.evidenceJson as { stripeDeposit?: unknown } | null)?.stripeDeposit);
  if (!paid && q.convertedOrderId) {
    const payment = await prisma.payment.findFirst({ where: { orderId: q.convertedOrderId, kind: "DEPOSIT" }, select: { id: true } });
    paid = Boolean(payment);
  }
  const bankDetails = (await loadBankDetails()).trim() || null;
  return { depositCents, paid, stripePayable: stripeEnabled() && !paid, bankDetails };
}

export const GET = guarded(PUBLIC, async (req, { params }) => {
  const { token } = await params;
  const h = hashToken(token);
  const quote = await prisma.quote.findUnique({
    where: { acceptTokenHash: h },
    select: {
      id: true, number: true, state: true, validUntilAt: true, convertedOrderId: true,
      viewCount: true, firstViewedAt: true, // EPQ.2 — first-view detection
      party: { select: { name: true } },
      versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, sentSnapshot: true, evidenceJson: true } },
    },
  });
  if (quote && quote.versions[0]) {
    // EPQ.2 — fire-and-forget: bookkeeping never delays the customer
    void recordQuoteView({
      quoteId: quote.id, number: quote.number, version: quote.versions[0].version,
      state: quote.state, viewCount: quote.viewCount, firstViewedAt: quote.firstViewedAt,
      ...viewerMeta(req),
    });
    return NextResponse.json({
      number: quote.number,
      partyName: quote.party.name,
      state: quote.state,
      validUntilAt: quote.validUntilAt,
      expired: isQuoteLapsed(quote.validUntilAt, new Date()),
      decided: quote.state === "ACCEPTED" || quote.state === "REJECTED",
      converted: !!quote.convertedOrderId,
      superseded: false,
      snapshot: quote.versions[0].sentSnapshot, // customer-facing, no cost/margin
      deposit: await depositBlock(quote), // EPQ.5 — pay-the-deposit block (accepted only)
    });
  }

  // EPQ.1 — not the latest token: an older version may own it (superseded offer)
  const version = await prisma.quoteVersion.findUnique({
    where: { acceptTokenHash: h },
    select: {
      version: true,
      sentSnapshot: true,
      quote: {
        select: {
          id: true, number: true, state: true, validUntilAt: true, convertedOrderId: true,
          viewCount: true, firstViewedAt: true, // EPQ.2
          party: { select: { name: true } },
          versions: { orderBy: { version: "desc" }, take: 1, select: { version: true } },
        },
      },
    },
  });
  if (!version) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const latest = version.quote.versions[0]?.version ?? version.version;
  if (!isSupersededToken(version.version, latest)) {
    // belt-and-braces: a latest-version token should have matched the Quote row
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // EPQ.2 — a superseded link opened is still a customer looking at the offer
  void recordQuoteView({
    quoteId: version.quote.id, number: version.quote.number, version: version.version,
    state: version.quote.state, viewCount: version.quote.viewCount, firstViewedAt: version.quote.firstViewedAt,
    ...viewerMeta(req),
  });
  return NextResponse.json({
    number: version.quote.number,
    partyName: version.quote.party.name,
    state: version.quote.state,
    validUntilAt: version.quote.validUntilAt,
    expired: isQuoteLapsed(version.quote.validUntilAt, new Date()),
    decided: version.quote.state === "ACCEPTED" || version.quote.state === "REJECTED",
    converted: !!version.quote.convertedOrderId,
    superseded: true,
    latestExists: true,
    snapshot: version.sentSnapshot, // this send's own frozen content — never the newer offer
  });
});
