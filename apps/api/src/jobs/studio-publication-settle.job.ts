/**
 * Sheet publish parity, step 2 — the result sweep for product sheet publications.
 *
 * An Amazon feed is processed minutes after Nexus sends it; an eBay item may need a second read-back. Until now only
 * the submitter's own "Check publication status" settled either, so a publication nobody checked stayed SUBMITTED
 * and blocked its destination. This sweep settles them by itself, through the same core the status read uses
 * (`settleStudioPublication`), so a result is stored ONCE whoever gets there first.
 *
 * - Clustered (hard rule 7): one tick per business per schedule, on one replica.
 * - Due rows only: `nextCheckAt <= now`, oldest due first, 20 per business per tick. A row is CLAIMED by moving its
 *   `nextCheckAt` five minutes ahead (a lease) and counting the claim; a second replica, or an overlapping tick,
 *   reads no row it can claim and makes no channel call.
 * - First-deploy safety: a publication made before this step has `nextCheckAt` null and is never swept — unless
 *   NEXUS_STUDIO_PUBLICATION_SETTLE=1 (the switch of main's earlier MCP sweep, #251, which this sweep replaces): then
 *   each tick first gives every still-open publication of the last 30 days a due time, so none it used to settle is lost.
 *
 * Schedule: NEXUS_PUBLICATION_SETTLE_SCHEDULE (default every 2 minutes). NEXUS_PUBLICATION_SETTLE=0 turns it off.
 */
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { IN_FLIGHT, PUBLICATION_KIND, reschedulePublication, settleStudioPublication } from '../services/pim/studio-publication-settle.js'

const LEASE_MS = 5 * 60_000
const PER_TICK = 20
const ADOPT_HORIZON_MS = 30 * 24 * 60 * 60_000

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export interface PublicationSettleTick {
  due: number
  claimed: number
  settled: number
  failed: number
  /** Accepted publications whose missed offer promotion ran now. */
  offersRecovered?: number
}

/** One sweep in the current business. Exported for tests and for a manual run. */
export async function runPublicationSettleTick(now = new Date()): Promise<PublicationSettleTick> {
  if (process.env.NEXUS_STUDIO_PUBLICATION_SETTLE === '1') {
    await prisma.bulkOperation.updateMany({
      where: { kind: PUBLICATION_KIND, status: { in: IN_FLIGHT }, nextCheckAt: null, createdAt: { gte: new Date(now.getTime() - ADOPT_HORIZON_MS) } },
      data: { nextCheckAt: now },
    })
  }
  const due = await prisma.bulkOperation.findMany({
    where: { kind: PUBLICATION_KIND, status: { in: IN_FLIGHT }, nextCheckAt: { lte: now } },
    orderBy: [{ nextCheckAt: 'asc' }, { createdAt: 'asc' }],
    take: PER_TICK,
    select: { id: true, status: true },
  })
  const tick: PublicationSettleTick = { due: due.length, claimed: 0, settled: 0, failed: 0 }
  for (const row of due) {
    // The claim: only the caller that moves this row's due time owns this look at it.
    const claim = await prisma.bulkOperation.updateMany({
      where: { id: row.id, status: row.status, nextCheckAt: { lte: now } },
      data: { nextCheckAt: new Date(now.getTime() + LEASE_MS), checkCount: { increment: 1 } },
    })
    if (claim.count !== 1) continue
    tick.claimed += 1
    try {
      const outcome = await settleStudioPublication(row.id, { actorUserId: null })
      // A stored result scheduled its own next look (or none, when it is final).
      if (outcome?.stored) { tick.settled += 1; continue }
      await reschedulePublication(row.id, now)
    } catch (error) {
      tick.failed += 1
      logger.warn('[publication-settle] check failed; it is tried again later', { publicationId: row.id, error: error instanceof Error ? error.message : String(error) })
      try { await reschedulePublication(row.id, now) }
      catch (again) { logger.warn('[publication-settle] could not reschedule; the lease expires and the next tick retries', { publicationId: row.id, error: again instanceof Error ? again.message : String(again) }) }
    }
  }
  // Amazon sheet gaps — an accepted publication whose offer promotion never committed (a crash after the result was
  // stored) is promoted now, once (`studio-publication-offer-promotion.ts`).
  // Loaded here, not at the top: the price and fulfilment doors load the outbound queue.
  try {
    const { recoverOfferPromotions } = await import('../services/pim/studio-publication-offer-promotion.js')
    const recovered = await recoverOfferPromotions(now)
    if (recovered.promoted) tick.offersRecovered = recovered.promoted
    if (recovered.failed) tick.failed += recovered.failed
  } catch (error) {
    logger.warn('[publication-settle] offer promotion recovery failed; the next tick tries again', { error: error instanceof Error ? error.message : String(error) })
  }
  if (tick.due || tick.offersRecovered) logger.info('[publication-settle] tick', { ...tick })
  return tick
}

export function startPublicationSettleCron(): void {
  if (process.env.NEXUS_PUBLICATION_SETTLE === '0') {
    logger.info('publication-settle cron: off (NEXUS_PUBLICATION_SETTLE=0)')
    return
  }
  if (scheduledTask) {
    logger.warn('publication-settle cron already started')
    return
  }
  const schedule = process.env.NEXUS_PUBLICATION_SETTLE_SCHEDULE ?? '*/2 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('publication-settle cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await recordCronRun('publication-settle', async () => {
      const r = await runPublicationSettleTick()
      return `due=${r.due} claimed=${r.claimed} settled=${r.settled} failed=${r.failed} offersRecovered=${r.offersRecovered ?? 0}`
    })
  })
  logger.info('publication-settle cron: scheduled', { schedule })
}

export function stopPublicationSettleCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
