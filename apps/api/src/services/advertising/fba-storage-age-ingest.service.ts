/**
 * AD.1 — Ingests Amazon's FBA Aged Inventory report into FbaStorageAge.
 *
 * Sandbox mode (default in dev): synthesizes 4-6 rows across IT/DE
 * covering every age bucket so the StorageAgeTile + automation triggers
 * have data to demo against without a live SP-API call.
 *
 * Live mode: calls SP-API `GET_FBA_MYI_AGED_INVENTORY_DATA` per
 * marketplace, parses the TSV, and writes one snapshot per (sku,
 * marketplace, polledAt). Header-row validation aborts if Amazon
 * reorders columns (defensive — they've shipped backwards-incompatible
 * column changes before).
 *
 * Per-poll snapshots (not in-place updates) so AD.3's spike detector
 * can compare today vs yesterday.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { fetchSpApiReport } from '../sp-api-reports.service.js'

interface IngestSummary {
  marketplaces: string[]
  rowsIngested: number
  skusFlagged: number // unique SKUs with daysToLtsThreshold <= 30
  errors: string[]
  mode: 'sandbox' | 'live'
}

interface AgedRow {
  sku: string
  asin: string | null
  marketplace: string
  qty0_90: number
  qty91_180: number
  qty181_270: number
  qty271_365: number
  qty365Plus: number
  currentStorageFeeCents: number
  projectedLtsFee30dCents: number
  projectedLtsFee60dCents: number
  projectedLtsFee90dCents: number
  // Min days until ANY aged-quantity tips into the next LTS bracket.
  daysToLtsThreshold: number | null
}

// Amazon SP-API marketplace IDs (subset for EU). Mirrors the table at
// sp-api-reports.service.ts:31.
const MARKETPLACE_ID: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
}

// LTS fee bracket boundaries (days). Aged inventory in 271-365 incurs
// the lower LTS surcharge tier; >365 hits the steepest. Used to
// project when a SKU will tip into the next bracket.
const LTS_TIER_DAYS = [271, 365] as const

// Default monthly LTS fee per unit (EUR cents). Real values vary by
// dimension category; the rollup overrides per-SKU when known via
// product-level fee data. Conservative placeholder so sandbox numbers
// look meaningful rather than zero.
const DEFAULT_LTS_FEE_PER_UNIT_CENTS = 150

function adsMode(): 'sandbox' | 'live' {
  return process.env.NEXUS_AMAZON_ADS_MODE === 'live' ? 'live' : 'sandbox'
}

function ageOfStock(row: AgedRow): { youngestAgedDays: number | null } {
  // Estimate the youngest aged unit's age. If any qty in 0-90, the
  // youngest is in that band — projection meaningless. Otherwise pick
  // the floor of the lowest non-empty bucket.
  if (row.qty0_90 > 0) return { youngestAgedDays: 0 }
  if (row.qty91_180 > 0) return { youngestAgedDays: 91 }
  if (row.qty181_270 > 0) return { youngestAgedDays: 181 }
  if (row.qty271_365 > 0) return { youngestAgedDays: 271 }
  if (row.qty365Plus > 0) return { youngestAgedDays: 366 }
  return { youngestAgedDays: null }
}

function computeDaysToLtsThreshold(row: AgedRow): number | null {
  const { youngestAgedDays } = ageOfStock(row)
  if (youngestAgedDays == null) return null
  // Find the next bracket boundary above the youngest aged unit.
  const next = LTS_TIER_DAYS.find((d) => d > youngestAgedDays)
  if (next == null) return 0 // already past every bracket — LTS already biting
  return next - youngestAgedDays
}

function computeProjectedLtsFees(row: AgedRow): {
  in30d: number
  in60d: number
  in90d: number
} {
  // Project: any unit currently in 271+ or aging into 271+ during the
  // horizon will incur LTS fees. Conservative — uses the per-unit
  // placeholder; the true-profit roll-up overrides with actual fees
  // once Amazon Financial Events post.
  const horizonInDays = (h: number): number => {
    const exposed = LTS_TIER_DAYS.reduce((acc, boundary) => {
      // Already in this tier
      if (boundary === 271) {
        return acc + row.qty271_365 + row.qty365Plus
      }
      if (boundary === 365) {
        return acc + row.qty365Plus
      }
      return acc
    }, 0)
    // Plus units currently 271-h ≤ age < 271 that will tip in by h
    const willAge =
      h >= 0
        ? // qty in (271 - h, 271] window — conservative approximation
          Math.max(0, row.qty181_270 - Math.max(0, row.qty181_270 - Math.ceil((h / 90) * row.qty181_270)))
        : 0
    return Math.round((exposed + willAge) * DEFAULT_LTS_FEE_PER_UNIT_CENTS)
  }
  return {
    in30d: horizonInDays(30),
    in60d: horizonInDays(60),
    in90d: horizonInDays(90),
  }
}

// ── Sandbox synthesizer ───────────────────────────────────────────────

function synthesizeAgedRows(): AgedRow[] {
  // 5 SKUs spread across IT/DE in every bracket. Crafted so the
  // "≤14 days" trigger fires on at least one SKU (XAV-PELLE-BLU-M
  // has units in 181-270 with youngest aged ~257 days, putting LTS
  // 14 days away).
  return [
    {
      sku: 'XAV-GIACCA-NERO-M',
      asin: 'B0SANDBOXGIACCA01',
      marketplace: 'IT',
      qty0_90: 142,
      qty91_180: 0,
      qty181_270: 0,
      qty271_365: 0,
      qty365Plus: 0,
      currentStorageFeeCents: 350,
      projectedLtsFee30dCents: 0,
      projectedLtsFee60dCents: 0,
      projectedLtsFee90dCents: 0,
      daysToLtsThreshold: null,
    },
    {
      sku: 'XAV-CASCO-INT-L',
      asin: 'B0SANDBOXCASCO01',
      marketplace: 'IT',
      qty0_90: 38,
      qty91_180: 64,
      qty181_270: 0,
      qty271_365: 0,
      qty365Plus: 0,
      currentStorageFeeCents: 612,
      projectedLtsFee30dCents: 0,
      projectedLtsFee60dCents: 0,
      projectedLtsFee90dCents: 0,
      daysToLtsThreshold: null,
    },
    {
      sku: 'XAV-PELLE-BLU-M',
      asin: 'B0SANDBOXPELLE01',
      marketplace: 'DE',
      qty0_90: 0,
      qty91_180: 0,
      qty181_270: 47,
      qty271_365: 0,
      qty365Plus: 0,
      currentStorageFeeCents: 287,
      projectedLtsFee30dCents: 0,
      projectedLtsFee60dCents: 0,
      projectedLtsFee90dCents: 0,
      daysToLtsThreshold: null,
    },
    {
      sku: 'XAV-STIVALI-NERI-44',
      asin: 'B0SANDBOXSTIVALI01',
      marketplace: 'DE',
      qty0_90: 0,
      qty91_180: 0,
      qty181_270: 12,
      qty271_365: 33,
      qty365Plus: 0,
      currentStorageFeeCents: 412,
      projectedLtsFee30dCents: 0,
      projectedLtsFee60dCents: 0,
      projectedLtsFee90dCents: 0,
      daysToLtsThreshold: null,
    },
    {
      sku: 'XAV-PANTALONI-CARGO',
      asin: 'B0SANDBOXPANT01',
      marketplace: 'IT',
      qty0_90: 0,
      qty91_180: 0,
      qty181_270: 0,
      qty271_365: 0,
      qty365Plus: 88,
      currentStorageFeeCents: 528,
      projectedLtsFee30dCents: 0,
      projectedLtsFee60dCents: 0,
      projectedLtsFee90dCents: 0,
      daysToLtsThreshold: null,
    },
  ].map((row) => {
    const days = computeDaysToLtsThreshold(row)
    const fees = computeProjectedLtsFees(row)
    return {
      ...row,
      daysToLtsThreshold: days,
      projectedLtsFee30dCents: fees.in30d,
      projectedLtsFee60dCents: fees.in60d,
      projectedLtsFee90dCents: fees.in90d,
    }
  })
}

// ── Live TSV parser (header-validated) ────────────────────────────────

// Expected column header for GET_FBA_MYI_AGED_INVENTORY_DATA. Subset
// — full report has 25+ cols. We only require these.
const REQUIRED_COLUMNS = [
  'sku',
  'fnsku',
  'asin',
  'product-name',
  'condition',
  'available',
  'inv-age-0-to-90-days',
  'inv-age-91-to-180-days',
  'inv-age-181-to-270-days',
  'inv-age-271-to-365-days',
  'inv-age-365-plus-days',
  'currency',
  'estimated-storage-cost-next-month',
] as const

function parseAgedInventoryTsv(tsv: string, marketplace: string): AgedRow[] {
  const lines = tsv.split('\n').filter((l) => l.length > 0)
  if (lines.length < 2) return []
  const header = lines[0].split('\t').map((s) => s.trim().toLowerCase())
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c))
  if (missing.length > 0) {
    throw new Error(
      `[fba-storage-age] aged-inventory report missing columns: ${missing.join(', ')} — Amazon may have shipped a schema change; abort to avoid silent data loss`,
    )
  }
  const idx = (col: string): number => header.indexOf(col)
  const out: AgedRow[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split('\t')
    const sku = cols[idx('sku')]
    const asin = cols[idx('asin')] || null
    if (!sku) continue
    const row: AgedRow = {
      sku,
      asin,
      marketplace,
      qty0_90: Number(cols[idx('inv-age-0-to-90-days')]) || 0,
      qty91_180: Number(cols[idx('inv-age-91-to-180-days')]) || 0,
      qty181_270: Number(cols[idx('inv-age-181-to-270-days')]) || 0,
      qty271_365: Number(cols[idx('inv-age-271-to-365-days')]) || 0,
      qty365Plus: Number(cols[idx('inv-age-365-plus-days')]) || 0,
      currentStorageFeeCents: Math.round(
        (Number(cols[idx('estimated-storage-cost-next-month')]) || 0) * 100,
      ),
      projectedLtsFee30dCents: 0,
      projectedLtsFee60dCents: 0,
      projectedLtsFee90dCents: 0,
      daysToLtsThreshold: null,
    }
    row.daysToLtsThreshold = computeDaysToLtsThreshold(row)
    const fees = computeProjectedLtsFees(row)
    row.projectedLtsFee30dCents = fees.in30d
    row.projectedLtsFee60dCents = fees.in60d
    row.projectedLtsFee90dCents = fees.in90d
    out.push(row)
  }
  return out
}

// ── Persistence ───────────────────────────────────────────────────────

async function persistRows(rows: AgedRow[], polledAt: Date): Promise<number> {
  let n = 0
  for (const row of rows) {
    const product = await prisma.product.findFirst({
      where: { sku: row.sku },
      select: { id: true },
    })
    await prisma.fbaStorageAge.create({
      data: {
        productId: product?.id ?? null,
        sku: row.sku,
        asin: row.asin,
        marketplace: row.marketplace,
        polledAt,
        quantityInAge0_90: row.qty0_90,
        quantityInAge91_180: row.qty91_180,
        quantityInAge181_270: row.qty181_270,
        quantityInAge271_365: row.qty271_365,
        quantityInAge365Plus: row.qty365Plus,
        projectedLtsFee30dCents: row.projectedLtsFee30dCents,
        projectedLtsFee60dCents: row.projectedLtsFee60dCents,
        projectedLtsFee90dCents: row.projectedLtsFee90dCents,
        currentStorageFeeCents: row.currentStorageFeeCents,
        daysToLtsThreshold: row.daysToLtsThreshold,
      },
    })
    n += 1
  }
  return n
}

// ── Entry point ───────────────────────────────────────────────────────

export async function runFbaStorageAgeIngestOnce(): Promise<IngestSummary> {
  const mode = adsMode()
  const polledAt = new Date()
  const summary: IngestSummary = {
    marketplaces: [],
    rowsIngested: 0,
    skusFlagged: 0,
    errors: [],
    mode,
  }

  if (mode === 'sandbox') {
    const rows = synthesizeAgedRows()
    const marketplaces = Array.from(new Set(rows.map((r) => r.marketplace)))
    summary.marketplaces = marketplaces
    try {
      summary.rowsIngested = await persistRows(rows, polledAt)
      summary.skusFlagged = rows.filter(
        (r) => r.daysToLtsThreshold != null && r.daysToLtsThreshold <= 30,
      ).length
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`sandbox persist: ${msg}`)
      logger.error('[fba-storage-age] sandbox persist failed', { error: msg })
    }
    logger.info('[fba-storage-age] sandbox ingest complete', {
      rows: summary.rowsIngested,
      flagged: summary.skusFlagged,
    })
    return summary
  }

  // Live mode: per-marketplace SP-API call.
  const marketplaces = (process.env.NEXUS_AMAZON_ADS_MARKETPLACES ?? 'IT,DE')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const mp of marketplaces) {
    const mpId = MARKETPLACE_ID[mp]
    if (!mpId) {
      summary.errors.push(`unknown marketplace ${mp}`)
      continue
    }
    summary.marketplaces.push(mp)
    try {
      const report = await fetchSpApiReport<string>({
        reportType: 'GET_FBA_MYI_AGED_INVENTORY_DATA',
        marketplaceId: mpId,
        dataStartTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
        dataEndTime: new Date(),
      })
      const tsv = typeof report.payload === 'string' ? report.payload : ''
      const rows = parseAgedInventoryTsv(tsv, mp)
      const ingested = await persistRows(rows, polledAt)
      summary.rowsIngested += ingested
      summary.skusFlagged += rows.filter(
        (r) => r.daysToLtsThreshold != null && r.daysToLtsThreshold <= 30,
      ).length
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`${mp}: ${msg}`)
      logger.error('[fba-storage-age] live ingest failed', { marketplace: mp, error: msg })
    }
  }

  return summary
}

export function summarizeFbaStorageAge(s: IngestSummary): string {
  return [
    `mode=${s.mode}`,
    `marketplaces=${s.marketplaces.join(',') || 'none'}`,
    `rows=${s.rowsIngested}`,
    `flagged≤30d=${s.skusFlagged}`,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
