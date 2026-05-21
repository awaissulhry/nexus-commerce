/**
 * HB-series — historical backfill orchestrators for returns + settlements.
 *
 * Walks a configurable window (default 730 days = 24 months) backward
 * from today in 30-day chunks and fans out per-chunk + per-marketplace
 * to the existing single-window services:
 *   - pollAmazonReturns (FBM + FBA returns reports per marketplace)
 *   - syncSettlementReports (SP-API settlement reports per marketplace)
 *
 * Why 30-day chunks: SP-API report types have a typical 30-60 day
 * maximum window per request; 30 keeps us safely under any limit
 * and produces predictable per-chunk progress.
 *
 * Why per-marketplace fan-out: M1 participations confirmed 8 EU markets
 * + 1 untracked. Each marketplace gets its own SP-API call so per-market
 * data lands in the right rows (returns join to Order.marketplace;
 * settlements have their own marketplaceId column).
 *
 * Note on hard SP-API limits:
 *   - Settlement reports: only the ~90 most recent days are available
 *     from `getReports`. Older settlements literally can't be backfilled.
 *     The orchestrator still walks the full window but documents this
 *     gap upfront in the warnings.
 *   - Returns reports: 24 months is reachable.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { pollAmazonReturns } from './amazon-returns/ingest.service.js'

/** SP-API report-window safe limit. */
const CHUNK_DAYS = 30

interface ChunkWindow {
  startDate: Date
  endDate: Date
  startIso: string
  endIso: string
}

function chunkRanges(daysBack: number, chunkDays: number): ChunkWindow[] {
  const chunks: ChunkWindow[] = []
  const now = new Date()
  const anchor = new Date(now)
  anchor.setUTCDate(anchor.getUTCDate() - 1) // yesterday — SP-API doesn't have today complete

  let cursor = new Date(anchor)
  let remaining = daysBack
  while (remaining > 0) {
    const span = Math.min(chunkDays, remaining)
    const end = new Date(cursor)
    end.setUTCHours(23, 59, 59, 999)
    const start = new Date(cursor)
    start.setUTCDate(start.getUTCDate() - (span - 1))
    start.setUTCHours(0, 0, 0, 0)
    chunks.push({
      startDate: start,
      endDate: end,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    })
    cursor = new Date(start)
    cursor.setUTCDate(cursor.getUTCDate() - 1)
    remaining -= span
  }
  return chunks
}

/** Resolve list of participating Amazon marketplaces (M1 fan-out source). */
async function resolveTargetMarketplaces(
  override?: string[],
): Promise<Array<{ id: string; code: string }>> {
  if (override && override.length > 0) {
    const rows = await prisma.marketplace.findMany({
      where: {
        channel: 'AMAZON',
        marketplaceId: { in: override },
      },
      select: { code: true, marketplaceId: true },
    })
    return rows
      .filter((r): r is { code: string; marketplaceId: string } => Boolean(r.marketplaceId))
      .map((r) => ({ id: r.marketplaceId, code: r.code }))
  }
  const rows = await prisma.marketplace.findMany({
    where: {
      channel: 'AMAZON',
      isActive: true,
      isParticipating: true,
      marketplaceId: { not: null },
    },
    select: { code: true, marketplaceId: true },
    orderBy: { code: 'asc' },
  })
  return rows
    .filter((r): r is { code: string; marketplaceId: string } => Boolean(r.marketplaceId))
    .map((r) => ({ id: r.marketplaceId, code: r.code }))
}

// ─── Returns backfill ─────────────────────────────────────────────────

export interface ReturnsBackfillInput {
  daysBack?: number
  marketplaceIds?: string[]
}

export interface ReturnsBackfillResult {
  ranAt: string
  durationMs: number
  daysBack: number
  windows: number
  marketplaces: Array<{ id: string; code: string }>
  totals: {
    fbmCreated: number
    fbmDuplicate: number
    fbmNoLines: number
    fbmFailed: number
    fbmRowsScanned: number
    fbaCreated: number
    fbaDuplicate: number
    fbaNoLines: number
    fbaFailed: number
    fbaRowsScanned: number
  }
  perChunk: Array<{
    startDate: string
    endDate: string
    marketplaceCode: string
    fbmCreated: number
    fbaCreated: number
    failed: number
  }>
  warnings: string[]
}

