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

export interface CronRunOptions {
  triggeredBy?: 'cron' | 'manual'
}

export type CronHandlerResult = string | { summary: string } | void | undefined

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

  try {
    const result = await handler()
    const summary =
      typeof result === 'string'
        ? result
        : result && typeof result === 'object' && 'summary' in result
          ? result.summary
          : null
    if (runId) {
      try {
        await prisma.cronRun.update({
          where: { id: runId },
          data: {
            status: 'SUCCESS',
            finishedAt: new Date(),
            outputSummary: summary,
          },
        })
      } catch (err) {
        logger.warn('[cron-observability] failed to mark SUCCESS', {
          jobName,
          runId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
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
    throw err
  }
}
