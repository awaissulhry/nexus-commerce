/**
 * PO-Plus.6 — Recurring PO cron.
 *
 * Wakes every 5 min, picks PoSchedule rows where nextRunAt <= now
 * AND isActive=true, instantiates a fresh DRAFT PO from the linked
 * template, then advances nextRunAt by the cadence.
 *
 * Default-OFF behind NEXUS_ENABLE_SCHEDULED_PO=1 since auto-creating
 * POs has real downstream impact (supplier sees them on the next
 * Send transition). Operator opts in deliberately.
 *
 * Per-row failure: caught, schedule's lastRunAt stamped but
 * lastGeneratedPoId stays null; cron continues through other rows.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const TICK_INTERVAL_MS = 5 * 60 * 1000

let cronTimer: NodeJS.Timeout | null = null

function advanceNextRun(from: Date, cadence: string, interval: number): Date {
  const next = new Date(from)
  const n = Math.max(1, interval)
  switch (cadence) {
    case 'DAILY':
      next.setDate(next.getDate() + n)
      break
    case 'WEEKLY':
      next.setDate(next.getDate() + n * 7)
      break
    case 'MONTHLY':
      next.setMonth(next.getMonth() + n)
      break
    case 'QUARTERLY':
      next.setMonth(next.getMonth() + n * 3)
      break
    default:
      next.setDate(next.getDate() + 7)
  }
  return next
}

// Deterministic-ish PO number gen lifted from fulfillment.routes.
// Sub-second uniqueness guard: append a 3-char random suffix.
function generatePoNumber(): string {
  const today = new Date()
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `PO-${yyyy}${mm}${dd}-${rand}`
}

export async function runScheduledPoOnce(): Promise<string> {
  const now = new Date()
  const due = await prisma.poSchedule.findMany({
    where: { isActive: true, nextRunAt: { lte: now } },
    include: {
      template: {
        include: {
          items: { orderBy: [{ lineOrder: 'asc' }, { id: 'asc' }] },
        },
      },
    },
    take: 25,
  })

  if (due.length === 0) return 'no schedules due'

  let fired = 0
  let failed = 0
  for (const schedule of due) {
    try {
      const tpl = schedule.template
      if (!tpl || tpl.deletedAt) {
        // Soft-deleted template — deactivate the schedule rather than
        // looping on it forever.
        await prisma.poSchedule.update({
          where: { id: schedule.id },
          data: { isActive: false, lastRunAt: now },
        })
        failed++
        continue
      }
      if (tpl.items.length === 0) {
        await prisma.poSchedule.update({
          where: { id: schedule.id },
          data: { lastRunAt: now, nextRunAt: advanceNextRun(now, schedule.cadence, schedule.cadenceInterval) },
        })
        failed++
        continue
      }

      const totalCents = tpl.items.reduce(
        (s, it) => s + it.unitCostCents * it.quantityOrdered,
        0,
      )
      const expectedDeliveryDate = schedule.expectedLeadDays
        ? new Date(now.getTime() + schedule.expectedLeadDays * 86400_000)
        : null
      const warehouseId =
        tpl.warehouseId ??
        (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id ??
        null

      const po = await prisma.purchaseOrder.create({
        data: {
          poNumber: generatePoNumber(),
          supplierId: tpl.supplierId,
          warehouseId,
          status: 'DRAFT',
          expectedDeliveryDate,
          notes: tpl.notes
            ? `${tpl.notes}\n\n(Auto-generated from template "${tpl.name}")`
            : `Auto-generated from template "${tpl.name}"`,
          totalCents,
          currencyCode: tpl.currencyCode,
          items: {
            create: tpl.items.map((it, idx) => ({
              productId: it.productId,
              sku: it.sku,
              supplierSku: it.supplierSku,
              quantityOrdered: it.quantityOrdered,
              unitCostCents: it.unitCostCents,
              note: it.note,
              lineOrder: idx,
            })),
          },
        },
      })

      await prisma.poSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: now,
          lastGeneratedPoId: po.id,
          nextRunAt: advanceNextRun(now, schedule.cadence, schedule.cadenceInterval),
        },
      })

      // PO.4 — emit so any open list/detail tab sees the new draft
      // sub-second. Dynamic import keeps this job standalone-runnable.
      try {
        const { publishPoEvent } = await import('../services/po-events.service.js')
        publishPoEvent({
          type: 'po.created',
          poId: po.id,
          poNumber: po.poNumber,
          ts: Date.now(),
        })
      } catch {
        /* ignore — event bus best-effort */
      }

      fired++
    } catch (err) {
      logger.warn(
        `scheduled-po: failed to fire schedule ${schedule.id}`,
        { err: err instanceof Error ? err.message : String(err) },
      )
      try {
        await prisma.poSchedule.update({
          where: { id: schedule.id },
          data: { lastRunAt: now },
        })
      } catch {
        /* ignore */
      }
      failed++
    }
  }

  return `due=${due.length} fired=${fired} failed=${failed}`
}

export function startScheduledPoCron(): void {
  if (cronTimer) return
  if (process.env.NEXUS_ENABLE_SCHEDULED_PO !== '1') {
    logger.info(
      'scheduled-po: disabled (set NEXUS_ENABLE_SCHEDULED_PO=1 to enable)',
    )
    return
  }
  cronTimer = setInterval(() => {
    void (async () => {
      try {
        const summary = await runScheduledPoOnce()
        if (summary !== 'no schedules due') {
          logger.info(`scheduled-po: tick — ${summary}`)
        }
      } catch (err) {
        logger.warn(
          'scheduled-po: tick failed',
          { err: err instanceof Error ? err.message : String(err) },
        )
      }
    })()
  }, TICK_INTERVAL_MS)
  logger.info(`scheduled-po: cron started (interval ${TICK_INTERVAL_MS}ms)`)
}

export function stopScheduledPoCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer)
    cronTimer = null
  }
}
