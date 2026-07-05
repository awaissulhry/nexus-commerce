/**
 * FP3.4 — PUBLIC customer view of a quote (token-authed, no session). Returns
 * the latest FROZEN version snapshot — exactly what was sent, no cost/margin.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { hashToken } from "@/lib/quotes/public";

export const permission = PUBLIC;

export const GET = guarded(PUBLIC, async (_req, { params }) => {
  const { token } = await params;
  const quote = await prisma.quote.findUnique({
    where: { acceptTokenHash: hashToken(token) },
    select: {
      number: true, state: true, validUntilAt: true, convertedOrderId: true,
      party: { select: { name: true } },
      versions: { orderBy: { version: "desc" }, take: 1, select: { sentSnapshot: true } },
    },
  });
  if (!quote || !quote.versions[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const expired = quote.validUntilAt ? quote.validUntilAt.getTime() < Date.now() : false;
  return NextResponse.json({
    number: quote.number,
    partyName: quote.party.name,
    state: quote.state,
    validUntilAt: quote.validUntilAt,
    expired,
    decided: quote.state === "ACCEPTED" || quote.state === "REJECTED",
    converted: !!quote.convertedOrderId,
    snapshot: quote.versions[0].sentSnapshot, // customer-facing, no cost/margin
  });
});
