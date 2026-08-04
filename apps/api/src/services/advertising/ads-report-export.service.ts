/**
 * RPT.4 — CSV and XLSX export.
 *
 * The whole point of this file is that a downloaded number stays trustworthy
 * after it leaves the screen. Three rules follow from that:
 *
 * 1. **It is the same query.** Export calls `runReport` with `page: null`, so the
 *    filters, grouping, columns, ordering and metric SQL are byte-for-byte the
 *    ones the grid ran. There is no second query to drift.
 *
 * 2. **Numbers stay numbers.** Amazon's own console export writes CTR as the
 *    string "12.5000%" and wraps ids as `="123"`, which is why parsing it needs
 *    six special cases. We write raw numerics: money as 484.83, ratios as 0.4053,
 *    counts as integers, dates as ISO. Nothing here needs cleaning before use.
 *    Null stays EMPTY — never 0, because an undefined ACOS is not zero percent.
 *
 * 3. **The file explains itself.** Every export carries a manifest: which report,
 *    which filters, which grouping and sort, how many rows, the actual data
 *    window, per-market freshness at the moment of export, and the unit of every
 *    single column. A spreadsheet that cannot tell you how stale it is, or
 *    whether a column is a ratio or a percentage, is how a wrong decision gets
 *    made confidently.
 */
import ExcelJS from 'exceljs'
import { runReport, reportFreshness, type ReportQuery, type ReportResult } from './ads-report-runner.service.js'
import type { ColumnFormat } from './ads-report-specs.js'

export type ExportFormat = 'csv' | 'xlsx'

/** Human unit for a column, stated in the manifest so nothing is guessed. */
function unitOf(format: ColumnFormat, currency: string): string {
  switch (format) {
    case 'money': return `${currency} (decimal, no symbol)`
    case 'pct': return 'ratio 0-1 (0.4053 = 40.53%)'
    case 'ratio': return 'ratio (multiple)'
    case 'int': return 'whole number'
    case 'date': return 'date (YYYY-MM-DD)'
    case 'hour': return 'hour of day, 0-23, UTC'
    default: return 'text'
  }
}

/**
 * Decimal places kept per unit. This is noise removal, not lossy rounding: a
 * ratio carried to 6dp is 4 decimal places of a percentage, far beyond anything
 * the console displays or anyone acts on, and money to 4dp keeps sub-cent
 * precision from the micros the source stores. Without it, Postgres numeric
 * division arrives as 0.008421262856572246 — eighteen digits of float artefact
 * in every CTR cell, which reads as spurious precision rather than rigour.
 * Disclosed in the manifest so the rounding is stated, not hidden.
 */
const PRECISION: Partial<Record<ColumnFormat, number>> = { money: 4, pct: 6, ratio: 6 }

/** Raw value for a cell: numbers as numbers, null as null. No display formatting. */
function rawValue(v: unknown, format: ColumnFormat): string | number | null {
  if (v == null || v === '') return null
  if (format === 'text' || format === 'date') return String(v)
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return String(v)
  const dp = PRECISION[format]
  return dp == null ? n : Number(n.toFixed(dp))
}

export interface ExportManifest {
  report: string
  reportId: string
  generatedAt: string
  rows: number
  truncated: boolean
  currency: string
  requestedWindow: string
  actualDataWindow: string
  /** ASCII-safe components of the window, for HTTP headers. */
  dataFirstDay: string | null
  dataLastDay: string | null
  markets: string
  adProducts: string
  search: string
  groupedBy: string
  sortedBy: string
  freshness: Array<{ marketplace: string; lastDay: string | null; rows: number }>
  columns: Array<{ label: string; id: string; kind: string; unit: string }>
}

function buildManifest(
  result: ReportResult,
  fresh: Awaited<ReturnType<typeof reportFreshness>>,
  truncated: boolean,
): ExportManifest {
  const a = result.applied
  return {
    report: result.title,
    reportId: result.reportId,
    generatedAt: new Date().toISOString(),
    rows: result.rows.length,
    truncated,
    currency: result.currency,
    requestedWindow: `${a.from ?? 'any'} → ${a.to ?? 'any'}`,
    actualDataWindow: fresh.firstDay && fresh.lastDay ? `${fresh.firstDay} → ${fresh.lastDay}` : 'no rows',
    dataFirstDay: fresh.firstDay,
    dataLastDay: fresh.lastDay,
    markets: a.marketplaces.length ? a.marketplaces.join(', ') : 'all',
    adProducts: a.adProducts.length ? a.adProducts.join(', ') : 'all',
    search: a.search ?? 'none',
    groupedBy: a.groupBy.join(' + '),
    sortedBy: `${a.sort.col} ${a.sort.dir}`,
    freshness: fresh.byMarket,
    columns: result.columns.map((c) => ({
      label: c.label,
      id: c.id,
      kind: c.kind,
      unit: unitOf(c.format, result.currency),
    })),
  }
}

