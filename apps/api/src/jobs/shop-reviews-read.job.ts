/**
 * Reviews (2026-10-27, build spec B21 / PR I) — the two 30-minute review reads of Phase 3, each through the clustered
 * cron (one replica per tick, once per active business with business profiles on):
 *
 *   etsy-reviews-read   every connected Etsy shop's reviews (services/etsy/reviews-read.ts, through the gateway)
 *   review-app-read     the store's review apps — Judge.me, Okendo, Yotpo, Loox (services/reviews/review-app-connection.service.ts)
 *
 * 🔴 OFF by default, twice over: runtime/scheduler.ts starts a schedule only when its switch is on
 * (NEXUS_ENABLE_ETSY_REVIEWS_READ=1, NEXUS_ENABLE_REVIEW_APP_READ=1), and a run checks the same switch again and reads
 * nothing when it is off. The Reviews pages say so in words ("Nexus does not read … in this setup yet"), never by name.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { ETSY_REVIEWS_JOB } from '../services/etsy/reviews-read.js'
import { REVIEW_APP_JOB } from '../services/reviews/review-app-connection.service.js'

export { ETSY_REVIEWS_JOB, REVIEW_APP_JOB }

export const etsyReviewsSchedule = (env: Record<string, string | undefined> = process.env): string => env.NEXUS_ETSY_REVIEWS_SCHEDULE ?? '*/30 * * * *'
export const reviewAppSchedule = (env: Record<string, string | undefined> = process.env): string => env.NEXUS_REVIEW_APP_SCHEDULE ?? '*/30 * * * *'

/** One Etsy run for the business being visited, recorded as a CronRun (Reviews Settings › Pipeline health reads it). */
export async function runEtsyReviewsReadCron(): Promise<void> {
  try {
    await recordCronRun(ETSY_REVIEWS_JOB, async () => {
      const { readEtsyReviewsOnce, summarizeEtsyReviewsRead } = await import('../services/etsy/reviews-read.js')
      const report = await readEtsyReviewsOnce()
      const summary = summarizeEtsyReviewsRead(report)
      if (!report.enabled || report.accounts.length === 0) return { summary, cronStatus: 'NOT_CONFIGURED' as const }
      if (report.accounts.every((a) => a.status === 'FAILED')) throw new Error(report.accounts[0]?.error ?? 'Etsy could not be read.')
      return { summary, cronStatus: report.accounts.some((a) => a.status !== 'SUCCESS') ? 'PARTIAL' as const : 'SUCCESS' as const }
    })
  } catch (err) {
    logger.error(`${ETSY_REVIEWS_JOB} cron: failure`, { error: err instanceof Error ? err.message : String(err) })
  }
}

/** One review-app run for the business being visited. */
export async function runReviewAppReadCron(): Promise<void> {
  try {
    await recordCronRun(REVIEW_APP_JOB, async () => {
      const { readReviewAppsOnce, summarizeReviewAppRead } = await import('../services/reviews/review-app-connection.service.js')
      const summary = await readReviewAppsOnce()
      const words = summarizeReviewAppRead(summary)
      if (!summary.enabled || summary.apps === 0) return { summary: words, cronStatus: 'NOT_CONFIGURED' as const }
      if (summary.errors.length && summary.seen === 0) throw new Error(summary.errors[0])
      return { summary: words, cronStatus: summary.errors.length ? 'PARTIAL' as const : 'SUCCESS' as const }
    })
  } catch (err) {
    logger.error(`${REVIEW_APP_JOB} cron: failure`, { error: err instanceof Error ? err.message : String(err) })
  }
}

let etsyTask: ReturnType<typeof cron.schedule> | null = null
let appTask: ReturnType<typeof cron.schedule> | null = null

/** Started by runtime/scheduler.ts ONLY when NEXUS_ENABLE_ETSY_REVIEWS_READ=1. */
export function startEtsyReviewsReadCron(): void {
  if (etsyTask) { logger.warn(`${ETSY_REVIEWS_JOB} cron already started`); return }
  const schedule = etsyReviewsSchedule()
  if (!cron.validate(schedule)) { logger.error(`${ETSY_REVIEWS_JOB} cron: invalid schedule`, { schedule }); return }
  etsyTask = cron.schedule(schedule, async () => { await runEtsyReviewsReadCron() })
  logger.info(`${ETSY_REVIEWS_JOB} cron: scheduled`, { schedule })
}

/** Started by runtime/scheduler.ts ONLY when NEXUS_ENABLE_REVIEW_APP_READ=1. */
export function startReviewAppReadCron(): void {
  if (appTask) { logger.warn(`${REVIEW_APP_JOB} cron already started`); return }
  const schedule = reviewAppSchedule()
  if (!cron.validate(schedule)) { logger.error(`${REVIEW_APP_JOB} cron: invalid schedule`, { schedule }); return }
  appTask = cron.schedule(schedule, async () => { await runReviewAppReadCron() })
  logger.info(`${REVIEW_APP_JOB} cron: scheduled`, { schedule })
}

/** The scheduler's switchboard for both reads (tested: neither starts unless its switch is on). */
export function startShopReviewReads(env: Record<string, string | undefined> = process.env, start = { etsy: startEtsyReviewsReadCron, app: startReviewAppReadCron }): { etsy: boolean; app: boolean } {
  const etsy = env.NEXUS_ENABLE_ETSY_REVIEWS_READ === '1'
  const app = env.NEXUS_ENABLE_REVIEW_APP_READ === '1'
  if (etsy) start.etsy()
  if (app) start.app()
  return { etsy, app }
}

export function stopShopReviewReads(): void {
  etsyTask?.stop()
  appTask?.stop()
  etsyTask = null
  appTask = null
}