export async function runReturnsBackfill(
  input: ReturnsBackfillInput = {},
): Promise<ReturnsBackfillResult> {
  const t0 = Date.now()
  const daysBack = input.daysBack ?? 730
  const marketplaces = await resolveTargetMarketplaces(input.marketplaceIds)
  if (marketplaces.length === 0) {
    throw new Error(
      'No target marketplaces — pass marketplaceIds in body or run POST /api/amazon/participations/refresh first',
    )
  }

  const windows = chunkRanges(daysBack, CHUNK_DAYS)
  const totals: ReturnsBackfillResult['totals'] = {
    fbmCreated: 0, fbmDuplicate: 0, fbmNoLines: 0, fbmFailed: 0, fbmRowsScanned: 0,
    fbaCreated: 0, fbaDuplicate: 0, fbaNoLines: 0, fbaFailed: 0, fbaRowsScanned: 0,
  }
  const perChunk: ReturnsBackfillResult['perChunk'] = []
  const warnings: string[] = []

  for (const window of windows) {
    for (const market of marketplaces) {
      try {
        const r = await pollAmazonReturns({
          dataStartTime: window.startDate,
          dataEndTime: window.endDate,
          marketplaceId: market.id,
        })
        totals.fbmCreated += r.fbmCreated
        totals.fbmDuplicate += r.fbmDuplicate
        totals.fbmNoLines += r.fbmNoLines
        totals.fbmFailed += r.fbmFailed
        totals.fbmRowsScanned += r.fbmRowsScanned
        totals.fbaCreated += r.fbaCreated
        totals.fbaDuplicate += r.fbaDuplicate
        totals.fbaNoLines += r.fbaNoLines
        totals.fbaFailed += r.fbaFailed
        totals.fbaRowsScanned += r.fbaRowsScanned
        perChunk.push({
          startDate: window.startIso,
          endDate: window.endIso,
          marketplaceCode: market.code,
          fbmCreated: r.fbmCreated,
          fbaCreated: r.fbaCreated,
          failed: r.fbmFailed + r.fbaFailed,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        warnings.push(`[${window.startIso.slice(0, 10)}..${window.endIso.slice(0, 10)}/${market.code}] ${msg}`)
        logger.warn('historical-backfill: returns chunk failed', {
          window: window.startIso, market: market.code, error: msg,
        })
      }
    }
  }

  const durationMs = Date.now() - t0
  logger.info('[historical-backfill] returns complete', {
    daysBack, windows: windows.length, totals, warnings: warnings.length, durationMs,
  })

  return {
    ranAt: new Date().toISOString(),
    durationMs,
    daysBack,
    windows: windows.length,
    marketplaces,
    totals,
    perChunk,
    warnings,
  }
}

// ─── Settlements backfill ─────────────────────────────────────────────

export interface SettlementsBackfillInput {
  daysBack?: number
  marketplaceIds?: string[]
  storeRawBody?: boolean
}

export interface SettlementsBackfillResult {
  ranAt: string
  durationMs: number
  daysBack: number
  windows: number
  marketplaces: Array<{ id: string; code: string }>
  /** Sum across chunks (each chunk reports its own reports-found/upserted counters). */
  totalReportsFound: number
  totalReportsUpserted: number
  perChunk: Array<{
    startDate: string
    endDate: string
    reportsFound: number
    reportsUpserted: number
  }>
  warnings: string[]
}

export async function runSettlementsBackfill(
  input: SettlementsBackfillInput = {},
): Promise<SettlementsBackfillResult> {
  const t0 = Date.now()
  const daysBack = input.daysBack ?? 730
  const marketplaces = await resolveTargetMarketplaces(input.marketplaceIds)
  if (marketplaces.length === 0) {
    throw new Error(
      'No target marketplaces — pass marketplaceIds in body or run POST /api/amazon/participations/refresh first',
    )
  }

  const warnings: string[] = []
  // SP-API hard limit warning — settlement reports older than ~90 days
  // simply aren't listed by getReports. Don't surprise the operator.
  if (daysBack > 90) {
    warnings.push(
      `daysBack=${daysBack} exceeds Amazon's typical ~90-day settlement retention. Older windows will return zero reports.`,
    )
  }

  const { syncSettlementReports } = await import('./amazon-settlements.service.js')
  const windows = chunkRanges(daysBack, CHUNK_DAYS)
  const perChunk: SettlementsBackfillResult['perChunk'] = []
  let totalReportsFound = 0
  let totalReportsUpserted = 0

  for (const window of windows) {
    try {
      const summary = await syncSettlementReports({
        from: window.startDate,
        to: window.endDate,
        marketplaceIds: marketplaces.map((m) => m.id),
        storeRawBody: input.storeRawBody,
      })
      totalReportsFound += summary.totals.reportsListed
      totalReportsUpserted += summary.totals.reportsUpserted
      perChunk.push({
        startDate: window.startIso,
        endDate: window.endIso,
        reportsFound: summary.totals.reportsListed,
        reportsUpserted: summary.totals.reportsUpserted,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`[${window.startIso.slice(0, 10)}..${window.endIso.slice(0, 10)}] ${msg}`)
      logger.warn('historical-backfill: settlements chunk failed', {
        window: window.startIso, error: msg,
      })
    }
  }

  const durationMs = Date.now() - t0
  logger.info('[historical-backfill] settlements complete', {
    daysBack, windows: windows.length, totalReportsFound, totalReportsUpserted,
    warnings: warnings.length, durationMs,
  })

  return {
    ranAt: new Date().toISOString(),
    durationMs,
    daysBack,
    windows: windows.length,
    marketplaces,
    totalReportsFound,
    totalReportsUpserted,
    perChunk,
    warnings,
  }
}
