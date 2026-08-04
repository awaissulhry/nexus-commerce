/**
 * RPT.7 — importing Amazon's unified-reporting console export.
 *
 * Why this exists: the export carries a grain the Ads API cannot return —
 * search term × target × ad × placement × marketplace — and reaches about five
 * weeks further back than our own search-term ingest. It is genuinely worth
 * having. What it is NOT is a time series, so it gets its own table and is never
 * merged into AmazonAdsSearchTerm.
 *
 * Seven traps in the real file, all handled here and all measured rather than
 * assumed (docs/2026-08-04-ads-reporting-rpt.md §2.2):
 *
 *  1. `Date range` is a per-row LIFETIME WINDOW, not a day — 5,440 distinct
 *     values in one 20,687-row file, mixing single days and multi-week spans.
 *     Rows across overlapping windows must never be summed.
 *  2. IDs are Excel-escaped: `="170574860392093"`.
 *  3. Percentages are formatted strings: `"20.0000%"`. We never read them —
 *     every ratio is recomputed from the underlying counts.
 *  4. Marketplace `UAMAZON_FR` carries a stray leading U.
 *  5. `Portfolio ID` uses `-1` as the "no portfolio" sentinel.
 *  6. The header is BOM-prefixed.
 *  7. ⭐ Amazon SPLITS one logical row in two: a traffic row (`Site or app` =
 *     "Unknown", with impressions/clicks/cost) and a separate conversion row
 *     (blank site, zero traffic, carrying the purchases and sales attributed to
 *     an earlier click). 89 such pairs in the sample. They share a natural key
 *     and MUST BE SUMMED — deduplicating would silently drop either the sale or
 *     the click that paid for it, and the ACOS would be wrong either way.
 */
import prisma from '../../db.js'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'

export interface ImportError {
  line: number
  field: string
  value: string
  message: string
}

export interface ParsedRow {
  windowStart: string
  windowEnd: string
  marketplace: string
  adProduct: string
  campaignId: string
  campaignName: string | null
  portfolioName: string | null
  adGroupId: string | null
  adGroupName: string | null
  adId: string | null
  asin: string | null
  sku: string | null
  placement: string | null
  targetId: string | null
  targeting: string | null
  matchType: string | null
  searchTerm: string | null
  impressions: number
  clicks: number
  costCents: number
  salesCents: number
  purchases: number
  sourceRows: number
}

export interface ParseResult {
  rows: ParsedRow[]
  errors: ImportError[]
  rowsRead: number
  rowsSkipped: number
  /** CSV lines folded into fewer rows by the traffic/conversion split. */
  rowsMerged: number
  windowStart: string | null
  windowEnd: string | null
  totals: { impressions: number; clicks: number; costCents: number; salesCents: number; purchases: number }
}

/** Required headers. Their absence means this is not a unified-report export. */
const REQUIRED = ['Date range', 'Campaign ID', 'Ad product', 'Impressions', 'Clicks', 'Total cost']

/** Strip Excel's `="123"` armour and surrounding whitespace. */
function unescapeCell(v: string | undefined): string {
  if (v == null) return ''
  const t = v.trim()
  const m = /^="(.*)"$/.exec(t)
  return (m ? m[1] : t).trim()
}

const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
}

