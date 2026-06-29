/**
 * H.5 — eBay feed-mode push poller.
 *
 * Runs every 2 minutes. Queries EbayPushJob rows stuck at SUBMITTED
 * (feed mode, taskId present, submitted within the last 24 hours) and
 * calls the eBay Sell Feed API to resolve them.
 *
 * Status mapping:
 *   eBay IN_QUEUE | IN_PROCESS  → leave SUBMITTED (update completedAt guard)
 *   eBay COMPLETED              → download result file, parse, set DONE|PARTIAL|FATAL
 *   eBay COMPLETED_WITH_ERROR   → same as COMPLETED (errors in the result file)
 *   eBay FAILED                 → set FATAL immediately
 *
 * Fires `ebay_push.status_changed` SSE event for every job whose status
 * advances so any open eBay flat-file tab can react in real time.
 *
 * Bounded at 10 jobs per tick to avoid eBay API hammering.
 * One failing job never aborts the rest of the tick.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { ebayAuthService } from '../services/ebay-auth.service.js'
import {
  getTaskStatus,
  downloadResultFile,
} from '../services/ebay-feed.service.js'
import { publishOrderEvent } from '../services/order-events.service.js'

const TICK_INTERVAL_MS = 120_000
const MAX_JOBS_PER_TICK = 10
const STALE_AFTER_HOURS = 24

let tickTimer: NodeJS.Timeout | null = null

// ── Result-file parser ─────────────────────────────────────────────────

interface PerSkuResult {
  sku: string
  status: 'PUSHED' | 'ERROR'
  message?: string
}

interface ParsedResult {
  status: 'DONE' | 'PARTIAL' | 'FATAL'
  pushed: number
  failed: number
  perSkuResults: PerSkuResult[]
}

function parseEbayResultFile(content: string): ParsedResult {
  if (!content.trim()) {
    return { status: 'DONE', pushed: 0, failed: 0, perSkuResults: [] }
  }

  // Try JSON first (single object summary from eBay)
  try {
    const json = JSON.parse(content) as Record<string, unknown>
    const successCount = (json.successCount as number | undefined) ?? 0
    const failureCount = (json.failureCount as number | undefined) ?? 0

    if (failureCount > 0 || json.errors) {
      const errors = (json.errors as Array<Record<string, unknown>> | undefined) ?? []
      const perSkuResults: PerSkuResult[] = errors.map((e) => ({
        sku: (e.sku ?? e.identifier ?? '') as string,
        status: 'ERROR' as const,
        message: (e.message ?? e.longMessage ?? '') as string,
      }))
      return {
        status: successCount > 0 ? 'PARTIAL' : 'FATAL',
        pushed: successCount,
        failed: failureCount || perSkuResults.length,
        perSkuResults,
      }
    }

    return { status: 'DONE', pushed: successCount, failed: 0, perSkuResults: [] }
  } catch {
    // Not a single JSON object — try NDJSON (line-by-line)
  }

  const lines = content.split('\n').filter(Boolean)
  const perSkuResults: PerSkuResult[] = []
  let pushed = 0
  let failed = 0

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const sku = (obj.sku ?? '') as string
      if (obj.status === 'FAILURE' || obj.error) {
        const errObj = obj.error as Record<string, unknown> | undefined
        perSkuResults.push({
          sku,
          status: 'ERROR',
          message: (errObj?.message ?? obj.message ?? '') as string,
        })
        failed++
      } else {
        perSkuResults.push({ sku, status: 'PUSHED' })
        pushed++
      }
    } catch {
      // skip malformed lines
    }
  }

  return {
    status: failed === 0 ? 'DONE' : pushed > 0 ? 'PARTIAL' : 'FATAL',
    pushed,
    failed,
    perSkuResults,
  }
}

// ── Core tick ──────────────────────────────────────────────────────────

export async function runEbayFeedPollTickOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_HOURS * 60 * 60 * 1000)

  const jobs = await prisma.ebayPushJob.findMany({
    where: {
      status: 'SUBMITTED',
      mode: 'feed',
      taskId: { not: null },
      submittedAt: { gte: cutoff },
    },
    orderBy: { submittedAt: 'asc' },
    take: MAX_JOBS_PER_TICK,
  })

  if (jobs.length === 0) return

  logger.debug(`[ebay-feed-poll] tick: ${jobs.length} SUBMITTED job(s) to poll`)

  // Resolve the eBay connection once per tick (shared across all jobs)
  const conn = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
  })

  if (!conn) {
    logger.warn('[ebay-feed-poll] no active eBay connection — skipping tick')
    return
  }

  let token: string
  try {
    token = await ebayAuthService.getValidToken(conn.id)
  } catch (err) {
    logger.error('[ebay-feed-poll] could not get eBay token — skipping tick', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  for (const job of jobs) {
    const taskId = job.taskId as string

    try {
      const taskStatus = await getTaskStatus(taskId, token)
      const ebayStatus = taskStatus.status?.toUpperCase() ?? 'UNKNOWN'

      logger.debug(`[ebay-feed-poll] job ${job.id} taskId=${taskId} eBayStatus=${ebayStatus}`)

      // Still pending — nothing to do this tick
      if (ebayStatus === 'IN_QUEUE' || ebayStatus === 'IN_PROCESS') {
        continue
      }

      let newStatus: string
      let pushed = job.pushed
      let failed = job.failed
      let perSkuResults = job.perSkuResults
      let errorMessage = job.errorMessage

      if (ebayStatus === 'FAILED') {
        newStatus = 'FATAL'
        errorMessage = 'eBay feed task reported FAILED'
      } else if (
        ebayStatus === 'COMPLETED' ||
        ebayStatus === 'COMPLETED_WITH_ERROR'
      ) {
        // Download and parse the result file
        let resultContent = ''
        try {
          resultContent = await downloadResultFile(taskId, token)
        } catch (downloadErr) {
          logger.warn(`[ebay-feed-poll] could not download result file for job ${job.id}`, {
            error: downloadErr instanceof Error ? downloadErr.message : String(downloadErr),
          })
        }

        const parsed = parseEbayResultFile(resultContent)
        newStatus = parsed.status
        pushed = parsed.pushed
        failed = parsed.failed
        perSkuResults = parsed.perSkuResults as unknown as typeof job.perSkuResults

        // If eBay itself reported errors but our file had none, trust eBay
        if (ebayStatus === 'COMPLETED_WITH_ERROR' && newStatus === 'DONE') {
          newStatus = 'PARTIAL'
          failed = (taskStatus.failureCount ?? 0)
          pushed = (taskStatus.summaryCount ?? 0) - failed
        }
      } else {
        // Unknown terminal status — treat as FATAL
        logger.warn(`[ebay-feed-poll] unknown eBay status "${ebayStatus}" for job ${job.id}, marking FATAL`)
        newStatus = 'FATAL'
        errorMessage = `Unexpected eBay feed status: ${ebayStatus}`
      }

      await prisma.ebayPushJob.update({
        where: { id: job.id },
        data: {
          status: newStatus,
          pushed,
          failed,
          perSkuResults,
          errorMessage,
          completedAt: new Date(),
        },
      })

      // Emit SSE so any open flat-file tab can react
      try {
        publishOrderEvent({
          type: 'ebay_push.status_changed',
          jobId: job.id,
          taskId,
          status: newStatus,
          pushed,
          failed,
          ts: Date.now(),
        })
      } catch (sseErr) {
        logger.warn(`[ebay-feed-poll] SSE emit failed for job ${job.id}`, {
          error: sseErr instanceof Error ? sseErr.message : String(sseErr),
        })
      }

      logger.info(`[ebay-feed-poll] job ${job.id} resolved: ${job.status} → ${newStatus} (pushed=${pushed} failed=${failed})`)
    } catch (err) {
      // One failing job must never abort the rest of the tick
      logger.error(`[ebay-feed-poll] error polling job ${job.id} (taskId=${taskId})`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// ── Cron lifecycle ─────────────────────────────────────────────────────

export function startEbayFeedPollCron(): void {
  if (tickTimer) return

  async function tick() {
    try {
      await runEbayFeedPollTickOnce()
    } catch (err) {
      logger.error('[ebay-feed-poll] cron tick failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    tickTimer = setTimeout(tick, TICK_INTERVAL_MS)
  }

  tickTimer = setTimeout(tick, TICK_INTERVAL_MS)
  logger.info('[ebay-feed-poll] cron started (interval=2min, maxPerTick=10)')
}

export function stopEbayFeedPollCron(): void {
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
}
