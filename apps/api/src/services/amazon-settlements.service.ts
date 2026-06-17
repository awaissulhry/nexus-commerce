/**
 * Phase 6.B — Amazon SP-API settlement reports ingester.
 *
 * Bank-reconciliation surface. Settlement reports are auto-published
 * by Amazon every ~7-14 days per marketplace; we LIST already-published
 * reports (no createReport needed), DOWNLOAD each via getReportDocument,
 * parse the summary row, and upsert into SettlementReport.
 *
 * Idempotent — re-syncing the same window is a no-op (skips reports
 * whose reportId is already in the table).
 *
 * Flat-file format reference (Amazon):
 *   Tab-separated. First row = header. Second row = settlement summary
 *   (rolled-up totals + deposit info). Rows 3..N = per-transaction lines
 *   (one per order item, fee, refund, adjustment, etc.).
 *
 * We extract the summary row to populate the typed columns and preserve
 * the full body in `rawBody` for future per-line reconciliation features.
 */

import { SellingPartner } from 'amazon-sp-api'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { instrumentSellingPartner } from './outbound-api-call-log.service.js'

const SETTLEMENT_REPORT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'

let cachedClient: SellingPartner | null = null

function getClient(): SellingPartner {
  if (cachedClient) return cachedClient

  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'amazon-settlements: missing required LWA env vars ' +
        '(AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN)',
    )
  }

  const region = (process.env.AMAZON_REGION ?? 'eu') as 'eu' | 'na' | 'fe'

  cachedClient = new SellingPartner({
    region,
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
    },
    options: {
      auto_request_tokens: true,
      auto_request_throttled: true,
    },
  } as any)

  instrumentSellingPartner(cachedClient as never, {
    channel: 'AMAZON',
    triggeredBy: 'cron',
  })

  return cachedClient
}

export interface ReportListItem {
  reportId: string
  reportType?: string
  reportDocumentId?: string
  createdTime?: string
  dataStartTime?: string
  dataEndTime?: string
  processingStatus?: string
  marketplaceIds?: string[]
}

/**
 * List settlement reports published by Amazon within the given window.
 * Paginates via nextToken; capped at 500 reports per call to keep memory
 * bounded (a 24-month window typically yields ~104 reports per marketplace).
 */
export async function listSettlementReports(opts: {
  marketplaceId: string
  from: Date
  to: Date
  maxReports?: number
}): Promise<ReportListItem[]> {
  const sp = getClient()
  const max = opts.maxReports ?? 500
  const results: ReportListItem[] = []
  let nextToken: string | undefined

  while (results.length < max) {
    const query: Record<string, unknown> = nextToken
      ? { nextToken }
      : {
          reportTypes: [SETTLEMENT_REPORT_TYPE],
          marketplaceIds: [opts.marketplaceId],
          createdSince: opts.from.toISOString(),
          createdUntil: opts.to.toISOString(),
          processingStatuses: ['DONE'],
          pageSize: 100,
        }

    const res: any = await (sp as any).callAPI({
      operation: 'getReports',
      endpoint: 'reports',
      query,
    })

    const reports: ReportListItem[] = res?.reports ?? []
    results.push(...reports)

    nextToken = res?.nextToken
    if (!nextToken) break
  }

  return results.slice(0, max)
}

/**
 * Download + decompress a report body. amazon-sp-api's `download()` handles
 * both gzip + plain responses transparently.
 */
export async function downloadReportBody(reportDocumentId: string): Promise<string> {
  const sp = getClient()
  const docRes: any = await (sp as any).callAPI({
    operation: 'getReportDocument',
    endpoint: 'reports',
    path: { reportDocumentId },
  })
  if (typeof docRes === 'string') return docRes
  return (await (sp as any).download(docRes)) as string
}

export interface ParsedSettlement {
  startDate: Date | null
  endDate: Date | null
  depositDate: Date | null
  totalAmount: number
  currencyCode: string
  transactionCount: number
}

/**
 * Parse the settlement-summary row out of the flat-file body. The summary
 * row is the FIRST data row (index 1, after header at index 0); it carries
 * the rolled-up totals + deposit info.
 *
 * Real-world flat files sometimes vary column order across marketplaces,
 * so we look up columns by name instead of position.
 */
