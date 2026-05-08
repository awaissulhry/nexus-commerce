/**
 * R4.3 — Amazon FBM returns report ingest + FBA mirror.
 *
 * Two report types feed the same Nexus Return surface:
 *
 *   FBM (merchant-fulfilled):
 *     reportType: GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE
 *     Tab-separated, one row per returned line item.
 *     Columns include: order-id, sku, asin, fnsku, product-name,
 *                      quantity, return-date, reason, status,
 *                      customer-comments, license-plate-number.
 *
 *   FBA (Amazon-fulfilled, read-only mirror):
 *     reportType: GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA
 *     Same shape; Amazon owns the physical handling so we mark the
 *     Return.isFbaReturn = true and never let operators move the
 *     status (drawer is read-only for FBA per the existing pattern).
 *
 * Idempotency: each row produces a stable `channelReturnId`:
 *   - FBA: license-plate-number when present (it's unique per
 *          physical return); falls back to synthetic.
 *   - FBM: synthetic `AMZ-FBM-{order-id}-{sku}-{return-date}` —
 *          the natural composite key. Re-polling never duplicates.
 *
 * Status mapping: Amazon's `status` column is short-form
 * (`Returned`, `Reimbursed`, etc.). We map conservatively to
 * REQUESTED unless the row is already settled.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { fetchSpApiReport } from '../sp-api-reports.service.js'

export interface AmazonReturnRow {
  /** Amazon order id (e.g. 123-1234567-1234567). Required. */
  'order-id'?: string
  sku?: string
  asin?: string
  fnsku?: string
  'product-name'?: string
  quantity?: string | number
  'return-date'?: string
  reason?: string
  status?: string
  'customer-comments'?: string
  'license-plate-number'?: string
  'detailed-disposition'?: string
  'fulfillment-center-id'?: string
  // Catch-all for column variations across marketplaces.
  [key: string]: string | number | undefined
}

export type IngestOutcome = 'created' | 'duplicate' | 'no_lines'

export interface IngestResult {
  outcome: IngestOutcome
  returnId?: string
  channelReturnId?: string
}

function generateRmaNumber(): string {
  const d = new Date()
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `RMA-${yymmdd}-${rand}`
}

// Amazon status → ReturnStatusFlow. Most rows arrive as "Returned"
// (just received by Amazon) or "Reimbursed" (already refunded).
function mapAmazonStatus(status: string | undefined): { status: string; refundStatus: string; refunded: boolean } {
  const s = (status ?? '').trim().toUpperCase()
  if (s.includes('REIMBURS') || s.includes('REFUND')) {
    return { status: 'REFUNDED', refundStatus: 'REFUNDED', refunded: true }
  }
  if (s.includes('CLOSED')) {
    return { status: 'REFUNDED', refundStatus: 'REFUNDED', refunded: true }
  }
  // "Returned" = unit physically returned but disposition not yet decided.
  return { status: 'RECEIVED', refundStatus: 'PENDING', refunded: false }
}

function buildChannelReturnId(row: AmazonReturnRow, isFba: boolean): string | null {
  const lpn = row['license-plate-number']?.toString().trim()
  if (isFba && lpn) return lpn
  const orderId = row['order-id']?.toString().trim()
  const sku = row.sku?.toString().trim()
  const date = row['return-date']?.toString().trim()
  if (!orderId || !sku || !date) return null
  return `AMZ-${isFba ? 'FBA' : 'FBM'}-${orderId}-${sku}-${date}`
}

/**
 * Ingest a single parsed report row. Idempotent on
 * (channel='AMAZON', channelReturnId).
 */
export async function ingestAmazonReturnRow(
  row: AmazonReturnRow,
  opts: { isFba: boolean; marketplace?: string },
): Promise<IngestResult> {
  const sku = row.sku?.toString().trim()
  const orderId = row['order-id']?.toString().trim()
  const qty = Number(row.quantity ?? 0)
  if (!sku || !orderId || qty <= 0) {
    return { outcome: 'no_lines' }
  }
  const channelReturnId = buildChannelReturnId(row, opts.isFba)
  if (!channelReturnId) return { outcome: 'no_lines' }

  // Idempotency.
  const existing = await prisma.return.findFirst({
    where: { channel: 'AMAZON', channelReturnId },
    select: { id: true, channelReturnId: true },
  })
  if (existing) {
    return { outcome: 'duplicate', returnId: existing.id, channelReturnId }
  }

  // Resolve local Order (best-effort; orphan creates are fine).
  const order = await prisma.order.findFirst({
    where: { channel: 'AMAZON', channelOrderId: orderId },
    select: { id: true },
  })

  // Resolve local Product by SKU.
  const product = await prisma.product.findUnique({
    where: { sku },
    select: { id: true },
  })

  const { status, refundStatus, refunded } = mapAmazonStatus(row.status)
  const returnDate = row['return-date']
    ? new Date(String(row['return-date']))
    : new Date()
  const reasonNorm = row.reason
    ? String(row.reason).replace(/_/g, ' ').toLowerCase()
    : 'amazon return'

  const ret = await prisma.return.create({
    data: {
      orderId: order?.id ?? null,
      channel: 'AMAZON',
      marketplace: opts.marketplace ?? null,
      channelReturnId,
      rmaNumber: generateRmaNumber(),
      status: status as any,
      isFbaReturn: opts.isFba,
      reason: reasonNorm,
      notes: row['customer-comments']?.toString().trim() || null,
      refundStatus,
      // Amazon's report doesn't carry refund amount per row — the
      // operator (FBM) or Amazon (FBA) decides separately. Leave
      // refundCents null; the drawer will surface "amount unknown
      // until refund posts" rather than show €0.00.
      refundCents: null,
      currencyCode: 'EUR',
      // For FBA reimbursed rows we mirror channelRefundedAt so the
      // analytics + audit timeline are coherent. We don't have an
      // Amazon refund id (their report never returns one), so
      // channelRefundId stays null.
      channelRefundedAt: refunded ? returnDate : null,
      refundedAt: refunded ? returnDate : null,
      createdAt: returnDate,
      items: {
        create: [
          {
            sku,
            quantity: qty,
            productId: product?.id ?? null,
          },
        ],
      },
    },
    select: { id: true },
  })

  try {
    await prisma.auditLog.create({
      data: {
        userId: null,
        ip: null,
        entityType: 'Return',
        entityId: ret.id,
        action: 'create',
        metadata: {
          source: opts.isFba ? 'amazon-fba-returns-report' : 'amazon-fbm-returns-report',
          channelReturnId,
          amazonOrderId: orderId,
          sku,
          quantity: qty,
          rawStatus: row.status ?? null,
          mappedStatus: status,
          isFba: opts.isFba,
          fulfillmentCenter: row['fulfillment-center-id'] ?? null,
          mirroredOrder: !!order,
        } as any,
      },
    })
  } catch (err) {
    logger.warn('amazon-returns: audit write failed (non-fatal)', { err })
  }

  return { outcome: 'created', returnId: ret.id, channelReturnId }
}

