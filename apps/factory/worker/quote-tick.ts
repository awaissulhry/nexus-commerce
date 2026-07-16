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
 * EPQ.2 — the follow-up pass ("no offer dies of silence"): after the sweep,
 * every SENT quote runs through the pure cadence engine
 * (src/lib/quotes/followup.ts) — due quotes are FLAGGED (followUpRule +
 * followUpFlaggedAt) so they surface in the pipeline's Needs-follow-up queue,
 * with ONE Owner notification per flag (dedupe/snooze/nudge boundaries live in
 * the pure core). This is an Owner task queue, NOT auto-send (Owner decision
 * D-2): the worker never emails a customer.
 *
 * Bounded: the scan is indexed (Quote_validUntilAt_idx, epq1_quote_lifecycle)
 * and capped per tick — a backlog drains across ticks instead of one long
 * write transaction (WAL rule: keep writers short).
 */
import { prisma } from "../src/lib/db";
import { audit } from "../src/lib/audit";
import { publishEventDurable } from "../src/lib/events";
import { notifyOwners } from "../src/lib/quotes/notify-owners";
import { followUpDecision, ruleDays, type FollowUpRule } from "../src/lib/quotes/followup";
import { loadFollowUpSettings } from "../src/lib/quotes/followup-settings";

const SWEEP_CAP = 200;
const FOLLOWUP_CAP = 500; // SENT population is the open-offer set — small by nature

let quoteBusy = false;

/** EPQ.2 — one Owner bell per flag, phrased per rule. */
function flagNotification(
  rule: FollowUpRule,
  q: { number: string; sentAt: Date | null; lastViewedAt: Date | null; validUntilAt: Date | null },
  now: Date,
): { title: string; body: string } {
  const days = ruleDays(rule, q, now);
  const title =
    rule === "unviewed"
      ? `Quote ${q.number} sent ${days}d ago and not yet viewed`
      : rule === "viewed-silent"
        ? `Quote ${q.number} viewed, but silent for ${days}d`
        : `Quote ${q.number} expires in ${days}d`;
  return { title, body: "It's in the follow-up queue on the Quotes page — send a nudge, snooze, or dismiss." };
}

export async function quoteTick(now = new Date()): Promise<{ expired: number; flagged: number; cleared: number }> {
  if (quoteBusy) return { expired: 0, flagged: 0, cleared: 0 };
  quoteBusy = true;
  let expired = 0;
  let flagged = 0;
  let cleared = 0;
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

    // ── EPQ.2 — follow-up pass ────────────────────────────────────────────
    const cfg = await loadFollowUpSettings();

    // a decided/revised/expired quote leaves the queue mechanically
    await prisma.quote.updateMany({
      where: { followUpRule: { not: null }, state: { not: "SENT" } },
      data: { followUpRule: null, followUpFlaggedAt: null },
    });

    const candidates = await prisma.quote.findMany({
      // bounded: SENT is the open-offer set (small by nature); capped anyway
      where: { state: "SENT" },
      orderBy: { sentAt: "asc" },
      take: FOLLOWUP_CAP,
      select: {
        id: true, number: true, state: true, sentAt: true, viewCount: true,
        lastViewedAt: true, validUntilAt: true, lastNudgeAt: true,
        followUpRule: true, followUpFlaggedAt: true,
      },
    });
    for (const q of candidates) {
      const decision = followUpDecision(q, cfg, now);
      if (decision.kind === "clear") {
        // keep followUpFlaggedAt — it anchors the re-notify dedupe window
        await prisma.quote.update({ where: { id: q.id }, data: { followUpRule: null } });
        cleared += 1;
        await publishEventDurable("pricing.updated", { quoteId: q.id });
      } else if (decision.kind === "flag") {
        await prisma.quote.update({ where: { id: q.id }, data: { followUpRule: decision.rule, followUpFlaggedAt: now } });
        flagged += 1;
        const n = flagNotification(decision.rule, q, now);
        void audit({ entityType: "quote", entityId: q.id, action: "followup.flagged", after: { rule: decision.rule, number: q.number } });
        await notifyOwners({ ...n, kind: "REMINDER", entityId: q.id, href: `/quotes?q=${q.id}` });
        await publishEventDurable("pricing.updated", { quoteId: q.id });
      }
      // "keep"/"none": nothing to write
    }
    if (flagged > 0 || cleared > 0) console.log(`[worker] quotes: follow-up ${flagged} flagged, ${cleared} cleared`);
  } catch (err) {
    console.error("[worker] quote tick error:", (err as Error).message);
  } finally {
    quoteBusy = false;
  }
  return { expired, flagged, cleared };
}
