/**
 * HB.11 — Amazon listing-health / suppression ingest.
 *
 * Pulls `GET_MERCHANT_LISTINGS_DEFECT_DATA` per marketplace. Each row
 * in the report is a listing-level defect (SEARCH_SUPPRESSED, BLOCKED,
 * INCOMPLETE, etc.) with a SKU + defect-message + (sometimes) reason
 * code. We join each defect to the matching `ChannelListing` by
 * (channel='AMAZON', sku, marketplace=code) and upsert an
 * `AmazonSuppression` row.
 *
 * Resolution semantics:
 *   - A defect present in the latest report → row exists with
 *     resolvedAt=null.
 *   - A defect NOT present in the latest report but previously
 *     ingested → row gets resolvedAt=now.
 *
 * Defects without a matching ChannelListing are surfaced as warnings
 * (stale SKU, marketplace gap, etc.) — not silently dropped.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { fetchSpApiReport } from './sp-api-reports.service.js'
import { normalizeMarketplaceCode } from '../utils/marketplace-code.js'

function parseTsv(body: string): Array<Record<string, string>> {
  if (!body || body.length === 0) return []
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const headers = lines[0]!.split('\t').map((h) => h.trim())
  const out: Array<Record<string, string>> = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split('\t')
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = (cols[j] ?? '').trim()
    }
    out.push(row)
  }
  return out
}

function severityFromStatus(status: string): 'ERROR' | 'WARNING' | 'INFO' {
  const s = status.toUpperCase()
  if (s === 'BLOCKED' || s === 'INACTIVE') return 'ERROR'
  if (s === 'SEARCH_SUPPRESSED' || s === 'SUPPRESSED') return 'ERROR'
  if (s === 'INCOMPLETE') return 'WARNING'
  return 'INFO'
}

export interface SuppressionIngestResult {
  ranAt: string
  durationMs: number
  marketplaceId: string
  marketplaceCode: string
  rowsScanned: number
  defectsCreated: number
  defectsUpdated: number
  defectsResolved: number
  listingsUnmatched: number
  errors: string[]
}

export interface MultiMarketplaceSuppressionResult {
  ranAt: string
  durationMs: number
  perMarketplace: SuppressionIngestResult[]
  totals: {
    rowsScanned: number
    defectsCreated: number
    defectsUpdated: number
    defectsResolved: number
    listingsUnmatched: number
  }
}

/**
 * Ingest defect/suppression data for a single marketplace.
 */