export function parseSettlementSummary(rawBody: string): ParsedSettlement | null {
  const lines = rawBody.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return null

  const header = lines[0].split('\t')
  const idx = (col: string): number => header.indexOf(col)
  const summary = (lines[1] ?? '').split('\t')

  const safeDate = (v: string | undefined): Date | null => {
    if (!v) return null
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d
  }
  const cell = (col: string): string | undefined => {
    const i = idx(col)
    return i >= 0 ? summary[i] : undefined
  }

  const startDate = safeDate(cell('settlement-start-date'))
  const endDate = safeDate(cell('settlement-end-date'))
  const depositDate = safeDate(cell('deposit-date'))
  const totalAmount = parseFloat(cell('total-amount') ?? '0') || 0
  const currencyCode = cell('currency') || 'EUR'

  // transactionCount = body lines minus header + summary
  const transactionCount = Math.max(0, lines.length - 2)

  return { startDate, endDate, depositDate, totalAmount, currencyCode, transactionCount }
}

// ── R1.3 — settlement fee lines (storage + other fees) ─────────────────
// The summary row gives the deposit total; the PER-TRANSACTION lines carry
// the real fee breakdown (storage, long-term storage, etc.) that's been
// stored in rawBody but never parsed. Fees are stored as negative amounts;
// we report magnitudes.

export interface SettlementFeeBreakdown {
  storageEur: number
  longTermStorageEur: number
  /** Every distinct amount-description → summed magnitude (top fees). */
  byDescription: Record<string, number>
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function parseSettlementFeeLines(rawBody: string): SettlementFeeBreakdown {
  const lines = rawBody.split('\n').map((l) => l.trim()).filter(Boolean)
  const empty: SettlementFeeBreakdown = {
    storageEur: 0,
    longTermStorageEur: 0,
    byDescription: {},
  }
  if (lines.length < 2) return empty
  const header = lines[0].split('\t')
  const descIdx = header.indexOf('amount-description')
  const amtIdx = header.indexOf('amount')
  if (descIdx < 0 || amtIdx < 0) return empty

  let storage = 0
  let lts = 0
  const byDescription: Record<string, number> = {}
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const desc = (cols[descIdx] ?? '').trim()
    if (!desc) continue
    const amt = Math.abs(parseFloat(cols[amtIdx] ?? '0') || 0)
    if (amt === 0) continue
    const d = desc.toLowerCase()
    if (d.includes('long') && d.includes('storage')) lts += amt
    else if (d.includes('storage')) storage += amt
    byDescription[desc] = r2((byDescription[desc] ?? 0) + amt)
  }
  return { storageEur: r2(storage), longTermStorageEur: r2(lts), byDescription }
}

export interface SettlementFeeSummary {
  settlements: number
  totalStorageEur: number
  totalLongTermStorageEur: number
  /** Top fee descriptions across settlements (magnitude desc). */
  topFees: { description: string; amountEur: number }[]
  periods: {
    startDate: Date | null
    endDate: Date | null
    storageEur: number
    longTermStorageEur: number
  }[]
}

/** Parse storage (+ all) fees out of recent settlements' rawBody. */
export async function getSettlementFeeSummary(
  days = 180,
): Promise<SettlementFeeSummary> {
  const since = new Date(Date.now() - days * 86_400_000)
  const settlements = await prisma.settlementReport.findMany({
    where: { OR: [{ endDate: { gte: since } }, { depositDate: { gte: since } }] },
    select: { startDate: true, endDate: true, rawBody: true },
    orderBy: { endDate: 'desc' },
  })
  let totalStorage = 0
  let totalLts = 0
  const merged: Record<string, number> = {}
  const periods: SettlementFeeSummary['periods'] = []
  for (const s of settlements) {
    if (!s.rawBody) continue
    const f = parseSettlementFeeLines(s.rawBody)
    totalStorage += f.storageEur
    totalLts += f.longTermStorageEur
    for (const [k, v] of Object.entries(f.byDescription))
      merged[k] = r2((merged[k] ?? 0) + v)
    periods.push({
      startDate: s.startDate,
      endDate: s.endDate,
      storageEur: f.storageEur,
      longTermStorageEur: f.longTermStorageEur,
    })
  }
  const topFees = Object.entries(merged)
    .map(([description, amountEur]) => ({ description, amountEur }))
    .sort((a, b) => b.amountEur - a.amountEur)
    .slice(0, 12)
  return {
    settlements: settlements.length,
    totalStorageEur: r2(totalStorage),
    totalLongTermStorageEur: r2(totalLts),
    topFees,
    periods,
  }
}

