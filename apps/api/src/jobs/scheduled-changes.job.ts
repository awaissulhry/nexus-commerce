/**
 * F.3 — scheduled product changes cron.
 *
 * Schedule: every minute. Picks up ScheduledProductChange rows in
 * status=PENDING with scheduledFor <= now() and applies them via
 * the same master*Service.update() path that the live PATCH route
 * uses, so cascades (ChannelListing fan-out, OutboundSyncQueue,
 * AuditLog, invalidation broadcasts) behave identically to a manual
 * edit.
 *
 * Concurrency: rows are picked with FOR UPDATE SKIP LOCKED. Two
 * worker replicas can run side-by-side without double-applying the
 * same row.
 *
 * Observability: each run records lastRunAt + counts on the
 * exported status object so /admin/health can surface "X applied,
 * Y failed in last cycle". Failures land in the row's `error`
 * column for the operator UI to render.
 *
 * Default-on; opt out via NEXUS_ENABLE_SCHEDULED_CHANGES=0.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { masterStatusService } from '../services/master-status.service.js'
import { masterPriceService } from '../services/master-price.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

const VALID_KINDS = ['STATUS', 'PRICE'] as const
type Kind = (typeof VALID_KINDS)[number]

interface RunSummary {
  picked: number
  applied: number
  failed: number
  errors: Array<{ id: string; productId: string; error: string }>
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSummary: RunSummary | null = null

const APPLY_BATCH = 100

interface PickedRow {
  id: string
  productId: string
  kind: string
  payload: Record<string, unknown>
}

/**
 * Apply one row. Throws on failure so the caller can record the
 * error against the row.
 */
async function applyOne(row: PickedRow): Promise<void> {
  const kind = row.kind as Kind
  if (kind === 'STATUS') {
    const status = (row.payload.status ?? '') as string
    if (!['ACTIVE', 'DRAFT', 'INACTIVE'].includes(status)) {
      throw new Error(
        `STATUS payload.status invalid (got ${JSON.stringify(status)})`,
      )
    }
    await masterStatusService.update(row.productId, status as 'ACTIVE' | 'DRAFT' | 'INACTIVE', {
      actor: 'scheduled-changes-cron',
      reason: 'scheduled-change',
    })
    return
  }
  if (kind === 'PRICE') {
    const adjustPercent = row.payload.adjustPercent
    const absolute = row.payload.basePrice
    let target: number
    if (typeof absolute === 'number') {
      target = absolute
    } else if (typeof adjustPercent === 'number') {
      const product = await prisma.product.findUnique({
        where: { id: row.productId },
        select: { basePrice: true },
      })
      if (!product) throw new Error(`Product ${row.productId} not found`)
      const current = Number(product.basePrice)
      target = Math.max(0, current * (1 + adjustPercent / 100))
    } else {
      throw new Error(
        'PRICE payload requires basePrice (number) or adjustPercent (number)',
      )
    }
    if (!Number.isFinite(target) || target < 0) {
      throw new Error(`PRICE resolved to invalid target ${target}`)
    }
    await masterPriceService.update(row.productId, target, {
      actor: 'scheduled-changes-cron',
      reason: 'scheduled-change',
    })
    return
  }
  throw new Error(`unsupported kind ${row.kind}`)
}

export async function runScheduledChangesOnce(): Promise<RunSummary> {
  if (process.env.NEXUS_ENABLE_SCHEDULED_CHANGES === '0') {
    const summary: RunSummary = {
      picked: 0,
      applied: 0,
      failed: 0,
      errors: [],
    }
    return summary
  }

  // Pick due rows with SKIP LOCKED so a parallel replica can't grab
  // the same set. The transaction here owns the lock until we update
  // status to APPLIED/FAILED below; any worker landing in this
  // critical section concurrently picks a non-overlapping batch.
  const summary: RunSummary = {
    picked: 0,
    applied: 0,
    failed: 0,
    errors: [],
  }

  try {
    const picked = await prisma.$queryRaw<PickedRow[]>`
      SELECT id, "productId", kind, payload
      FROM "ScheduledProductChange"
      WHERE status = 'PENDING'
        AND "scheduledFor" <= NOW()
      ORDER BY "scheduledFor" ASC
      LIMIT ${APPLY_BATCH}
      FOR UPDATE SKIP LOCKED
    `
    summary.picked = picked.length
    if (picked.length === 0) {
      lastRunAt = new Date()
      lastSummary = summary
      return summary
    }

    for (const row of picked) {
      try {
        await applyOne(row)
        await prisma.scheduledProductChange.update({
          where: { id: row.id },
          data: { status: 'APPLIED', appliedAt: new Date(), error: null },
        })
        summary.applied++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await prisma.scheduledProductChange.update({
          where: { id: row.id },
          data: { status: 'FAILED', appliedAt: new Date(), error: message },
        })
        summary.failed++
        summary.errors.push({ id: row.id, productId: row.productId, error: message })
      }
    }
  } catch (err) {
    logger.error('scheduled-changes cron: outer failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  lastRunAt = new Date()
  lastSummary = summary
  if (summary.applied > 0 || summary.failed > 0) {
    logger.info('scheduled-changes cron: cycle complete', summary)
  }
  return summary
}

export function startScheduledChangesCron(): void {
  if (scheduledTask) {
    logger.warn('scheduled-changes cron already started — skipping')
    return
  }
  // Every minute. The cost is one indexed query (status, scheduledFor)
  // returning empty 99% of the time — cheap.
  const schedule =
    process.env.NEXUS_SCHEDULED_CHANGES_SCHEDULE ?? '* * * * *'
  if (!cron.validate(schedule)) {
    logger.error('scheduled-changes cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    if (process.env.NEXUS_ENABLE_SCHEDULED_CHANGES === '0') {
      // Skip silently — runScheduledChangesOnce also no-ops on this gate.
      return
    }
    void recordCronRun('scheduled-changes', async () => {
      const r = await runScheduledChangesOnce()
      return `picked=${r.picked} applied=${r.applied} failed=${r.failed}`
    }).catch((err) => {
      logger.error('scheduled-changes cron: top-level failure', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  })
  logger.info('scheduled-changes cron: scheduled', { schedule })
}

export function stopScheduledChangesCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getScheduledChangesStatus() {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSummary,
  }
}
