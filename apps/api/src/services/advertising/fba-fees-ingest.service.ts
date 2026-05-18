/**
 * AD.4 Step 6 — FBA Fulfillment Fees Ingestion.
 *
 * Pulls GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA from SP-API (TSV flat file),
 * parses the per-SKU fee estimates, and writes them to two places:
 *
 *   1. ChannelListing.estimatedFbaFee — per-unit fee stored on the listing
 *      for the pricing engine to use as a floor component.
 *
 *   2. ProductProfitDaily.fbaFulfillmentFeesCents — daily total for the
 *      True Profit rollup: fee × unitsSold for each (productId, marketplace,
 *      date) row in the requested window. Sets coverage.hasFbaFee = true.
 *
 * The report has no date dimension — it reflects current Amazon fee
 * estimates for each SKU. Run weekly (Sunday) is sufficient since fee
 * tiers change slowly (size-tier reclassifications, fee table updates).
 *
 * Requires: all SP-API env vars (AMAZON_LWA_*, AMAZON_REFRESH_TOKEN,
 * AWS_*). Falls back gracefully when SP-API is not configured — skips
 * with a warning rather than crashing the cron.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { fetchSpApiReport } from '../sp-api-reports.service.js'

// SP-API marketplace ID for Amazon IT (Xavia primary). For a multi-
// marketplace setup, loop over all active ChannelConnection marketplaceIds.
const DEFAULT_MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'

export interface FbaFeesIngestResult {
  skusFound: number
  listingsUpdated: number
  profitRowsUpdated: number
  skusUnmatched: string[]
  errors: string[]
  durationMs: number
}

// ── TSV parser ────────────────────────────────────────────────────────────────

interface FbaFeeRow {
  sku: string
  asin: string | null
  currency: string
  /** Total estimated FBA fulfillment fee per unit (not referral fee). */
  feePerUnit: number
}

function parseFbaFeesTsv(raw: string): FbaFeeRow[] {
  const lines = raw.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []

  const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase())
  const skuIdx  = headers.indexOf('sku')
  const asinIdx = headers.indexOf('asin')
  // Try the most specific fee column first; fall back to the total.
  const feeIdx  = [
    'expected-fulfillment-fee-per-unit',
    'estimated-fee-total',
    'your-estimated-fee-per-unit',
  ]
    .map((col) => headers.indexOf(col))
    .find((i) => i >= 0) ?? -1
  const currencyIdx = headers.indexOf('currency')

  if (skuIdx < 0 || feeIdx < 0) {
    logger.warn('[fba-fees-ingest] TSV missing sku or fee column', {
      found: headers.slice(0, 20),
    })
    return []
  }

  const rows: FbaFeeRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const sku  = cols[skuIdx]?.trim()
    if (!sku) continue
    const rawFee = parseFloat(cols[feeIdx]?.trim() ?? '0')
    if (isNaN(rawFee) || rawFee <= 0) continue
    rows.push({
      sku,
      asin:       asinIdx >= 0 ? (cols[asinIdx]?.trim() || null) : null,
      currency:   currencyIdx >= 0 ? (cols[currencyIdx]?.trim() || 'EUR') : 'EUR',
      feePerUnit: rawFee,
    })
  }
  return rows
}

// ── Main ingest function ──────────────────────────────────────────────────────