export interface SyncMarketplaceResult {
  marketplaceId: string
  reportsListed: number
  reportsUpserted: number
  reportsSkippedExisting: number
  errors: Array<{ reportId: string; error: string }>
}

export interface SyncSettlementsResult {
  startedAt: Date
  completedAt: Date
  durationMs: number
  perMarketplace: SyncMarketplaceResult[]
  totals: {
    reportsListed: number
    reportsUpserted: number
    reportsSkippedExisting: number
    errors: number
  }
}

/**
 * Sync settlement reports for the given window across the given marketplaces
 * (defaults to every active AMAZON Marketplace with a marketplaceId set).
 * storeRawBody=true (default) preserves the full flat-file body for future
 * per-line reconciliation.
 */
export async function syncSettlementReports(opts: {
  from: Date
  to: Date
  marketplaceIds?: string[]
  storeRawBody?: boolean
}): Promise<SyncSettlementsResult> {
  const startedAt = new Date()
  const storeRaw = opts.storeRawBody !== false

  // Default: every active AMAZON marketplace with an SP-API ID
  const marketplaceIds =
    opts.marketplaceIds ??
    (
      await prisma.marketplace.findMany({
        where: { channel: 'AMAZON', isActive: true, marketplaceId: { not: null } },
        select: { marketplaceId: true },
      })
    )
      .map((m) => m.marketplaceId)
      .filter((id): id is string => !!id)

  const perMarketplace: SyncMarketplaceResult[] = []

  for (const mid of marketplaceIds) {
    const result: SyncMarketplaceResult = {
      marketplaceId: mid,
      reportsListed: 0,
      reportsUpserted: 0,
      reportsSkippedExisting: 0,
      errors: [],
    }

    try {
      const reports = await listSettlementReports({
        marketplaceId: mid,
        from: opts.from,
        to: opts.to,
      })
      result.reportsListed = reports.length

      for (const r of reports) {
        try {
          // Skip if already ingested — idempotent
          const existing = await (prisma as any).settlementReport.findUnique({
            where: { reportId: r.reportId },
          })
          if (existing) {
            result.reportsSkippedExisting++
            continue
          }

          // Download + parse (skip download if no documentId — shouldn't happen for DONE reports)
          let rawBody = ''
          if (r.reportDocumentId) {
            rawBody = await downloadReportBody(r.reportDocumentId)
          }
          const parsed = rawBody ? parseSettlementSummary(rawBody) : null

          await (prisma as any).settlementReport.create({
            data: {
              reportId: r.reportId,
              documentId: r.reportDocumentId ?? null,
              reportType: r.reportType ?? SETTLEMENT_REPORT_TYPE,
              marketplaceId: mid,
              // Prefer parsed dates; fall back to report-level dates
              startDate:
                parsed?.startDate ??
                (r.dataStartTime ? new Date(r.dataStartTime) : new Date()),
              endDate:
                parsed?.endDate ??
                (r.dataEndTime ? new Date(r.dataEndTime) : new Date()),
              depositDate: parsed?.depositDate ?? null,
              totalAmount: parsed?.totalAmount ?? 0,
              currencyCode: parsed?.currencyCode ?? 'EUR',
              transactionCount: parsed?.transactionCount ?? 0,
              rawBody: storeRaw ? rawBody : null,
            },
          })

          result.reportsUpserted++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          result.errors.push({ reportId: r.reportId, error: msg })
          logger.warn('amazon-settlements: report upsert failed', {
            reportId: r.reportId,
            marketplaceId: mid,
            error: msg,
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push({ reportId: 'LIST', error: msg })
      logger.error('amazon-settlements: listSettlementReports failed', {
        marketplaceId: mid,
        error: msg,
      })
    }

    perMarketplace.push(result)
  }

  const completedAt = new Date()
  const totals = perMarketplace.reduce(
    (acc, r) => ({
      reportsListed: acc.reportsListed + r.reportsListed,
      reportsUpserted: acc.reportsUpserted + r.reportsUpserted,
      reportsSkippedExisting: acc.reportsSkippedExisting + r.reportsSkippedExisting,
      errors: acc.errors + r.errors.length,
    }),
    { reportsListed: 0, reportsUpserted: 0, reportsSkippedExisting: 0, errors: 0 },
  )

  logger.info('amazon-settlements: sync complete', {
    durationMs: completedAt.getTime() - startedAt.getTime(),
    marketplaceCount: marketplaceIds.length,
    ...totals,
  })

  return {
    startedAt,
    completedAt,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    perMarketplace,
    totals,
  }
}