export async function ingestAmazonSuppressionForMarketplace(args: {
  marketplaceId: string
  marketplaceCode: string
  /** How far back the SP-API report should look. Suppression reports
   *  are listing-state snapshots so the window mostly controls how
   *  much "history" is captured. Default 30 days. */
  daysBack?: number
}): Promise<SuppressionIngestResult> {
  const t0 = Date.now()
  const daysBack = args.daysBack ?? 30
  const errors: string[] = []
  let rowsScanned = 0
  let defectsCreated = 0
  let defectsUpdated = 0
  let defectsResolved = 0
  let listingsUnmatched = 0

  const dataEndTime = new Date()
  const dataStartTime = new Date(dataEndTime.getTime() - daysBack * 24 * 60 * 60 * 1000)

  // Fetch the defect report
  let payload = ''
  try {
    const result = await fetchSpApiReport<string>({
      reportType: 'GET_MERCHANT_LISTINGS_DEFECT_DATA',
      marketplaceId: args.marketplaceId,
      dataStartTime,
      dataEndTime,
    })
    payload = typeof result.payload === 'string' ? result.payload : ''
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`fetch failed: ${msg}`)
    logger.warn('amazon-suppression: report fetch failed', {
      marketplace: args.marketplaceCode, error: msg,
    })
    return {
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      marketplaceId: args.marketplaceId,
      marketplaceCode: args.marketplaceCode,
      rowsScanned: 0,
      defectsCreated: 0,
      defectsUpdated: 0,
      defectsResolved: 0,
      listingsUnmatched: 0,
      errors,
    }
  }

  const rows = parseTsv(payload)
  rowsScanned = rows.length

  // Track which (listingId, reasonCode|reasonText) pairs were observed
  // this run — anything previously open but not in this set is
  // considered resolved.
  const observedKeys = new Set<string>()

  for (const row of rows) {
    try {
      const sku = row['seller-sku'] ?? row['SKU'] ?? row['sku'] ?? null
      const defectType = row['defect-type']
        ?? row['Defect Type']
        ?? row['issue-type']
        ?? row['status']
        ?? 'UNKNOWN'
      const defectMessage = row['defect-description']
        ?? row['defect-message']
        ?? row['Defect Message']
        ?? row['error-message']
        ?? defectType
      const reasonCode = row['defect-code'] ?? row['Defect Code'] ?? defectType
      const severity = severityFromStatus(row['status'] ?? defectType)

      if (!sku) continue

      // Find the ChannelListing by (channel, marketplace, product.sku).
      // SKU lives on the linked Product, not on ChannelListing directly.
      const listing = await prisma.channelListing.findFirst({
        where: {
          channel: 'AMAZON',
          marketplace: args.marketplaceCode,
          product: { sku },
        },
        select: { id: true },
      })
      if (!listing) {
        listingsUnmatched++
        if (errors.length < 20) {
          errors.push(`unmatched listing: sku=${sku} marketplace=${args.marketplaceCode}`)
        }
        continue
      }

      const key = `${listing.id}|${reasonCode}|${defectType}`
      observedKeys.add(key)

      // Upsert by (listingId, reasonCode, suppressedAt) — but our schema
      // doesn't have a composite unique index. Use findFirst + branch.
      const existing = await prisma.amazonSuppression.findFirst({
        where: {
          listingId: listing.id,
          reasonCode,
          resolvedAt: null,
        },
        select: { id: true, reasonText: true },
      })
      if (existing) {
        // Still open — refresh reasonText in case Amazon's wording changed.
        if (existing.reasonText !== defectMessage) {
          await prisma.amazonSuppression.update({
            where: { id: existing.id },
            data: { reasonText: defectMessage, severity, source: 'sp-api-poll' },
          })
        }
        defectsUpdated++
      } else {
        await prisma.amazonSuppression.create({
          data: {
            listingId: listing.id,
            reasonCode,
            reasonText: defectMessage,
            severity,
            source: 'sp-api-poll',
          },
        })
        defectsCreated++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (errors.length < 20) errors.push(`row error: ${msg.slice(0, 200)}`)
    }
  }

  // Resolution pass: any open suppression for an Amazon listing in this
  // marketplace whose (listingId, reasonCode, defectType) is not in
  // observedKeys → mark resolved.
  const openSuppressions = await prisma.amazonSuppression.findMany({
    where: {
      resolvedAt: null,
      source: 'sp-api-poll',
      channelListing: {
        channel: 'AMAZON',
        marketplace: args.marketplaceCode,
      },
    },
    select: { id: true, listingId: true, reasonCode: true },
  })
  const now = new Date()
  for (const s of openSuppressions) {
    const key = `${s.listingId}|${s.reasonCode}|${s.reasonCode}`
    if (!observedKeys.has(key)) {
      // Match by any prefix on the listingId|reasonCode pair (we don't
      // have defectType on the persisted row).
      const matchPrefix = `${s.listingId}|${s.reasonCode}|`
      let isResolved = true
      for (const k of observedKeys) {
        if (k.startsWith(matchPrefix)) { isResolved = false; break }
      }
      if (isResolved) {
        await prisma.amazonSuppression.update({
          where: { id: s.id },
          data: { resolvedAt: now },
        })
        defectsResolved++
      }
    }
  }

  const durationMs = Date.now() - t0
  logger.info('[amazon-suppression] ingest complete', {
    marketplace: args.marketplaceCode,
    rowsScanned, defectsCreated, defectsUpdated, defectsResolved,
    listingsUnmatched, errorCount: errors.length, durationMs,
  })

  return {
    ranAt: new Date().toISOString(),
    durationMs,
    marketplaceId: args.marketplaceId,
    marketplaceCode: args.marketplaceCode,
    rowsScanned,
    defectsCreated,
    defectsUpdated,
    defectsResolved,
    listingsUnmatched,
    errors,
  }
}

/**
 * Fan out across every participating Amazon marketplace.
 */
export async function ingestAmazonSuppressionAllMarketplaces(args: {
  daysBack?: number
  /** HB.11.1 — restrict to specific 2-letter codes; default = all
   *  isParticipating Amazon markets. Per-market is the recommended
   *  pattern: each marketplace's defect-report fetch can take 30-120s
   *  server-side, so 8 markets in sequence exceeds Railway's gateway. */
  marketplaceCodes?: string[]
} = {}): Promise<MultiMarketplaceSuppressionResult> {
  const t0 = Date.now()
  const where: {
    channel: string
    isActive: boolean
    isParticipating: boolean
    marketplaceId: { not: null }
    code?: { in: string[] }
  } = {
    channel: 'AMAZON',
    isActive: true,
    isParticipating: true,
    marketplaceId: { not: null },
  }
  if (args.marketplaceCodes && args.marketplaceCodes.length > 0) {
    where.code = { in: args.marketplaceCodes.map((c) => c.toUpperCase()) }
  }
  const markets = await prisma.marketplace.findMany({
    where,
    select: { code: true, marketplaceId: true },
    orderBy: { code: 'asc' },
  })

  const perMarketplace: SuppressionIngestResult[] = []
  const totals = {
    rowsScanned: 0, defectsCreated: 0, defectsUpdated: 0,
    defectsResolved: 0, listingsUnmatched: 0,
  }

  for (const m of markets) {
    if (!m.marketplaceId) continue
    const code = normalizeMarketplaceCode(m.marketplaceId, m.code)
    const r = await ingestAmazonSuppressionForMarketplace({
      marketplaceId: m.marketplaceId,
      marketplaceCode: code,
      daysBack: args.daysBack,
    })
    perMarketplace.push(r)
    totals.rowsScanned += r.rowsScanned
    totals.defectsCreated += r.defectsCreated
    totals.defectsUpdated += r.defectsUpdated
    totals.defectsResolved += r.defectsResolved
    totals.listingsUnmatched += r.listingsUnmatched
  }

  return {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    perMarketplace,
    totals,
  }
}