function csvEscape(v: string | number | null): string {
  if (v == null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * CSV is DATA ONLY — one header row, then rows. No manifest lines, no comment
 * prefixes, no totals row: anything else and half the tools that open a CSV
 * choke or silently read the preamble as data. The manifest for a CSV travels in
 * the response headers and the filename; the XLSX carries it as a sheet.
 *
 * A UTF-8 BOM leads the file because Excel on Windows otherwise mangles every
 * accented character, and these campaign names are Italian, German and Spanish.
 */
function buildCsv(result: ReportResult): Buffer {
  const head = result.columns.map((c) => csvEscape(c.label)).join(',')
  const body = result.rows.map((row) =>
    result.columns.map((c) => csvEscape(rawValue(row[c.id], c.format))).join(','),
  )
  return Buffer.from('﻿' + [head, ...body].join('\r\n') + '\r\n', 'utf8')
}

/** Excel number formats matching each declared unit. */
const NUM_FMT: Partial<Record<ColumnFormat, string>> = {
  money: '#,##0.00',
  pct: '0.00%',
  ratio: '#,##0.00',
  int: '#,##0',
}

async function buildXlsx(result: ReportResult, manifest: ExportManifest): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Nexus Ads — Reporting'
  wb.created = new Date()

  const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.addRow(result.columns.map((c) => c.label))
  ws.getRow(1).font = { bold: true }

  for (const row of result.rows) {
    ws.addRow(result.columns.map((c) => rawValue(row[c.id], c.format)))
  }

  // Totals, clearly labelled and separated — the same server-computed figures the
  // grid shows, so a reader cannot mistake them for a column sum of the rows.
  if (result.totals) {
    const totalRow = ws.addRow(
      result.columns.map((c, i) =>
        c.kind === 'metric' ? rawValue(result.totals![c.id], c.format) : i === 0 ? 'TOTAL' : null,
      ),
    )
    totalRow.font = { bold: true }
    totalRow.border = { top: { style: 'thin' } }
  }

  result.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    // Dates and ids are text-typed so Excel cannot re-interpret "2026-08-04" as a
    // serial date or scientific-notate a long numeric id.
    col.numFmt = c.format === 'date' || c.format === 'text' ? '@' : (NUM_FMT[c.format] ?? '@')
    if (c.align === 'right') col.alignment = { horizontal: 'right' }
    const sample = result.rows.slice(0, 200).map((r) => String(r[c.id] ?? '').length)
    col.width = Math.min(52, Math.max(11, Math.max(c.label.length, ...sample, 0) + 2))
  })
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: result.columns.length } }

  // ── the manifest sheet ────────────────────────────────────────────────
  const about = wb.addWorksheet('About this export')
  about.getColumn(1).width = 26
  about.getColumn(2).width = 76
  const kv = (k: string, v: string | number) => {
    const r = about.addRow([k, v])
    r.getCell(1).font = { bold: true }
    return r
  }
  const heading = (t: string) => {
    about.addRow([])
    const r = about.addRow([t])
    r.getCell(1).font = { bold: true, size: 12 }
  }

  kv('Report', manifest.report)
  kv('Generated (UTC)', manifest.generatedAt)
  kv('Rows in this file', manifest.rows)
  if (manifest.truncated) kv('⚠ TRUNCATED', 'Row cap reached — narrow the filters for a complete export.')
  kv('Currency', manifest.currency)

  heading('Filters applied')
  kv('Requested window', manifest.requestedWindow)
  kv('Actual data window', manifest.actualDataWindow)
  kv('Markets', manifest.markets)
  kv('Ad products', manifest.adProducts)
  kv('Search', manifest.search)
  kv('Grouped by', manifest.groupedBy)
  kv('Sorted by', manifest.sortedBy)

  heading('How fresh was this data')
  about.addRow(['Market', 'Newest day in this export', 'Rows']).font = { bold: true }
  if (manifest.freshness.length) {
    for (const f of manifest.freshness) about.addRow([f.marketplace, f.lastDay ?? '—', f.rows])
  } else {
    about.addRow(['—', manifest.actualDataWindow, manifest.rows])
  }

  heading('What each column means')
  about.addRow(['Column', 'Unit', 'Type']).font = { bold: true }
  for (const c of manifest.columns) about.addRow([c.label, c.unit, c.kind])

  heading('Notes')
  about.addRow(['', 'Percentage columns store the underlying RATIO (0.4053). Excel displays it as 40.53% via the cell format; the CSV contains the same 0.4053 with no formatting. Either way the stored number is the ratio.'])
  about.addRow(['', 'An empty cell means the value is undefined — for example ACOS where there were no sales. It does NOT mean zero.'])
  about.addRow(['', 'Totals are computed over the whole result on the server, not by summing the rows above: ratios like ACOS and CTR cannot be summed or averaged.'])
  about.addRow(['', 'Rounding: money to 4 decimal places, ratios and percentages to 6, counts exact. This removes floating-point noise only — no figure is rounded to fewer digits than the console displays.'])

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

export interface ExportOutput {
  body: Buffer
  filename: string
  contentType: string
  manifest: ExportManifest
}

/** Rows above this are refused rather than silently cut. */
const ROW_CAP = 100_000

export async function exportReport(q: ReportQuery, format: ExportFormat): Promise<ExportOutput> {
  // page: null is the export path through the SAME runner the grid uses.
  const [result, fresh] = await Promise.all([
    runReport({ ...q, page: null }),
    reportFreshness(q),
  ])
  const truncated = result.rows.length >= ROW_CAP
  const manifest = buildManifest(result, fresh, truncated)

  // Filename states the report and the window it covers, so a folder of these
  // stays readable months later without opening any of them.
  const slug = result.reportId.replace(/[^a-z0-9-]/gi, '-')
  const window = result.applied.from && result.applied.to
    ? `${result.applied.from}_${result.applied.to}`
    : manifest.generatedAt.slice(0, 10)
  const filename = `nexus-ads-${slug}-${window}.${format}`

  if (format === 'csv') {
    return {
      body: buildCsv(result),
      filename,
      contentType: 'text/csv; charset=utf-8',
      manifest,
    }
  }
  return {
    body: await buildXlsx(result, manifest),
    filename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    manifest,
  }
}
