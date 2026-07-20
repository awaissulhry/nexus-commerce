/**
 * IM.3.5 — import/export file builders for the stock wizard.
 *
 * Round-trip contract: header names are chosen so a re-upload auto-maps
 * (`sku` → identifier, `quantity` → quantity, `channel`/`marketplace` pass
 * through); informational columns (name, ean, error, matched_sku, applied,
 * reserved, available) stay unmapped on import and are ignored. XLSX
 * identifier/EAN columns are text-typed ('@') so Excel cannot strip leading
 * zeros or scientific-notate barcodes.
 */
import ExcelJS from 'exceljs'
import prisma from '../db.js'
import type { ApplyResult } from './stock-import.service.js'

export function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\r\n') + '\r\n'
}

export async function buildXlsx(headers: string[], rows: unknown[][], textCols: number[] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('rows')
  ws.addRow(headers)
  ws.getRow(1).font = { bold: true }
  for (const col of textCols) ws.getColumn(col + 1).numFmt = '@'
  for (const r of rows) {
    ws.addRow(r.map((v, i) => (textCols.includes(i) && v != null ? String(v) : v)))
  }
  headers.forEach((h, i) => {
    const maxLen = Math.max(h.length, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length))
    ws.getColumn(i + 1).width = Math.min(60, Math.max(10, maxLen + 2))
  })
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

/** Per-row results of a finished import as a fix-and-reupload file. */
export async function buildJobResultsExport(jobId: string, scope: 'failed' | 'all') {
  const job = await prisma.stockImportJob.findUnique({ where: { id: jobId } })
  if (!job) return null
  const results = ((job.results as ApplyResult['results'] | null) ?? []).filter((r) =>
    scope === 'all' ? true : !r.applied,
  )
  return {
    job,
    headers: ['sku', 'quantity', 'channel', 'marketplace', 'error', 'matched_sku', 'applied'],
    textCols: [0],
    rows: results.map((r) => [
      r.raw,
      r.quantity ?? '',
      r.channel ?? '',
      r.marketplace ?? '',
      r.error ?? '',
      r.sku ?? '',
      r.applied ? 'yes' : 'no',
    ]),
  }
}

/**
 * Current stock at a location as an import-ready file (export → edit in
 * Excel → re-import with mode SET). Every non-parent product appears, with
 * 0 for products that have no level row yet.
 */
export async function buildStockExport(locationCode: string) {
  const location = await prisma.stockLocation.findUnique({
    where: { code: locationCode },
    select: { id: true, type: true },
  })
  if (!location) return null
  const [products, levels] = await Promise.all([
    prisma.product.findMany({
      where: { deletedAt: null, isParent: false },
      select: { id: true, sku: true, name: true, ean: true },
      orderBy: { sku: 'asc' },
    }),
    prisma.stockLevel.findMany({
      where: { locationId: location.id, variationId: null },
      select: { productId: true, quantity: true, reserved: true, available: true },
    }),
  ])
  const byProduct = new Map(levels.map((l) => [l.productId, l] as const))
  return {
    headers: ['sku', 'quantity', 'name', 'ean', 'reserved', 'available'],
    textCols: [0, 3],
    rows: products.map((p) => {
      const l = byProduct.get(p.id)
      return [p.sku, l?.quantity ?? 0, p.name, p.ean ?? '', l?.reserved ?? 0, l?.available ?? 0]
    }),
  }
}
