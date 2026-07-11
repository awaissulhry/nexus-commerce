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
  // FS1 — "unanswered" is a plain COUNT via Conversation.lastMessageDirection
  // (maintained at both message write points). The old shape — findMany all
  // OPEN threads with a per-row last-message include — was N-1: it 500'd with
  // P2029 past ~1k open threads (FS0-BASELINE).
  const [unansweredThreads, quotesAwaiting, overduePromises] = await Promise.all([
    prisma.conversation.count({ where: { state: "OPEN", lastMessageDirection: "INBOUND" } }),
    prisma.quote.count({ where: { state: "SENT" } }),
    prisma.order.count({ where: { promiseDateAt: { lt: now }, state: { notIn: ["SHIPPED", "DELIVERED", "CLOSED", "CANCELLED"] } } }),
  ]);
  return NextResponse.json({ unansweredThreads, quotesAwaiting, overduePromises });
});
