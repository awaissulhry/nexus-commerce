/**
 * R.8 — Amazon FBA Restock Inventory Recommendations integration.
 *
 * Three responsibilities:
 *   1. Request + ingest Amazon's GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT
 *      via the existing sp-api-reports.service.
 *   2. Parse the TSV body into FbaRestockRow records, idempotent on
 *      (sku, marketplace, reportId).
 *   3. Compare Amazon's qty vs our recommendation engine's qty,
 *      classifying the divergence so the UI can surface it.
 *
 * Pure functions (testable without DB / SP-API):
 *   - parseRestockTsv(text) → ParsedRow[]
 *   - compareRecommendations({ourQty, amazonQty, asOf, now, staleDays})
 *     → { status, deltaPct, isStale }
 *
 * I/O entrypoints:
 *   - ingestRestockReportForMarketplace(code, triggeredBy)
 *   - ingestRestockReportsForAllMarketplaces(triggeredBy)
 *   - getLatestRowForSku(sku, marketplaceId, staleDays)
 *   - loadLatestRowsForCohort(skus, marketplaceId, staleDays)
 *   - getStatusSummary()
 */

import { createHash } from 'node:crypto'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { fetchSpApiReport } from './sp-api-reports.service.js'
import { amazonMarketplaceId } from './categories/marketplace-ids.js'

const REPORT_TYPE = 'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT'
/** Default staleness cutoff — engine ignores Amazon rows older than this. */
export const DEFAULT_STALE_DAYS = 7

/** Marketplaces eligible for the daily ingestion cron. Xavia targets
 *  IT primarily but has presence in the wider EU; DE/FR/ES/NL all
 *  return useful signal even when sales are thin. Override per-env
 *  with FBA_RESTOCK_MARKETPLACES="IT,DE". */
export function eligibleMarketplaceCodes(): string[] {
  const env = process.env.FBA_RESTOCK_MARKETPLACES?.trim()
  if (env) return env.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  return ['IT', 'DE', 'FR', 'ES', 'NL']
}

// ─── Pure: TSV parser ──────────────────────────────────────────────

export interface ParsedRow {
  sku: string
  recommendedReplenishmentQty: number | null
  daysOfSupply: number | null
  recommendedShipDate: Date | null
  daysToInbound: number | null
  salesPace30dUnits: number | null
  salesShortageUnits: number | null
  alertType: string | null
}

/**
 * Parse Amazon's tab-separated Restock report. The exact column set
 * varies year-to-year so we look up by header name. Unknown columns
 * are ignored; missing columns yield null fields.
 */
export function parseRestockTsv(tsv: string): ParsedRow[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const header = lines[0].split('\t').map((h) => h.trim().toLowerCase())

  const idx = (...candidates: string[]): number => {
    for (const c of candidates) {
      const i = header.indexOf(c.toLowerCase())
      if (i >= 0) return i
    }
    return -1
  }

  const ixSku = idx('sku', 'merchant-sku', 'fnsku')
  const ixRecQty = idx(
    'recommended-replenishment-qty',
    'recommended-replenishment-quantity',
    'recommended-quantity',
  )
  const ixDos = idx('days-of-supply', 'days-of-coverage')
  const ixShipDate = idx('recommended-ship-date')
  const ixDaysToInbound = idx('days-to-inbound')
  const ixPace30 = idx('sales-pace', 'sales-30d', 'forecasted-sales-30d')
  const ixShortage = idx('sales-shortage', 'forecasted-sales-shortage')
  const ixAlert = idx('alert', 'alert-type', 'recommended-action')

  if (ixSku < 0) return []

  const rows: ParsedRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const sku = cols[ixSku]?.trim()
    if (!sku) continue
    rows.push({
      sku,
      recommendedReplenishmentQty: parseIntOrNull(cols[ixRecQty]),
      daysOfSupply: parseFloatOrNull(cols[ixDos]),
      recommendedShipDate: parseDateOrNull(cols[ixShipDate]),
      daysToInbound: parseIntOrNull(cols[ixDaysToInbound]),
      salesPace30dUnits: parseIntOrNull(cols[ixPace30]),
      salesShortageUnits: parseIntOrNull(cols[ixShortage]),
      alertType: ixAlert >= 0 ? (cols[ixAlert]?.trim() || null) : null,
    })
  }
  return rows
}