/**
 * Parse Amazon's TSV report body into row objects keyed by header.
 * Amazon emits headers on the first line, tab-separated. Empty
 * rows + comment lines (none expected, but defensive) are skipped.
 */
export function parseAmazonReturnsTsv(body: string): AmazonReturnRow[] {
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const headers = lines[0].split('\t').map((h) => h.trim())
  const rows: AmazonReturnRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const row: AmazonReturnRow = {}
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cols[j] ?? '').trim()
    }
    rows.push(row)
  }
  return rows
}

export interface PollOptions {
  /** Hours back from now to request. Default 25 (overlap with hourly cron). */
  hoursBack?: number
  /** Override marketplace id. Default `process.env.AMAZON_MARKETPLACE_ID` (IT). */
  marketplaceId?: string
  /** Pre-parsed rows (test harness path). When provided, the SP-API
   *  fetch is skipped and the rows are ingested directly. */
  fbmRows?: AmazonReturnRow[]
  fbaRows?: AmazonReturnRow[]
}

/**
 * Live poll: fetches both FBM + FBA returns reports, parses, and
 * ingests every row. Either side can be a no-op (0 rows) without
 * affecting the other.
 */
export async function pollAmazonReturns(opts: PollOptions = {}): Promise<{
  fbmCreated: number; fbmDuplicate: number; fbmNoLines: number; fbmFailed: number
  fbaCreated: number; fbaDuplicate: number; fbaNoLines: number; fbaFailed: number
  fbmRowsScanned: number; fbaRowsScanned: number
}> {
  const counters = {
    fbmCreated: 0, fbmDuplicate: 0, fbmNoLines: 0, fbmFailed: 0,
    fbaCreated: 0, fbaDuplicate: 0, fbaNoLines: 0, fbaFailed: 0,
    fbmRowsScanned: 0, fbaRowsScanned: 0,
  }

  const marketplaceId = opts.marketplaceId
    ?? process.env.AMAZON_MARKETPLACE_ID
    ?? 'APJ6JRA9NG5V4' // Italy default
  const dataEndTime = new Date()
  const dataStartTime = new Date(dataEndTime.getTime() - (opts.hoursBack ?? 25) * 3600_000)

  // ── FBM path ─────────────────────────────────────────────────────
  let fbmRows: AmazonReturnRow[] = []
  if (opts.fbmRows) {
    fbmRows = opts.fbmRows
  } else {
    try {
      const result = await fetchSpApiReport<string>({
        reportType: 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE',
        marketplaceId,
        dataStartTime,
        dataEndTime,
      })
      fbmRows = parseAmazonReturnsTsv(typeof result.payload === 'string' ? result.payload : '')
    } catch (err) {
      counters.fbmFailed++
      logger.warn('amazon-returns: FBM report fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  counters.fbmRowsScanned = fbmRows.length
  for (const row of fbmRows) {
    try {
      const r = await ingestAmazonReturnRow(row, { isFba: false, marketplace: marketplaceId })
      if (r.outcome === 'created') counters.fbmCreated++
      else if (r.outcome === 'duplicate') counters.fbmDuplicate++
      else counters.fbmNoLines++
    } catch (err) {
      counters.fbmFailed++
      logger.warn('amazon-returns: FBM row ingest failed', {
        sku: row.sku, orderId: row['order-id'],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── FBA path ─────────────────────────────────────────────────────
  let fbaRows: AmazonReturnRow[] = []
  if (opts.fbaRows) {
    fbaRows = opts.fbaRows
  } else {
    try {
      const result = await fetchSpApiReport<string>({
        reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
        marketplaceId,
        dataStartTime,
        dataEndTime,
      })
      fbaRows = parseAmazonReturnsTsv(typeof result.payload === 'string' ? result.payload : '')
    } catch (err) {
      counters.fbaFailed++
      logger.warn('amazon-returns: FBA report fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  counters.fbaRowsScanned = fbaRows.length
  for (const row of fbaRows) {
    try {
      const r = await ingestAmazonReturnRow(row, { isFba: true, marketplace: marketplaceId })
      if (r.outcome === 'created') counters.fbaCreated++
      else if (r.outcome === 'duplicate') counters.fbaDuplicate++
      else counters.fbaNoLines++
    } catch (err) {
      counters.fbaFailed++
      logger.warn('amazon-returns: FBA row ingest failed', {
        sku: row.sku, orderId: row['order-id'],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('amazon-returns: complete', counters)
  return counters
}
