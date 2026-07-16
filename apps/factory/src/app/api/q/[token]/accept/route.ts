/** FP3.4 — PUBLIC: the customer accepts the quote. Token is the auth. */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { hashToken } from "@/lib/quotes/public";
import { notifyOwners } from "@/lib/quotes/notify-owners";

export const permission = PUBLIC;

export const POST = guarded(PUBLIC, async (_req, { params }) => {
  const { token } = await params;
  const quote = await prisma.quote.findUnique({ where: { acceptTokenHash: hashToken(token) }, select: { id: true, number: true, state: true, validUntilAt: true, conversationId: true } });
  if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (quote.state !== "SENT") return NextResponse.json({ error: "already_decided" }, { status: 409 });
  if (quote.validUntilAt && quote.validUntilAt.getTime() < Date.now()) return NextResponse.json({ error: "expired" }, { status: 410 });

  await prisma.quote.update({ where: { id: quote.id }, data: { state: "ACCEPTED" } });
  // a customer reply reopens a closed thread
  if (quote.conversationId) await prisma.conversation.updateMany({ where: { id: quote.conversationId, state: "CLOSED" }, data: { state: "OPEN" } });
  void audit({ entityType: "quote", entityId: quote.id, action: "accepted", after: { via: "public link" } });
  await notifyOwners({ title: `Quote ${quote.number} accepted by the customer`, entityId: quote.id, href: `/quotes?q=${quote.id}` });
  await publishEventDurable("pricing.updated", { quoteId: quote.id });
  return NextResponse.json({ ok: true });
});