function parseIntOrNull(s: string | undefined): number | null {
  if (s == null) return null
  const t = s.trim()
  if (!t) return null
  const n = Number(t.replace(/[, ]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : null
}

function parseFloatOrNull(s: string | undefined): number | null {
  if (s == null) return null
  const t = s.trim()
  if (!t) return null
  const n = Number(t.replace(/[, ]/g, ''))
  return Number.isFinite(n) ? n : null
}

function parseDateOrNull(s: string | undefined): Date | null {
  if (s == null) return null
  const t = s.trim()
  if (!t) return null
  const d = new Date(t)
  return Number.isFinite(d.getTime()) ? d : null
}

// ─── Pure: comparison ──────────────────────────────────────────────

export type ComparisonStatus =
  | 'ALIGNED' // |delta| < 20%
  | 'OUR_HIGHER' // we recommend more than Amazon (signal: Amazon-net demand softer than blended)
  | 'AMAZON_HIGHER' // Amazon recommends more than us (signal: Amazon sees demand we don't)
  | 'NO_AMAZON_SIGNAL' // no row or row is stale
  | 'AMAZON_ZERO' // Amazon explicitly says don't restock

export interface ComparisonResult {
  status: ComparisonStatus
  deltaPct: number | null
  /** absolute delta units, signed: +ve = Amazon higher */
  deltaUnits: number | null
  isStale: boolean
}

export function compareRecommendations(args: {
  ourQty: number
  amazonQty: number | null | undefined
  asOf: Date | null | undefined
  now?: Date
  staleDays?: number
  thresholdPct?: number
}): ComparisonResult {
  const now = args.now ?? new Date()
  const staleDays = args.staleDays ?? DEFAULT_STALE_DAYS
  const threshold = args.thresholdPct ?? 20

  if (args.amazonQty == null || args.asOf == null) {
    return { status: 'NO_AMAZON_SIGNAL', deltaPct: null, deltaUnits: null, isStale: false }
  }
  const ageMs = now.getTime() - args.asOf.getTime()
  const isStale = ageMs > staleDays * 86400000
  if (isStale) {
    return { status: 'NO_AMAZON_SIGNAL', deltaPct: null, deltaUnits: null, isStale: true }
  }
  if (args.amazonQty === 0 && args.ourQty > 0) {
    return {
      status: 'AMAZON_ZERO',
      deltaPct: -100,
      deltaUnits: -args.ourQty,
      isStale: false,
    }
  }

  // delta defined relative to our qty (avoid divide-by-zero):
  //   deltaPct = (amazon - ours) / max(ours, 1) × 100
  //   positive = Amazon recommends more
  const denom = Math.max(args.ourQty, 1)
  const deltaUnits = args.amazonQty - args.ourQty
  const deltaPct = (deltaUnits / denom) * 100

  if (Math.abs(deltaPct) < threshold) {
    return {
      status: 'ALIGNED',
      deltaPct: Number(deltaPct.toFixed(2)),
      deltaUnits,
      isStale: false,
    }
  }
  return {
    status: deltaPct > 0 ? 'AMAZON_HIGHER' : 'OUR_HIGHER',
    deltaPct: Number(deltaPct.toFixed(2)),
    deltaUnits,
    isStale: false,
  }
}

// ─── DB: ingestion ─────────────────────────────────────────────────

export interface IngestionResult {
  reportRecordId: string
  marketplace: string
  marketplaceCode: string
  status: 'DONE' | 'FATAL'
  rowCount: number
  durationMs: number
  errorMessage?: string
}

/**
 * Request + ingest the Restock report for a single marketplace.
 * Idempotent: re-running on the same Amazon report payload (matched
 * by sha256 digest) skips re-parsing and returns the existing record.
 */
export async function ingestRestockReportForMarketplace(args: {
  marketplaceCode: string
  triggeredBy: 'cron' | 'manual'
  /** History window the report covers — Amazon ignores for this report
   *  type but the SP-API call still requires the field. Default = last 30d. */
  windowDays?: number
}): Promise<IngestionResult> {
  const startedAt = Date.now()
  const code = args.marketplaceCode.toUpperCase()
  const marketplaceId = amazonMarketplaceId(code)
  const windowDays = args.windowDays ?? 30
  const now = new Date()
  const windowStart = new Date(now)
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays)

  const reportRecord = await prisma.fbaRestockReport.create({
    data: {
      marketplace: marketplaceId,
      marketplaceCode: code,
      status: 'REQUESTED',
      triggeredBy: args.triggeredBy,
    },
  })

  try {
    const fetched = await fetchSpApiReport<string>({
      reportType: REPORT_TYPE,
      marketplaceId,
      dataStartTime: windowStart,
      dataEndTime: now,
    })

    const tsv = typeof fetched.payload === 'string' ? fetched.payload : ''
    const digest = createHash('sha256').update(tsv).digest('hex')

    // De-dup: if a successful ingestion of the same digest exists for
    // this marketplace already, skip the parse + insert.
    const dup = await prisma.fbaRestockReport.findFirst({
      where: { marketplace: marketplaceId, payloadDigest: digest, status: 'DONE' },
      select: { id: true, rowCount: true, processedAt: true },
    })
    if (dup) {
      await prisma.fbaRestockReport.update({
        where: { id: reportRecord.id },
        data: {
          status: 'DONE',
          reportId: fetched.reportId,
          reportDocumentId: fetched.reportDocumentId,
          processedAt: new Date(),
          rowCount: 0,
          payloadDigest: digest,
          errorMessage: 'duplicate_payload — pointing at existing rows',
          durationMs: Date.now() - startedAt,
        },
      })
      logger.info('[fba-restock] duplicate payload, skipping reparse', {
        marketplace: code,
        existingReportId: dup.id,
      })
      return {
        reportRecordId: reportRecord.id,
        marketplace: marketplaceId,
        marketplaceCode: code,
        status: 'DONE',
        rowCount: dup.rowCount,
        durationMs: Date.now() - startedAt,
      }
    }

    const rows = parseRestockTsv(tsv)

    // Bulk insert with transaction. Idempotent — composite unique
    // (sku, marketplace, reportId) means re-running on the same
    // FbaRestockReport.id is a no-op.
    if (rows.length > 0) {
      await prisma.fbaRestockRow.createMany({
        data: rows.map((r) => ({
          reportId: reportRecord.id,
          sku: r.sku,
          marketplace: marketplaceId,
          recommendedReplenishmentQty: r.recommendedReplenishmentQty,
          daysOfSupply: r.daysOfSupply,
          recommendedShipDate: r.recommendedShipDate,
          daysToInbound: r.daysToInbound,
          salesPace30dUnits: r.salesPace30dUnits,
          salesShortageUnits: r.salesShortageUnits,
          alertType: r.alertType,
          asOf: new Date(),
        })),
        skipDuplicates: true,
      })
    }

    await prisma.fbaRestockReport.update({
      where: { id: reportRecord.id },
      data: {
        status: 'DONE',
        reportId: fetched.reportId,
        reportDocumentId: fetched.reportDocumentId,
        processedAt: new Date(),
        rowCount: rows.length,
        payloadDigest: digest,
        durationMs: Date.now() - startedAt,
      },
    })

    return {
      reportRecordId: reportRecord.id,
      marketplace: marketplaceId,
      marketplaceCode: code,
      status: 'DONE',
      rowCount: rows.length,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[fba-restock] ingestion failed', { marketplace: code, error: message })
    await prisma.fbaRestockReport.update({
      where: { id: reportRecord.id },
      data: {
        status: 'FATAL',
        errorMessage: message,
        durationMs: Date.now() - startedAt,
      },
    })
    return {
      reportRecordId: reportRecord.id,
      marketplace: marketplaceId,
      marketplaceCode: code,
      status: 'FATAL',
      rowCount: 0,
      durationMs: Date.now() - startedAt,
      errorMessage: message,
    }
  }
}

export async function ingestRestockReportsForAllMarketplaces(
  triggeredBy: 'cron' | 'manual',
): Promise<IngestionResult[]> {
  const codes = eligibleMarketplaceCodes()
  const out: IngestionResult[] = []
  for (const code of codes) {
    out.push(await ingestRestockReportForMarketplace({ marketplaceCode: code, triggeredBy }))
  }
  return out
}

// ─── DB: read helpers ──────────────────────────────────────────────

/**
 * Get the latest row for one (sku, marketplace) within the staleness
 * window. Returns null when nothing fresh exists. Used by the drawer
 * GET /by-sku endpoint.
 */
export async function getLatestRowForSku(args: {
  sku: string
  marketplaceId: string
  staleDays?: number
}) {
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - (args.staleDays ?? DEFAULT_STALE_DAYS))
  return prisma.fbaRestockRow.findFirst({
    where: {
      sku: args.sku,
      marketplace: args.marketplaceId,
      asOf: { gte: cutoff },
    },
    orderBy: { asOf: 'desc' },
    include: { report: { select: { processedAt: true, marketplaceCode: true } } },
  })
}

/**
 * Bulk loader for the recommendation engine. Returns a Map keyed by
 * `${sku}:${marketplaceId}` for O(1) lookup during the suggestions
 * loop. Excludes rows older than staleDays.
 */
export async function loadLatestRowsForCohort(args: {
  skus: string[]
  marketplaceIds: string[]
  staleDays?: number
}): Promise<
  Map<
    string,
    {
      sku: string
      marketplace: string
      recommendedReplenishmentQty: number | null
      daysOfSupply: number | null
      asOf: Date
    }
  >
> {
  const m = new Map<string, any>()
  if (args.skus.length === 0 || args.marketplaceIds.length === 0) return m
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - (args.staleDays ?? DEFAULT_STALE_DAYS))

  const rows = await prisma.fbaRestockRow.findMany({
    where: {
      sku: { in: args.skus },
      marketplace: { in: args.marketplaceIds },
      asOf: { gte: cutoff },
    },
    orderBy: { asOf: 'desc' },
    select: {
      sku: true,
      marketplace: true,
      recommendedReplenishmentQty: true,
      daysOfSupply: true,
      asOf: true,
    },
  })
  // Keep newest only per (sku, marketplace).
  for (const r of rows) {
    const key = `${r.sku}:${r.marketplace}`
    if (!m.has(key)) m.set(key, r)
  }
  return m
}

