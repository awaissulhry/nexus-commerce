/**
 * Step 4 Send to FBA — resume plans the job has to move on (plan §2c).
 *
 * A plan run ends when an Amazon operation is still running (`nextCheckAt = now + 60 s`), when it is held (writes off,
 * sign-in, rate wait), or when its process stopped mid-run (the lease in `nextCheckAt` runs out). This job queues every
 * such plan again once its `nextCheckAt` is due; the run that follows claims the plan and goes on from its step log
 * (operation ids are written before polling, so nothing is sent twice). It also picks up a plan whose dispatch was lost
 * (a job status with `nextCheckAt` still empty) and a shipment marked Shipped whose tracking is due.
 *
 * - Clustered (hard rule 7): one tick per business per schedule, on one replica.
 * - Only Step 4 plans (`source` set): an older wizard plan's status words overlap the new ones.
 *
 * Schedule: NEXUS_FBA_INBOUND_RESUME_SCHEDULE (default every minute). NEXUS_FBA_INBOUND_RESUME=0 turns it off.
 */
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { FBA_JOB_STATUSES } from '@nexus/shared/fba-send'
import { FBA_RESUME_ENV, dispatchFbaPlan } from '../services/fba-inbound/contract.js'

const PER_TICK = 20
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export interface FbaInboundResumeTick { due: number; queued: number }

/** One look in the current business. Exported for tests and for a manual run. */
export async function runFbaInboundResumeTick(now = new Date(), dispatch: (planRowId: string) => Promise<unknown> = dispatchFbaPlan): Promise<FbaInboundResumeTick> {
  const due = await prisma.fbaInboundPlanV2.findMany({
    where: {
      source: { not: null },
      OR: [
        // The job's own states: due, or never claimed (a lost dispatch).
        { status: { in: [...FBA_JOB_STATUSES] }, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
        // A person's states with job work left: tracking of a shipment marked Shipped (markShipped sets nextCheckAt).
        { status: { in: ['READY_TO_SHIP', 'SHIPPED'] }, nextCheckAt: { lte: now } },
      ],
    },
    orderBy: [{ nextCheckAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: PER_TICK,
    select: { id: true },
  })
  const tick: FbaInboundResumeTick = { due: due.length, queued: 0 }
  for (const row of due) {
    try {
      await dispatch(row.id)
      tick.queued += 1
    } catch (error) {
      logger.warn('[fba-inbound-resume] could not queue a plan; the next tick tries again', { planRowId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (tick.due) logger.info('[fba-inbound-resume] tick', { ...tick })
  return tick
}

export function startFbaInboundResumeCron(): void {
  if (process.env[FBA_RESUME_ENV] === '0') {
    logger.info(`fba-inbound-resume cron: off (${FBA_RESUME_ENV}=0)`)
    return
  }
  if (scheduledTask) {
    logger.warn('fba-inbound-resume cron already started')
    return
  }
  const schedule = process.env.NEXUS_FBA_INBOUND_RESUME_SCHEDULE ?? '* * * * *'
  if (!cron.validate(schedule)) {
    logger.error('fba-inbound-resume cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await recordCronRun('fba-inbound-resume', async () => {
      const r = await runFbaInboundResumeTick()
      return `due=${r.due} queued=${r.queued}`
    })
  })
  logger.info('fba-inbound-resume cron: scheduled', { schedule })
}

export function stopFbaInboundResumeCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
