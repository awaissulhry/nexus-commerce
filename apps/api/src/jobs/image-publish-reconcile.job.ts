/**
 * Image-publish reconcile cron — safety net for the publish writeback.
 *
 * A feed can finish on Amazon (job status DONE) but leave the product's
 * ListingImage rows stuck on DRAFT — e.g. an all-accepted feed returns an empty
 * processing report, or the finalizing poll never ran because no one had the
 * images tab open. This sweep finds such products and flips DRAFT -> PUBLISHED
 * when the latest publish is genuinely complete (a DONE feed exists and nothing
 * is in-flight), so status reflects reality without anyone watching it.
 *
 * Status-only: it writes Nexus rows, never calls Amazon — harmless + idempotent.
 * On by default (it's a safety net; gating it off would defeat the purpose).
 * Tick: every 3 min, plus one sweep ~30s after boot so deploys heal promptly.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { pollAndUpdateFeedJob } from '../services/images/amazon-image-feed.service.js'

const TICK_INTERVAL_MS = 3 * 60 * 1000
const INFLIGHT = new Set(['IN_QUEUE', 'IN_PROGRESS', 'SUBMITTING', 'PENDING'])

let cronTimer: NodeJS.Timeout | null = null

export async function runImagePublishReconcileOnce(): Promise<string> {
  // 0. Advance STALE in-flight feeds first. A feed Amazon already finished can
  //    sit IN_QUEUE/IN_PROGRESS in our records when the FE poll / SQS finalize
  //    never ran (e.g. tab closed). Poll Amazon for them — a DONE result
  //    finalizes the job and flips its rows. Without this, step 2 below would
  //    skip the product forever (it has an "in-flight" feed that never clears).
  const stale = await prisma.amazonImageFeedJob.findMany({
    where: {
      status: { in: ['IN_QUEUE', 'IN_PROGRESS'] },
      feedId: { not: null },
      submittedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
    },
    select: { id: true },
    take: 15,
  })
  let advanced = 0
  for (const j of stale) {
    try {
      const r = await pollAndUpdateFeedJob(j.id)
      if (r.status === 'DONE' || r.status === 'FATAL' || r.status === 'CANCELLED') advanced += 1
    } catch {
      /* keep going — one bad feed shouldn't stall the sweep */
    }
  }

  // 0b. Re-finalize BLIND DONE feeds — those finalized before the gzip-parse fix
  //     have a report-less resultSummary, so we never recorded Amazon's true
  //     accept/reject. Re-poll (the report decompresses now) to record it.
  //     Self-limiting: once a feed has a real report it's skipped.
  const recentDone = await prisma.amazonImageFeedJob.findMany({
    where: { status: 'DONE', feedId: { not: null } },
    select: { id: true, resultSummary: true },
    orderBy: { submittedAt: 'desc' },
    take: 30,
  })
  let refetched = 0
  // Cap report re-fetches per tick — getFeedDocument is rate-limited (~1/45s,
  // small burst). Hammering all blind feeds at once throttles and stalls; a few
  // per 3-min tick drains the backlog without tripping the limit.
  const MAX_REFETCH_PER_TICK = 4
  for (const j of recentDone) {
    if ((j.resultSummary as any)?.processingReport) continue
    if (refetched >= MAX_REFETCH_PER_TICK) break
    try { await pollAndUpdateFeedJob(j.id); refetched += 1 } catch { /* keep going */ }
  }

  // Products that currently have any DRAFT Amazon image rows.
  const draftProducts = await prisma.listingImage.findMany({
    where: { publishStatus: 'DRAFT', platform: 'AMAZON' },
    select: { productId: true },
    distinct: ['productId'],
  })
  if (draftProducts.length === 0) return 'nothing to reconcile'

  let healedProducts = 0
  let healedRows = 0
  let skippedInflight = 0
  let stuckErrors = 0

  for (const { productId } of draftProducts) {
    const jobs = await prisma.amazonImageFeedJob.findMany({
      where: { productId },
      select: { status: true },
      orderBy: { submittedAt: 'desc' },
      take: 20,
    })
    if (jobs.length === 0) continue
    // A publish is mid-flight — leave the rows alone; its finalize will flip them.
    if (jobs.some((j) => INFLIGHT.has(j.status))) {
      skippedInflight += 1
      continue
    }
    // No completed publish for this product — nothing to heal.
    if (!jobs.some((j) => j.status === 'DONE')) continue

    const res = await prisma.listingImage.updateMany({
      where: { productId, publishStatus: 'DRAFT' },
      data: { publishStatus: 'PUBLISHED', publishedAt: new Date(), publishError: null },
    })
    if (res.count > 0) {
      healedProducts += 1
      healedRows += res.count
    }
  }

  // Surface (don't auto-touch) rows stuck in ERROR — operator visibility.
  stuckErrors = await prisma.listingImage.count({ where: { publishStatus: 'ERROR', platform: 'AMAZON' } })

  return `advanced ${advanced} stale feed(s); re-fetched ${refetched} blind report(s); healed ${healedRows} row(s) across ${healedProducts} product(s); ${skippedInflight} skipped (in-flight); ${stuckErrors} row(s) in ERROR`
}

export function startImagePublishReconcileCron(): void {
  if (cronTimer) return
  // Boot sweep so a deploy heals already-stuck rows promptly (after the app settles).
  setTimeout(() => {
    void runImagePublishReconcileOnce()
      .then((s) => { if (s !== 'nothing to reconcile') logger.info(`image-publish-reconcile: boot — ${s}`) })
      .catch(() => {})
  }, 30 * 1000)

  cronTimer = setInterval(() => {
    void (async () => {
      try {
        const summary = await runImagePublishReconcileOnce()
        if (summary !== 'nothing to reconcile') logger.info(`image-publish-reconcile: ${summary}`)
      } catch (err) {
        logger.warn('image-publish-reconcile: tick failed', { err: err instanceof Error ? err.message : String(err) })
      }
    })()
  }, TICK_INTERVAL_MS)
  logger.info(`image-publish-reconcile: cron started (interval ${TICK_INTERVAL_MS}ms)`)
}

export function stopImagePublishReconcileCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer)
    cronTimer = null
  }
}