/**
 * Status summary for the page card. Returns last successful ingestion
 * timestamp + row count per marketplace + total cohort coverage.
 */
export async function getStatusSummary() {
  const codes = eligibleMarketplaceCodes()
  const marketplaceIds = codes.map((c) => amazonMarketplaceId(c))
  const latest = await prisma.fbaRestockReport.findMany({
    where: {
      marketplace: { in: marketplaceIds },
      status: 'DONE',
    },
    orderBy: { processedAt: 'desc' },
    select: {
      marketplace: true,
      marketplaceCode: true,
      processedAt: true,
      rowCount: true,
    },
  })
  const byCode = new Map<string, (typeof latest)[number]>()
  for (const r of latest) {
    if (!byCode.has(r.marketplaceCode)) byCode.set(r.marketplaceCode, r)
  }
  const items = codes.map((code) => {
    const r = byCode.get(code)
    return {
      marketplaceCode: code,
      marketplaceId: amazonMarketplaceId(code),
      lastIngestedAt: r?.processedAt ?? null,
      rowCount: r?.rowCount ?? 0,
      hasFreshData: !!(r?.processedAt && Date.now() - r.processedAt.getTime() < DEFAULT_STALE_DAYS * 86400000),
    }
  })
  return { items, staleDays: DEFAULT_STALE_DAYS }
}
