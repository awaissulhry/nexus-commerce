/**
 * HB.1 (TECH_DEBT historical backfill) — Amazon Ads 24-month backfill.
 *
 * Walks a window (default 730 days) backward from today in 30-day chunks
 * and fires `runReportCreationCycle` + `runSearchTermReportCycle` +
 * `runPlacementReportCycle` for each chunk. Each cycle fans out across
 * every active AmazonAdsConnection profile, creating one report job per
 * (profile × adProduct × reportType × window).
 *
 * The orchestrator is FIRE-AND-FORGET — it doesn't wait for jobs to
 * complete. The existing crons handle the rest:
 *   - `ads-report-poll` (every 10 min) advances job status
 *   - `ads-report-ingest` (every 15 min) downloads completed reports
 *     from S3 and writes them to DB
 *
 * Operator can call this once to seed a 24-month history, then check
 * back over the next 30-60 minutes as the existing pipeline drains
 * thousands of jobs. Total wall-clock to full ingestion depends on
 * Amazon Ads API processing time per report (typically 1-5 min per).
 *
 * Why 30-day chunks: Amazon Ads Reports API has a hard 31-day limit
 * per single report request. 30 keeps us safely under.
 *
 * Why fire-and-forget: a 24-month backfill creates ~24 windows ×
 * ~9 profiles × ~3 report types = ~650 jobs. Waiting synchronously
 * would block the request for hours. Each job is independently
 * traceable via AmazonAdsReportJob row.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  runReportCreationCycle,
  runSearchTermReportCycle,
  runPlacementReportCycle,
  type AdProduct,
} from './ads-reports.service.js'

/** Amazon Ads Reports API hard limit: 31 days per request. Stay safely under. */
const CHUNK_DAYS = 30

export type AdsBackfillReportSet = 'campaign' | 'searchTerm' | 'placement'

export interface AdsBackfillInput {
  /** Total days to walk backward from today. Default 730 (24 months). */
  daysBack?: number
  /** Which report sets to backfill. Default: all three. */
  reportSets?: AdsBackfillReportSet[]
  /** Which ad products to include in each report set. Default: all three SP/SB/SD. */
  adProducts?: AdProduct[]
}

export interface AdsBackfillResult {
  ranAt: string
  durationMs: number
  daysBack: number
  windows: number
  reportSets: AdsBackfillReportSet[]
  totalJobsCreated: number
  totalJobsSkipped: number
  perReportSet: Record<AdsBackfillReportSet, { created: number; skipped: number; errors: number }>
  perWindow: Array<{
    startDate: string
    endDate: string
    created: number
    skipped: number
    errors: number
  }>
  warnings: string[]
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function chunkRanges(
  daysBack: number,
  chunkDays: number,
): Array<{ startDate: string; endDate: string }> {
  const chunks: Array<{ startDate: string; endDate: string }> = []
  // Anchor: yesterday (Amazon Ads API doesn't have today's data complete yet).
  const today = new Date()
  const anchor = new Date(today)
  anchor.setUTCDate(anchor.getUTCDate() - 1)

  let cursor = new Date(anchor)
  let remaining = daysBack
  while (remaining > 0) {
    const span = Math.min(chunkDays, remaining)
    const end = new Date(cursor)
    const start = new Date(cursor)
    start.setUTCDate(start.getUTCDate() - (span - 1))
    chunks.push({ startDate: toIsoDate(start), endDate: toIsoDate(end) })
    cursor = new Date(start)
    cursor.setUTCDate(cursor.getUTCDate() - 1)
    remaining -= span
  }
  return chunks
}

export async function runAdsBackfill(
  input: AdsBackfillInput = {},
): Promise<AdsBackfillResult> {
  const t0 = Date.now()
  const daysBack = input.daysBack ?? 730
  const reportSets = input.reportSets ?? ['campaign', 'searchTerm', 'placement']
  const adProducts = input.adProducts ?? ['SPONSORED_PRODUCTS', 'SPONSORED_DISPLAY', 'SPONSORED_BRANDS']

  // Refuse to start if no active profiles — likely auth lapsed.
  const profileCount = await prisma.amazonAdsConnection.count({ where: { isActive: true } })
  if (profileCount === 0) {
    throw new Error(
      'No active AmazonAdsConnection rows — operator must reconnect Amazon Ads OAuth before backfill.',
    )
  }

  const warnings: string[] = []
  if (daysBack > 730) {
    warnings.push(
      `daysBack=${daysBack} exceeds typical Amazon Ads retention (730d). Older windows may return empty reports.`,
    )
  }

  const windows = chunkRanges(daysBack, CHUNK_DAYS)
  const perWindow: AdsBackfillResult['perWindow'] = []
  const perReportSet: AdsBackfillResult['perReportSet'] = {
    campaign: { created: 0, skipped: 0, errors: 0 },
    searchTerm: { created: 0, skipped: 0, errors: 0 },
    placement: { created: 0, skipped: 0, errors: 0 },
  }

  let totalJobsCreated = 0
  let totalJobsSkipped = 0

  for (const window of windows) {
    let windowCreated = 0
    let windowSkipped = 0
    let windowErrors = 0

    for (const set of reportSets) {
      try {
        let result
        if (set === 'campaign') {
          result = await runReportCreationCycle({
            startDate: window.startDate,
            endDate: window.endDate,
            adProducts,
          })
        } else if (set === 'searchTerm') {
          result = await runSearchTermReportCycle({
            startDate: window.startDate,
            endDate: window.endDate,
            adProducts,
          })
        } else {
          result = await runPlacementReportCycle({
            startDate: window.startDate,
            endDate: window.endDate,
          })
        }
        perReportSet[set].created += result.jobsCreated
        perReportSet[set].skipped += result.jobsSkipped
        perReportSet[set].errors += result.errors.length
        windowCreated += result.jobsCreated
        windowSkipped += result.jobsSkipped
        windowErrors += result.errors.length
        if (result.errors.length > 0) {
          for (const err of result.errors.slice(0, 3)) {
            warnings.push(`[${window.startDate}..${window.endDate}/${set}] ${err}`)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        windowErrors++
        warnings.push(`[${window.startDate}..${window.endDate}/${set}] orchestrator failed: ${msg}`)
        logger.error('ads-backfill: window failed', { window, set, error: msg })
      }
    }

    perWindow.push({
      startDate: window.startDate,
      endDate: window.endDate,
      created: windowCreated,
      skipped: windowSkipped,
      errors: windowErrors,
    })
    totalJobsCreated += windowCreated
    totalJobsSkipped += windowSkipped
  }

  const durationMs = Date.now() - t0
  logger.info('[ads-backfill] complete', {
    daysBack,
    windows: windows.length,
    totalJobsCreated,
    totalJobsSkipped,
    warnings: warnings.length,
    durationMs,
  })

  return {
    ranAt: new Date().toISOString(),
    durationMs,
    daysBack,
    windows: windows.length,
    reportSets,
    totalJobsCreated,
    totalJobsSkipped,
    perReportSet,
    perWindow,
    warnings,
  }
}
