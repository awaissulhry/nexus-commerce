/**
 * FP10.1 — the three live counters: what needs the Owner now. Cheap by design
 * (three counts), so the SSE bus can refresh it on every thread/quote/order move.
 * Unanswered = an OPEN thread whose last message came IN (the customer's waiting).
 */
import { NextResponse } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";

export const permission = PAGES.analytics;

export const GET = guarded(PAGES.analytics, async () => {
  const now = new Date();
  const [openThreads, quotesAwaiting, overduePromises] = await Promise.all([
    prisma.conversation.findMany({ where: { state: "OPEN" }, select: { messages: { orderBy: { sentAt: "desc" }, take: 1, select: { direction: true } } } }),
    prisma.quote.count({ where: { state: "SENT" } }),
    prisma.order.count({ where: { promiseDateAt: { lt: now }, state: { notIn: ["SHIPPED", "DELIVERED", "CLOSED", "CANCELLED"] } } }),
  ]);
  const unansweredThreads = openThreads.filter((c) => c.messages[0]?.direction === "INBOUND").length;
  return NextResponse.json({ unansweredThreads, quotesAwaiting, overduePromises });
});
