/**
 * SCV.3 — dedicated Sync Control Excel round-trip.
 *
 * A two-sheet workbook: "Listings" (one row per controllable listing: mode,
 * pinned qty, buffer — plus read-only context) and "Routes" (location → the
 * markets/channels it feeds). FBA rows export LOCKED and are ignored on import.
 * A control sheet ONLY ever touches control columns — it never writes pool
 * quantity, so an Amazon/eBay export sheet can't corrupt the pool.
 */
import ExcelJS from 'exceljs'

export const LISTINGS_SHEET = 'Listings'
export const ROUTES_SHEET = 'Routes'

// Header order — also the import contract (matched case-insensitively by name).
export const LISTING_HEADERS = [
  'Product', 'SKU', 'Channel', 'Market', 'ItemID', 'Lane',
  'Mode', 'PinnedQty', 'Buffer',
  'Pool', 'Intended', 'Live', 'Drift', 'Locked',
] as const
export const ROUTE_HEADERS = ['Location', 'Type', 'Feeds'] as const

export interface SCListingExportRow {
  product: string
  sku: string
  channel: string
  market: string
  itemId: string
  lane: string
  mode: string
  pinnedQty: number | ''
  buffer: number
  pool: number | ''
  intended: number | ''
  live: number | ''
  drift: string
  locked: string
}

export interface SCRouteExportRow {
  location: string
  type: string
  feeds: string
}

export async function buildSyncControlWorkbook(
  listings: SCListingExportRow[],
  routes: SCRouteExportRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()

  const ls = wb.addWorksheet(LISTINGS_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  ls.addRow([...LISTING_HEADERS])
  ls.getRow(1).font = { bold: true }
  // SKU / ItemID as text so long numeric itemIds don't get mangled.
  ls.getColumn(2).numFmt = '@'
  ls.getColumn(5).numFmt = '@'
  for (const r of listings) {
    const row = ls.addRow([
      r.product, r.sku, r.channel, r.market, r.itemId, r.lane,
      r.mode, r.pinnedQty, r.buffer,
      r.pool, r.intended, r.live, r.drift, r.locked,
    ])
    if (r.locked) row.font = { color: { argb: 'FF9CA3AF' } } // grey out FBA
  }
  LISTING_HEADERS.forEach((h, i) => {
    const maxLen = Math.max(h.length, ...listings.slice(0, 200).map((r) => String(Object.values(r)[i] ?? '').length))
    ls.getColumn(i + 1).width = Math.min(48, Math.max(8, maxLen + 2))
  })

  const rs = wb.addWorksheet(ROUTES_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  rs.addRow([...ROUTE_HEADERS])
  rs.getRow(1).font = { bold: true }
  for (const r of routes) rs.addRow([r.location, r.type, r.feeds])
  rs.getColumn(1).width = 20
  rs.getColumn(3).width = 40

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

/** Normalize a Mode cell → canonical mode, `null` (blank = no change),
 *  or `undefined` (unrecognized = invalid, surfaced in the preview). */
export function normalizeModeCell(raw: unknown): 'FOLLOW' | 'PINNED' | 'PAUSED' | 'EXCLUDED' | null | undefined {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === '') return null
  if (['follow', 'following', 'segui', 'pool'].includes(v)) return 'FOLLOW'
  if (['pinned', 'pin', 'bloccato', 'fisso'].includes(v)) return 'PINNED'
  if (['paused', 'pause', 'pausa', 'in pausa'].includes(v)) return 'PAUSED'
  if (['excluded', 'exclude', 'escluso', 'escludi'].includes(v)) return 'EXCLUDED'
  return undefined
}

export interface SCListingEdit {
  sku: string
  channel: string
  market: string
  itemId: string
  mode: string
  pinnedQty: number | null
  buffer: number | null
  locked: boolean
  rowNum: number
}

export interface SCRouteEdit {
  location: string
  feeds: string[]
  rowNum: number
}

function headerIndex(row: ExcelJS.Row): Map<string, number> {
  const idx = new Map<string, number>()
  row.eachCell((cell, col) => idx.set(String(cell.value ?? '').trim().toLowerCase(), col))
  return idx
}

function cellStr(row: ExcelJS.Row, col: number | undefined): string {
  if (!col) return ''
  const v = row.getCell(col).value
  if (v == null) return ''
  if (typeof v === 'object' && 'text' in (v as object)) return String((v as { text: unknown }).text ?? '').trim()
  if (typeof v === 'object' && 'result' in (v as object)) return String((v as { result: unknown }).result ?? '').trim()
  return String(v).trim()
}

function cellNum(row: ExcelJS.Row, col: number | undefined): number | null {
  const s = cellStr(row, col)
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Read both sheets. Missing "Routes" sheet is fine (listings-only edit). */
export async function parseSyncControlWorkbook(buf: Buffer): Promise<{ listings: SCListingEdit[]; routes: SCRouteEdit[] }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)

  const ls = wb.getWorksheet(LISTINGS_SHEET) ?? wb.worksheets[0]
  const listings: SCListingEdit[] = []
  if (ls && ls.rowCount > 1) {
    const h = headerIndex(ls.getRow(1))
    const col = (name: string) => h.get(name.toLowerCase())
    for (let i = 2; i <= ls.rowCount; i++) {
      const row = ls.getRow(i)
      const sku = cellStr(row, col('sku'))
      if (!sku) continue
      listings.push({
        sku,
        channel: cellStr(row, col('channel')).toUpperCase(),
        market: cellStr(row, col('market')).toUpperCase(),
        itemId: cellStr(row, col('itemid')),
        mode: cellStr(row, col('mode')),
        pinnedQty: cellNum(row, col('pinnedqty')),
        buffer: cellNum(row, col('buffer')),
        locked: cellStr(row, col('locked')) !== '',
        rowNum: i,
      })
    }
  }

  const rs = wb.getWorksheet(ROUTES_SHEET)
  const routes: SCRouteEdit[] = []
  if (rs && rs.rowCount > 1) {
    const h = headerIndex(rs.getRow(1))
    const col = (name: string) => h.get(name.toLowerCase())
    for (let i = 2; i <= rs.rowCount; i++) {
      const row = rs.getRow(i)
      const location = cellStr(row, col('location'))
      if (!location) continue
      const feeds = cellStr(row, col('feeds')).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
      routes.push({ location, feeds, rowNum: i })
    }
  }

  return { listings, routes }
}
