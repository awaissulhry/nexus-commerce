/**
 * HB.5 — FBA cost detail ingestion.
 *
 * Two report types, both flat-file TSV:
 *   GET_FBA_REIMBURSEMENTS_DATA       → FbaReimbursement rows
 *   GET_FBA_INVENTORY_ADJUSTMENTS_DATA → FbaInventoryAdjustment rows
 *
 * Both use the existing fetchSpApiReport helper which handles the
 * createReport → poll → getReportDocument chain. We just parse the
 * TSV payload and upsert by Amazon's stable per-event id
 * (reimbursement-id / adjusted-id).
 *
 * Window cap: Amazon's documentation says these reports support up to
 * 18 months of data per single request. We chunk in 30-day windows to
 * stay well under any per-request limit + give per-chunk progress.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { fetchSpApiReport } from './sp-api-reports.service.js'

// ─── TSV parser (Amazon flat-files use tab-separated, with a header row) ─

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

function parseAmazonDate(s?: string): Date | null {
  if (!s) return null
  // Amazon flat-files use various formats: 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM:SSZ',
  // 'MMM DD, YYYY'. Try Date constructor which handles ISO + common formats.
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d
}

function parseIntSafe(s?: string): number {
  if (!s) return 0
  const n = parseInt(s.replace(/[^-\d]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

function parseCents(s?: string): number {
  if (!s) return 0
  const f = parseFloat(s.replace(/[^-\d.]/g, ''))
  if (!Number.isFinite(f)) return 0
  return Math.round(f * 100)
}

// ─── Reimbursements ──────────────────────────────────────────────────

export interface ReimbursementsIngestResult {
  ranAt: string
  durationMs: number
  daysBack: number
  marketplaceId: string
  chunks: number
  rowsScanned: number
  rowsCreated: number
  rowsUpdated: number
  rowsFailed: number
  errors: string[]
}

const CHUNK_DAYS = 30

export async function ingestFbaReimbursements(args: {
  daysBack?: number
  marketplaceId?: string
} = {}): Promise<ReimbursementsIngestResult> {
  const t0 = Date.now()
  const daysBack = args.daysBack ?? 730
  const marketplaceId = args.marketplaceId
    ?? process.env.AMAZON_MARKETPLACE_ID
    ?? 'APJ6JRA9NG5V4'
  const errors: string[] = []
  let chunks = 0
  let rowsScanned = 0
  let rowsCreated = 0
  let rowsUpdated = 0
  let rowsFailed = 0

  const nowMs = Date.now()
  let chunkEndMs = nowMs
  let remaining = daysBack

  while (remaining > 0) {
    const span = Math.min(CHUNK_DAYS, remaining)
    const chunkStartMs = chunkEndMs - span * 24 * 60 * 60 * 1000
    chunks++
    try {
      const result = await fetchSpApiReport<string>({
        reportType: 'GET_FBA_REIMBURSEMENTS_DATA',
        marketplaceId,
        dataStartTime: new Date(chunkStartMs),
        dataEndTime: new Date(chunkEndMs),
      })
      const rows = parseTsv(typeof result.payload === 'string' ? result.payload : '')
      rowsScanned += rows.length
      for (const row of rows) {
        try {
          const reimbursementId = row['reimbursement-id'] ?? row['Reimbursement ID']
          if (!reimbursementId) continue
          const approvalDate = parseAmazonDate(
            row['approval-date'] ?? row['Approval Date'] ?? row['posted-date'],
          )
          if (!approvalDate) continue
          const data = {
            approvalDate,
            caseId: row['case-id'] ?? row['Case ID'] ?? null,
            amazonOrderId: row['amazon-order-id'] ?? row['Amazon Order ID'] ?? null,
            reason: row['reason'] ?? row['Reason'] ?? null,
            sku: row['sku'] ?? row['SKU'] ?? '',
            fnsku: row['fnsku'] ?? row['FNSKU'] ?? null,
            asin: row['asin'] ?? row['ASIN'] ?? null,
            quantityReimbursed: parseIntSafe(
              row['quantity-reimbursed-total'] ?? row['Quantity'] ?? '0',
            ),
            amountPerUnitCents: parseCents(
              row['amount-per-unit'] ?? row['Amount per Unit'] ?? '0',
            ),
            totalAmountCents: parseCents(
              row['amount-total'] ?? row['Amount Total'] ?? '0',
            ),
            currencyCode: (row['currency-unit'] ?? row['Currency Unit'] ?? 'EUR').toUpperCase(),
            marketplaceId,
          }
          const existing = await prisma.fbaReimbursement.findUnique({
            where: { reimbursementId },
            select: { id: true },
          })
          if (existing) {
            await prisma.fbaReimbursement.update({
              where: { id: existing.id },
              data,
            })
            rowsUpdated++
          } else {
            await prisma.fbaReimbursement.create({
              data: { reimbursementId, ...data },
            })
            rowsCreated++
          }
        } catch (err) {
          rowsFailed++
          const msg = err instanceof Error ? err.message : String(err)
          if (errors.length < 20) errors.push(`${row['reimbursement-id'] ?? '?'}: ${msg.slice(0, 200)}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`chunk ${chunks} [${new Date(chunkStartMs).toISOString().slice(0, 10)}..${new Date(chunkEndMs).toISOString().slice(0, 10)}]: ${msg.slice(0, 200)}`)
      logger.warn('fba-cost-detail: reimbursements chunk failed', {
        chunk: chunks, error: msg,
      })
    }
    chunkEndMs = chunkStartMs - 1
    remaining -= span
  }

  const durationMs = Date.now() - t0
  logger.info('[fba-cost-detail] reimbursements ingest complete', {
    daysBack, chunks, rowsScanned, rowsCreated, rowsUpdated, rowsFailed,
    errorCount: errors.length, durationMs,
  })

  return {
    ranAt: new Date().toISOString(),
    durationMs,
    daysBack,
    marketplaceId,
    chunks,
    rowsScanned,
    rowsCreated,
    rowsUpdated,
    rowsFailed,
    errors,
  }
}

// ─── Inventory adjustments ──────────────────────────────────────────

export interface AdjustmentsIngestResult {
  ranAt: string
  durationMs: number
  daysBack: number
  marketplaceId: string
  chunks: number
  rowsScanned: number
  rowsCreated: number
  rowsUpdated: number
  rowsFailed: number
  errors: string[]
}

export async function ingestFbaInventoryAdjustments(args: {
  daysBack?: number
  marketplaceId?: string
} = {}): Promise<AdjustmentsIngestResult> {
  const t0 = Date.now()
  const daysBack = args.daysBack ?? 730
  const marketplaceId = args.marketplaceId
    ?? process.env.AMAZON_MARKETPLACE_ID
    ?? 'APJ6JRA9NG5V4'
  const errors: string[] = []
  let chunks = 0
  let rowsScanned = 0
  let rowsCreated = 0
  let rowsUpdated = 0
  let rowsFailed = 0

  const nowMs = Date.now()
  let chunkEndMs = nowMs
  let remaining = daysBack

  while (remaining > 0) {
    const span = Math.min(CHUNK_DAYS, remaining)
    const chunkStartMs = chunkEndMs - span * 24 * 60 * 60 * 1000
    chunks++
    try {
      const result = await fetchSpApiReport<string>({
        reportType: 'GET_FBA_INVENTORY_ADJUSTMENTS_DATA',
        marketplaceId,
        dataStartTime: new Date(chunkStartMs),
        dataEndTime: new Date(chunkEndMs),
      })
      const rows = parseTsv(typeof result.payload === 'string' ? result.payload : '')
      rowsScanned += rows.length
      for (const row of rows) {
        try {
          // Amazon's adjustment id may appear as 'transaction-item-id' or
          // 'adjusted-id' depending on report variant.
          const adjustmentId = row['transaction-item-id']
            ?? row['adjusted-id']
            ?? row['Transaction Item ID']
            ?? null
          if (!adjustmentId) continue
          const adjustedDate = parseAmazonDate(
            row['adjusted-date'] ?? row['Adjusted Date'] ?? row['posted-date'],
          )
          if (!adjustedDate) continue
          const data = {
            adjustedDate,
            transactionType: row['transaction-type']
              ?? row['Transaction Type']
              ?? row['reason']
              ?? 'UNKNOWN',
            fnsku: row['fnsku'] ?? row['FNSKU'] ?? null,
            sku: row['sku'] ?? row['SKU'] ?? row['merchant-sku'] ?? '',
            asin: row['asin'] ?? row['ASIN'] ?? null,
            quantity: parseIntSafe(row['quantity'] ?? row['Quantity'] ?? '0'),
            fulfillmentCenterId: row['fulfillment-center-id']
              ?? row['Fulfillment Center']
              ?? row['fnsku-fulfillment-center']
              ?? null,
            reasonCode: row['reason'] ?? row['Reason'] ?? null,
            disposition: row['disposition'] ?? row['Disposition'] ?? null,
            marketplaceId,
          }
          const existing = await prisma.fbaInventoryAdjustment.findUnique({
            where: { adjustmentId },
            select: { id: true },
          })
          if (existing) {
            await prisma.fbaInventoryAdjustment.update({
              where: { id: existing.id },
              data,
            })
            rowsUpdated++
          } else {
            await prisma.fbaInventoryAdjustment.create({
              data: { adjustmentId, ...data },
            })
            rowsCreated++
          }
        } catch (err) {
          rowsFailed++
          const msg = err instanceof Error ? err.message : String(err)
          if (errors.length < 20) errors.push(`${row['transaction-item-id'] ?? '?'}: ${msg.slice(0, 200)}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`chunk ${chunks} [${new Date(chunkStartMs).toISOString().slice(0, 10)}..${new Date(chunkEndMs).toISOString().slice(0, 10)}]: ${msg.slice(0, 200)}`)
      logger.warn('fba-cost-detail: adjustments chunk failed', {
        chunk: chunks, error: msg,
      })
    }
    chunkEndMs = chunkStartMs - 1
    remaining -= span
  }

  const durationMs = Date.now() - t0
  logger.info('[fba-cost-detail] adjustments ingest complete', {
    daysBack, chunks, rowsScanned, rowsCreated, rowsUpdated, rowsFailed,
    errorCount: errors.length, durationMs,
  })

  return {
    ranAt: new Date().toISOString(),
    durationMs,
    daysBack,
    marketplaceId,
    chunks,
    rowsScanned,
    rowsCreated,
    rowsUpdated,
    rowsFailed,
    errors,
  }
}