/** "Apr 30, 2026" → "2026-04-30". Returns null on anything unexpected. */
function parseDay(s: string): string | null {
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(s.trim())
  if (!m) return null
  const mo = MONTHS[m[1]]
  if (!mo) return null
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`
}

/** "Apr 30, 2026 - Jun 27, 2026" → both ends. Single days repeat the same date. */
function parseWindow(s: string): { start: string; end: string } | null {
  const parts = s.split(' - ')
  if (parts.length !== 2) return null
  const start = parseDay(parts[0])
  const end = parseDay(parts[1])
  return start && end ? { start, end } : null
}

/** Money "122.91" → 12291 cents. Blank → 0. */
function money(v: string): number | null {
  const t = unescapeCell(v)
  if (!t) return 0
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null
  return Math.round(Number(t) * 100)
}

function int(v: string): number | null {
  const t = unescapeCell(v)
  if (!t) return 0
  if (!/^-?\d+$/.test(t)) return null
  return Number(t)
}

/** Minimal RFC-4180 CSV reader — quoted fields, embedded commas and newlines. */
function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row) }
  return out
}

export function parseUnifiedReport(text: string): ParseResult {
  // Trap 6 — strip the BOM before the header is read, or the first column name
  // is "﻿Date range" and every lookup on it misses.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const grid = parseCsv(clean)
  const errors: ImportError[] = []

  if (!grid.length) {
    return { rows: [], errors: [{ line: 0, field: 'file', value: '', message: 'The file is empty' }], rowsRead: 0, rowsSkipped: 0, rowsMerged: 0, windowStart: null, windowEnd: null, totals: { impressions: 0, clicks: 0, costCents: 0, salesCents: 0, purchases: 0 } }
  }

  const header = grid[0].map((h) => h.trim())
  const missing = REQUIRED.filter((h) => !header.includes(h))
  if (missing.length) {
    return {
      rows: [], rowsRead: 0, rowsSkipped: 0, rowsMerged: 0, windowStart: null, windowEnd: null,
      totals: { impressions: 0, clicks: 0, costCents: 0, salesCents: 0, purchases: 0 },
      errors: [{
        line: 1, field: 'header', value: header.slice(0, 4).join(', '),
        message: `Not an Amazon unified-report export — missing ${missing.join(', ')}`,
      }],
    }
  }
  const idx = new Map(header.map((h, i) => [h, i]))
  const cell = (r: string[], name: string) => unescapeCell(r[idx.get(name) ?? -1])
  const orNull = (v: string) => (v ? v : null)

  // Trap 7 — fold traffic and conversion lines that share a natural key.
  const merged = new Map<string, ParsedRow>()
  let rowsRead = 0
  let rowsSkipped = 0
  let windowStart: string | null = null
  let windowEnd: string | null = null

  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]
    const line = i + 1
    if (r.every((c) => c.trim() === '')) continue
    rowsRead++

    const win = parseWindow(cell(r, 'Date range'))
    if (!win) {
      errors.push({ line, field: 'Date range', value: cell(r, 'Date range'), message: 'Unrecognised date range' })
      rowsSkipped++
      continue
    }
    const campaignId = cell(r, 'Campaign ID')
    if (!campaignId) {
      errors.push({ line, field: 'Campaign ID', value: '', message: 'Missing campaign id' })
      rowsSkipped++
      continue
    }

    const impressions = int(cell(r, 'Impressions'))
    const clicks = int(cell(r, 'Clicks'))
    const costCents = money(cell(r, 'Total cost'))
    const salesCents = money(cell(r, 'Sales'))
    const purchases = int(cell(r, 'Purchases'))
    const numericProblem = [
      ['Impressions', impressions], ['Clicks', clicks], ['Total cost', costCents],
      ['Sales', salesCents], ['Purchases', purchases],
    ].find(([, v]) => v === null)
    if (numericProblem) {
      const field = numericProblem[0] as string
      errors.push({ line, field, value: cell(r, field), message: 'Not a number' })
      rowsSkipped++
      continue
    }

    // Trap 4 — UAMAZON_FR and friends normalise through the shared map; AMAZON_IT
    // is handled by the same helper's AMAZON_ prefix branch.
    const rawMkt = cell(r, 'Advertised product marketplace')
    const marketplace = normalizeMarketplaceCode(rawMkt.replace(/^U(?=AMAZON_)/, ''), 'UNKNOWN')

    const key = [
      win.start, win.end, campaignId, cell(r, 'Ad group ID'), cell(r, 'Ad ID'),
      cell(r, 'Target ID'), cell(r, 'Search term'), cell(r, 'Placement classification'), marketplace,
    ].join('')

    const existing = merged.get(key)
    if (existing) {
      existing.impressions += impressions as number
      existing.clicks += clicks as number
      existing.costCents += costCents as number
      existing.salesCents += salesCents as number
      existing.purchases += purchases as number
      existing.sourceRows++
      // The conversion line carries no product enrichment, so keep whichever
      // side actually has it rather than letting a blank overwrite a value.
      existing.asin ??= orNull(cell(r, 'Advertised product ID'))
      existing.sku ??= orNull(cell(r, 'Advertised product SKU'))
      existing.campaignName ??= orNull(cell(r, 'Campaign name'))
      continue
    }

    merged.set(key, {
      windowStart: win.start,
      windowEnd: win.end,
      marketplace,
      adProduct: cell(r, 'Ad product') || 'Unknown',
      campaignId,
      campaignName: orNull(cell(r, 'Campaign name')),
      // Trap 5 — -1 means "no portfolio", not a portfolio called -1.
      portfolioName: cell(r, 'Portfolio ID') === '-1' ? null : orNull(cell(r, 'Portfolio name')),
      adGroupId: orNull(cell(r, 'Ad group ID')),
      adGroupName: orNull(cell(r, 'Ad group name')),
      adId: orNull(cell(r, 'Ad ID')),
      asin: orNull(cell(r, 'Advertised product ID')),
      sku: orNull(cell(r, 'Advertised product SKU')),
      placement: orNull(cell(r, 'Placement classification')),
      targetId: orNull(cell(r, 'Target ID')),
      targeting: orNull(cell(r, 'Targeting')),
      matchType: orNull(cell(r, 'Targeting match type')),
      searchTerm: orNull(cell(r, 'Search term')),
      impressions: impressions as number,
      clicks: clicks as number,
      costCents: costCents as number,
      salesCents: salesCents as number,
      purchases: purchases as number,
      sourceRows: 1,
    })

    if (!windowStart || win.start < windowStart) windowStart = win.start
    if (!windowEnd || win.end > windowEnd) windowEnd = win.end
  }

  const rows = [...merged.values()]
  const totals = rows.reduce(
    (t, r) => ({
      impressions: t.impressions + r.impressions,
      clicks: t.clicks + r.clicks,
      costCents: t.costCents + r.costCents,
      salesCents: t.salesCents + r.salesCents,
      purchases: t.purchases + r.purchases,
    }),
    { impressions: 0, clicks: 0, costCents: 0, salesCents: 0, purchases: 0 },
  )

  return {
    rows,
    errors,
    rowsRead,
    rowsSkipped,
    rowsMerged: rowsRead - rowsSkipped - rows.length,
    windowStart,
    windowEnd,
    totals,
  }
}

export interface PreviewResult {
  importId: string
  fileName: string
  status: string
  rowsRead: number
  rowsMerged: number
  rowsNew: number
  rowsUnchanged: number
  rowsConflicting: number
  rowsSkipped: number
  rowsErrored: number
  windowStart: string | null
  windowEnd: string | null
  totals: { impressions: number; clicks: number; costCents: number; salesCents: number; purchases: number }
  errors: ImportError[]
  /** A handful of rows so the operator can eyeball the parse before committing. */
  sample: ParsedRow[]
}

const ERROR_CAP = 500

/**
 * Parse and REPORT — nothing is written to the reporting tables.
 *
 * The arithmetic is the Akeneo standard the prior research singled out as best
 * in class: say how many rows were read, how many folded, how many are new,
 * unchanged or in conflict, and name the offending field and value for every
 * failure. "Imported successfully" with no numbers is how a silent half-import
 * gets discovered a month later.
 */
export async function previewImport(fileName: string, fileSize: number, text: string): Promise<PreviewResult> {
  const parsed = parseUnifiedReport(text)

  // Compare against what previous COMMITTED imports already hold, so re-uploading
  // the same export is visibly a no-op rather than a silent duplication.
  let rowsNew = 0
  let rowsUnchanged = 0
  let rowsConflicting = 0
  if (parsed.rows.length) {
    const prior = await prisma.adsConsoleRow.findMany({
      where: { import: { status: 'COMMITTED' } },
      select: {
        windowStart: true, windowEnd: true, campaignId: true, adGroupId: true, adId: true,
        targetId: true, searchTerm: true, placement: true, marketplace: true,
        impressions: true, clicks: true, costCents: true, salesCents: true, purchases: true,
      },
    })
    const k = (r: {
      windowStart: Date | string; windowEnd: Date | string; campaignId: string
      adGroupId: string | null; adId: string | null; targetId: string | null
      searchTerm: string | null; placement: string | null; marketplace: string
    }) => [
      typeof r.windowStart === 'string' ? r.windowStart : r.windowStart.toISOString().slice(0, 10),
      typeof r.windowEnd === 'string' ? r.windowEnd : r.windowEnd.toISOString().slice(0, 10),
      r.campaignId, r.adGroupId ?? '', r.adId ?? '', r.targetId ?? '',
      r.searchTerm ?? '', r.placement ?? '', r.marketplace,
    ].join('')
    const priorMap = new Map(prior.map((p) => [k(p), p]))
    for (const r of parsed.rows) {
      const p = priorMap.get(k(r))
      if (!p) rowsNew++
      else if (
        p.impressions === r.impressions && p.clicks === r.clicks &&
        p.costCents === r.costCents && p.salesCents === r.salesCents && p.purchases === r.purchases
      ) rowsUnchanged++
      else rowsConflicting++
    }
  }

  const rec = await prisma.adsConsoleImport.create({
    data: {
      fileName, fileSize, status: parsed.rows.length ? 'PREVIEW' : 'FAILED',
      rowsRead: parsed.rowsRead, rowsMerged: parsed.rowsMerged,
      rowsNew, rowsUnchanged, rowsConflicting,
      rowsSkipped: parsed.rowsSkipped, rowsErrored: parsed.errors.length,
      windowStart: parsed.windowStart ? new Date(`${parsed.windowStart}T00:00:00Z`) : null,
      windowEnd: parsed.windowEnd ? new Date(`${parsed.windowEnd}T00:00:00Z`) : null,
      impressions: BigInt(parsed.totals.impressions),
      clicks: BigInt(parsed.totals.clicks),
      costCents: BigInt(parsed.totals.costCents),
      salesCents: BigInt(parsed.totals.salesCents),
      purchases: parsed.totals.purchases,
      errors: parsed.errors.slice(0, ERROR_CAP) as unknown as object,
      notes: parsed.errors.length > ERROR_CAP
        ? `${parsed.errors.length} errors; the first ${ERROR_CAP} are recorded.`
        : null,
    },
  })

  // The parsed rows are held on the preview row itself so COMMIT does not need
  // the file again — an operator who previews, walks away and returns to commit
  // must get exactly the rows they were shown, not a re-parse of something else.
  if (parsed.rows.length) {
    await writeRows(rec.id, parsed.rows)
  }

  return {
    importId: rec.id,
    fileName,
    status: rec.status,
    rowsRead: parsed.rowsRead,
    rowsMerged: parsed.rowsMerged,
    rowsNew, rowsUnchanged, rowsConflicting,
    rowsSkipped: parsed.rowsSkipped,
    rowsErrored: parsed.errors.length,
    windowStart: parsed.windowStart,
    windowEnd: parsed.windowEnd,
    totals: parsed.totals,
    errors: parsed.errors.slice(0, 50),
    sample: parsed.rows.slice(0, 8),
  }
}

async function writeRows(importId: string, rows: ParsedRow[]): Promise<void> {
  const CHUNK = 2_000
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.adsConsoleRow.createMany({
      data: rows.slice(i, i + CHUNK).map((r) => ({
        importId,
        windowStart: new Date(`${r.windowStart}T00:00:00Z`),
        windowEnd: new Date(`${r.windowEnd}T00:00:00Z`),
        marketplace: r.marketplace, adProduct: r.adProduct,
        campaignId: r.campaignId, campaignName: r.campaignName, portfolioName: r.portfolioName,
        adGroupId: r.adGroupId, adGroupName: r.adGroupName, adId: r.adId,
        asin: r.asin, sku: r.sku, placement: r.placement,
        targetId: r.targetId, targeting: r.targeting, matchType: r.matchType,
        searchTerm: r.searchTerm,
        impressions: r.impressions, clicks: r.clicks, costCents: r.costCents,
        salesCents: r.salesCents, purchases: r.purchases, sourceRows: r.sourceRows,
      })),
      skipDuplicates: true,
    })
  }
}

/** Promote a previewed import to COMMITTED. Rows are already stored. */
export async function commitImport(importId: string): Promise<{ ok: true; rows: number }> {
  const rec = await prisma.adsConsoleImport.findUnique({ where: { id: importId } })
  if (!rec) throw new Error('Import not found')
  if (rec.status === 'COMMITTED') throw new Error('This import was already committed')
  if (rec.status === 'FAILED') throw new Error('This import failed to parse and cannot be committed')
  const rows = await prisma.adsConsoleRow.count({ where: { importId } })
  await prisma.adsConsoleImport.update({
    where: { id: importId },
    data: { status: 'COMMITTED', committedAt: new Date() },
  })
  return { ok: true, rows }
}

/** Discard a preview and everything it staged. */
export async function discardImport(importId: string): Promise<void> {
  const rec = await prisma.adsConsoleImport.findUnique({ where: { id: importId } })
  if (!rec) throw new Error('Import not found')
  if (rec.status === 'COMMITTED') throw new Error('A committed import cannot be discarded here')
  await prisma.adsConsoleImport.delete({ where: { id: importId } })
}

export async function listImports() {
  const rows = await prisma.adsConsoleImport.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
  return rows.map((r) => ({
    id: r.id, fileName: r.fileName, fileSize: r.fileSize, status: r.status,
    rowsRead: r.rowsRead, rowsMerged: r.rowsMerged, rowsNew: r.rowsNew,
    rowsUnchanged: r.rowsUnchanged, rowsConflicting: r.rowsConflicting,
    rowsSkipped: r.rowsSkipped, rowsErrored: r.rowsErrored,
    windowStart: r.windowStart?.toISOString().slice(0, 10) ?? null,
    windowEnd: r.windowEnd?.toISOString().slice(0, 10) ?? null,
    impressions: Number(r.impressions), clicks: Number(r.clicks),
    costCents: Number(r.costCents), salesCents: Number(r.salesCents), purchases: r.purchases,
    createdAt: r.createdAt.toISOString(),
    committedAt: r.committedAt?.toISOString() ?? null,
  }))
}

/** The error file: one row per problem, naming the field and the offending value. */
export async function errorCsv(importId: string): Promise<{ filename: string; body: Buffer }> {
  const rec = await prisma.adsConsoleImport.findUnique({ where: { id: importId } })
  if (!rec) throw new Error('Import not found')
  const errs = (rec.errors as unknown as ImportError[] | null) ?? []
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = ['Line,Field,Offending value,Problem']
  for (const e of errs) lines.push([e.line, e.field, e.value, e.message].map(esc).join(','))
  return {
    filename: `import-errors-${rec.fileName.replace(/\.[^.]+$/, '')}.csv`,
    body: Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8'),
  }
}
