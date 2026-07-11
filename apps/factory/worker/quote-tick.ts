/**
 * EPQ.1 — quote tick: the EXPIRED sweep. SENT quotes past their validity flip
 * to EXPIRED (the state FP3 defined but nothing ever set — S1), each audited,
 * published durably (worker process → outbox → web SSE), and announced to
 * every active Owner ONCE per quote (the SENT→EXPIRED edge fires exactly once;
 * a Revise that re-sends mints a new validity and may legitimately ring
 * again). Runs from worker/index.ts on the minute cadence next to inboxTick:
 *
 *   import { quoteTick } from "./quote-tick";
 *   setInterval(() => void quoteTick(), 60_000),
 *
 * Bounded: the scan is indexed (Quote_validUntilAt_idx, epq1_quote_lifecycle)
 * and capped per tick — a backlog drains across ticks instead of one long
 * write transaction (WAL rule: keep writers short).
 */
import { prisma } from "../src/lib/db";
import { audit } from "../src/lib/audit";
import { publishEventDurable } from "../src/lib/events";
import { notifyOwners } from "../src/lib/quotes/public";

const SWEEP_CAP = 200;

let quoteBusy = false;

export async function quoteTick(now = new Date()): Promise<{ expired: number }> {
  if (quoteBusy) return { expired: 0 };
  quoteBusy = true;
  let expired = 0;
  try {
    const lapsed = await prisma.quote.findMany({
      // bounded: due-scan on Quote_validUntilAt_idx; capped, drains across ticks
      where: { state: "SENT", validUntilAt: { lt: now } },
      orderBy: { validUntilAt: "asc" },
      take: SWEEP_CAP,
      select: { id: true, number: true, validUntilAt: true },
    });
    for (const q of lapsed) {
      // guard the edge: only flip a row that is STILL SENT (a decision may
      // have landed between the scan and this write — forward-only holds)
      const res = await prisma.quote.updateMany({ where: { id: q.id, state: "SENT" }, data: { state: "EXPIRED" } });
      if (res.count === 0) continue;
      expired += 1;
      void audit({ entityType: "quote", entityId: q.id, action: "expired", before: { from: "SENT" }, after: { to: "EXPIRED", number: q.number, validUntilAt: q.validUntilAt } });
      await publishEventDurable("pricing.updated", { quoteId: q.id });
      await notifyOwners({ title: `Preventivo scaduto: ${q.number}`, entityId: q.id, href: `/quotes?q=${q.id}` });
    }
    if (expired > 0) console.log(`[worker] quotes: ${expired} swept to EXPIRED`);
  } catch (err) {
    console.error("[worker] quote tick error:", (err as Error).message);
  } finally {
    quoteBusy = false;
  }
  return { expired };
}
