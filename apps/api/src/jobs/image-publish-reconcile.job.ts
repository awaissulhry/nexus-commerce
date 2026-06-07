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

const TICK_INTERVAL_MS = 3 * 60 * 1000
const INFLIGHT = new Set(['IN_QUEUE', 'IN_PROGRESS', 'SUBMITTING', 'PENDING'])

let cronTimer: NodeJS.Timeout | null = null

export async function runImagePublishReconcileOnce(): Promise<string> {
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

  return `healed ${healedRows} row(s) across ${healedProducts} product(s); ${skippedInflight} skipped (in-flight); ${stuckErrors} row(s) in ERROR`
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
