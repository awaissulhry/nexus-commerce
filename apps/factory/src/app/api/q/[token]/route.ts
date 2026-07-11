/**
 * FP3.4 — PUBLIC customer view of a quote (token-authed, no session). Returns
 * the latest FROZEN version snapshot — exactly what was sent, no cost/margin.
 * EPQ.1 — supersede semantics: Quote.acceptTokenHash always holds the LATEST
 * send's token, so a hit there serves the offer as today. A miss falls through
 * to QuoteVersion.acceptTokenHash — an OLDER send's token — which renders as
 * superseded: that version's own frozen snapshot, no accept path, and no leak
 * of the new token (the customer uses the newest email's link).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { hashToken } from "@/lib/quotes/public";
import { isQuoteLapsed, isSupersededToken } from "@/lib/quotes/transitions";

export const permission = PUBLIC;

export const GET = guarded(PUBLIC, async (_req, { params }) => {
  const { token } = await params;
  const h = hashToken(token);
  const quote = await prisma.quote.findUnique({
    where: { acceptTokenHash: h },
    select: {
      number: true, state: true, validUntilAt: true, convertedOrderId: true,
      party: { select: { name: true } },
      versions: { orderBy: { version: "desc" }, take: 1, select: { sentSnapshot: true } },
    },
  });
  if (quote && quote.versions[0]) {
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
          number: true, state: true, validUntilAt: true, convertedOrderId: true,
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
