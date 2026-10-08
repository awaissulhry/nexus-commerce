// Cron observability: wrap a cron handler with recordCronRun() so
// every invocation lands in the CronRun table. Lets operators see
// "when did the 2am job last fire?" / "what was the error?" without
// tailing logs.
//
// Usage in a cron job file:
//
//   cron.schedule('0 4 * * *', async () => {
//     await recordCronRun('forecast-accuracy', async () => {
//       const result = await runForecastAccuracySweep()
//       return `${result.evaluated} accuracy rows · ${result.failed} failed`
//     })
//   })
//
// Or wrap a function:
//
//   await recordCronRun('auto-po', () => runAutoPoSweep({ triggeredBy: 'cron' }))
//
// On manual triggers from the dashboard, pass triggeredBy='manual'
// so the audit trail records who pushed the button.

import prisma from '../db.js'
import { logger } from './logger.js'
import { newTickId, runWithRequestId } from './request-context.js'
import { logTraceEvent } from './trace-log.js'

export interface CronRunOptions {
  triggeredBy?: 'cron' | 'manual'
}

/**
 * How a run that did not throw ended. SUCCESS unless the handler says otherwise: a run can finish without
 * proving what it exists to prove (P1.8's contract run: PARTIAL — some required checks unproven;
 * NOT_CONFIGURED — nothing could run). Neither is a pass, and the dashboards draw only SUCCESS green.
 * A throw stays FAILED.
 */
export type CronCompletedStatus = 'SUCCESS' | 'PARTIAL' | 'NOT_CONFIGURED'
/** Every status a run that did not throw can end with — each one is proof the job RAN (overdue-cron alert). */
export const CRON_COMPLETED_STATUSES: readonly CronCompletedStatus[] = ['SUCCESS', 'PARTIAL', 'NOT_CONFIGURED']
const COMPLETED_STATUSES: ReadonlySet<string> = new Set<string>(CRON_COMPLETED_STATUSES)

export type CronHandlerResult = string | { summary: string; cronStatus?: CronCompletedStatus } | void | undefined

/**
 * Wrap a cron handler. Inserts a CronRun row in RUNNING state, then
 * updates with status + finishedAt + outputSummary (or errorMessage)
 * on completion. Re-throws any error so cron.schedule's own catch
 * handlers still see it.
 *
 * The DB write failures are swallowed (logged only) so observability
 * never breaks a real cron run. The cron's own work is the priority.
 */
export async function recordCronRun<T extends CronHandlerResult>(
  jobName: string,
  handler: () => Promise<T>,
  options: CronRunOptions = {},
): Promise<T> {
  const triggeredBy = options.triggeredBy ?? 'cron'
  // L.12.0 — open a request-context scope for the tick so deep
  // service calls (recordApiCall, audit writes) can stamp this
  // tickId on every log row they produce. Operators get a
  // "show every API call this cron tick made" view in the hub.
  const tickId = newTickId()
  return runWithRequestId(tickId, triggeredBy === 'manual' ? 'manual' : 'cron', () =>
    runCronRunInner(jobName, handler, triggeredBy),
  )
}

async function runCronRunInner<T extends CronHandlerResult>(
  jobName: string,
  handler: () => Promise<T>,
  triggeredBy: 'cron' | 'manual',
): Promise<T> {
  let runId: string | null = null
  try {
    const row = await prisma.cronRun.create({
      data: {
        jobName,
        status: 'RUNNING',
        triggeredBy,
      },
      select: { id: true },
    })
    runId = row.id
  } catch (err) {
    // Don't let observability break the cron. Log and continue.
    logger.warn('[cron-observability] failed to insert RUNNING row', {
      jobName,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // BB-14 — every ads decision reads its days through ads-settled-window.ts, which ends at the newest day Amazon has
  // settled for this business once it knows it. Hand it that fact before the job runs (at most one read per 15 min per
  // business; never fails the cron). Loaded lazily: the module is read once, then each tick is a cached check.
  await import('../services/advertising/ads-settled-facts.js')
    .then((m) => m.primeSettledWindow())
    .catch(() => undefined)

  const startMs = Date.now()
  try {
    const result = await handler()
    const summary =
      typeof result === 'string'
        ? result
        : result && typeof result === 'object' && 'summary' in result
          ? result.summary
          : null
    const requested = result && typeof result === 'object' && 'cronStatus' in result ? result.cronStatus : undefined
    const status: CronCompletedStatus = requested && COMPLETED_STATUSES.has(requested) ? requested : 'SUCCESS'
    if (runId) {
      try {
        await prisma.cronRun.update({
          where: { id: runId },
          data: {
            status,
            finishedAt: new Date(),
            outputSummary: summary,
          },
        })
      } catch (err) {
        logger.warn(`[cron-observability] failed to mark ${status}`, {
          jobName,
          runId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // L.21.0 — emit a trace event for the cron tick. Same structured
    // shape as outbound API calls so a downstream collector groups
    // the cron tick + every API call inside it under the same
    // request-id (set by runWithRequestId at the top of recordCronRun).
    logTraceEvent({
      spanName: `cron.${jobName}`,
      spanKind: 'internal',
      status: 'ok',
      durationMs: Date.now() - startMs,
      attributes: {
        'cron.jobName': jobName,
        'cron.status': status,
        'cron.summary': typeof summary === 'string' ? summary : null,
      },
    })
    return result
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (runId) {
      try {
        await prisma.cronRun.update({
          where: { id: runId },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorMessage: errorMessage.slice(0, 1000),
          },
        })
      } catch (updateErr) {
        logger.warn('[cron-observability] failed to mark FAILED', {
          jobName,
          runId,
          updateErr: updateErr instanceof Error ? updateErr.message : String(updateErr),
        })
      }
    }
    logTraceEvent({
      spanName: `cron.${jobName}`,
      spanKind: 'internal',
      status: 'error',
      durationMs: Date.now() - startMs,
      attributes: {
        'cron.jobName': jobName,
        'error.message': errorMessage.slice(0, 200),
      },
    })
    throw err
  }
}