export async function runFbaFeesIngest(opts: {
  marketplaceId?: string
  /** Back-fill ProductProfitDaily for the last N days (default 30). */
  rollupWindowDays?: number
} = {}): Promise<FbaFeesIngestResult> {
  const start = Date.now()
  const marketplaceId = opts.marketplaceId ?? DEFAULT_MARKETPLACE_ID
  const rollupWindowDays = opts.rollupWindowDays ?? 30

  const result: FbaFeesIngestResult = {
    skusFound: 0, listingsUpdated: 0, profitRowsUpdated: 0,
    skusUnmatched: [], errors: [], durationMs: 0,
  }

  // ── Step 1: fetch the report ──────────────────────────────────────────────

  let tsvPayload: string
  try {
    const reportResult = await fetchSpApiReport<string>({
      reportType: 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA',
      marketplaceId,
      // This report ignores the date window — pass a nominal range.
      dataStartTime: new Date(Date.now() - 7 * 86_400_000),
      dataEndTime:   new Date(),
    })
    tsvPayload = typeof reportResult.payload === 'string'
      ? reportResult.payload
      : JSON.stringify(reportResult.payload)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('[fba-fees-ingest] SP-API report fetch failed — skipping', { error: msg })
    result.errors.push(`report_fetch: ${msg}`)
    result.durationMs = Date.now() - start
    return result
  }

  // ── Step 2: parse TSV ─────────────────────────────────────────────────────

  const feeRows = parseFbaFeesTsv(tsvPayload)
  result.skusFound = feeRows.length
  if (feeRows.length === 0) {
    logger.warn('[fba-fees-ingest] no rows parsed from TSV')
    result.durationMs = Date.now() - start
    return result
  }

  const feeMap = new Map<string, number>() // sku → feePerUnitCents
  for (const row of feeRows) {
    feeMap.set(row.sku, Math.round(row.feePerUnit * 100))
  }

  // ── Step 3: resolve SKUs → productIds via Product.sku ────────────────────

  const skus = [...feeMap.keys()]
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: { id: true, sku: true },
  })
  const skuToProductId = new Map(products.map((p) => [p.sku, p.id]))

  const unmatchedSkus = skus.filter((s) => !skuToProductId.has(s))
  if (unmatchedSkus.length > 0) {
    // Only log the first 10 to keep noise down
    result.skusUnmatched = unmatchedSkus.slice(0, 10)
    logger.debug('[fba-fees-ingest] unmatched SKUs', {
      count: unmatchedSkus.length,
      sample: unmatchedSkus.slice(0, 5),
    })
  }

  // ── Step 4: update ChannelListing.estimatedFbaFee ────────────────────────

  // Determine marketplace code from the SP-API marketplace ID
  const MARKETPLACE_ID_TO_CODE: Record<string, string> = {
    APJ6JRA9NG5V4:   'IT',
    A1PA6795UKMFR9:  'DE',
    A1F83G8C2ARO7P:  'UK',
    A13V1IB3VIYZZH:  'FR',
    APJ6JRA9NG5V4_ES: 'ES',
    A1RKKUPIHCS9HS:  'DE',
    ATVPDKIKX0DER:   'US',
  }
  const marketplaceCode = MARKETPLACE_ID_TO_CODE[marketplaceId] ?? 'IT'

  for (const [sku, feePerUnitCents] of feeMap) {
    const productId = skuToProductId.get(sku)
    if (!productId) continue
    try {
      const updated = await prisma.channelListing.updateMany({
        where: { productId, marketplace: marketplaceCode, channel: 'AMAZON' },
        data: { estimatedFbaFee: feePerUnitCents / 100 },
      })
      result.listingsUpdated += updated.count
    } catch (err) {
      result.errors.push(`listing_update:${sku}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Step 5: back-fill ProductProfitDaily.fbaFulfillmentFeesCents ─────────

  const since = new Date()
  since.setUTCDate(since.getUTCDate() - rollupWindowDays)
  since.setUTCHours(0, 0, 0, 0)

  for (const [sku, feePerUnitCents] of feeMap) {
    const productId = skuToProductId.get(sku)
    if (!productId) continue

    // Find all ProductProfitDaily rows for this product in the window
    const rows = await prisma.productProfitDaily.findMany({
      where: {
        productId,
        marketplace: marketplaceCode,
        date: { gte: since },
      },
      select: {
        id: true,
        unitsSold: true,
        grossRevenueCents: true,
        cogsCents: true,
        referralFeesCents: true,
        advertisingSpendCents: true,
        returnsRefundsCents: true,
        coverage: true,
      },
    })

    for (const row of rows) {
      const fbaFulfillmentFeesCents = feePerUnitCents * row.unitsSold
      const trueProfit =
        row.grossRevenueCents
        - row.cogsCents
        - row.referralFeesCents
        - fbaFulfillmentFeesCents
        - row.advertisingSpendCents
        - row.returnsRefundsCents
      const marginPct =
        row.grossRevenueCents > 0 ? trueProfit / row.grossRevenueCents : null
      const coverage = { ...((row.coverage as object) ?? {}), hasFbaFee: true }

      try {
        await prisma.productProfitDaily.update({
          where: { id: row.id },
          data: { fbaFulfillmentFeesCents, trueProfitCents: trueProfit, trueProfitMarginPct: marginPct, coverage },
        })
        result.profitRowsUpdated++
      } catch (err) {
        result.errors.push(`profit_update:${sku}:${row.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  result.durationMs = Date.now() - start
  logger.info('[fba-fees-ingest] complete', {
    skusFound: result.skusFound,
    listingsUpdated: result.listingsUpdated,
    profitRowsUpdated: result.profitRowsUpdated,
    errors: result.errors.length,
    durationMs: result.durationMs,
  })
  return result
}

export function summarizeFbaFeesIngest(r: FbaFeesIngestResult): string {
  return [
    `skus=${r.skusFound}`,
    `listings=${r.listingsUpdated}`,
    `profitRows=${r.profitRowsUpdated}`,
    r.skusUnmatched.length > 0 ? `unmatched=${r.skusUnmatched.length}` : null,
    r.errors.length > 0 ? `errors=${r.errors.length}` : null,
    `${r.durationMs}ms`,
  ]
    .filter(Boolean)
    .join(' · ')
}
