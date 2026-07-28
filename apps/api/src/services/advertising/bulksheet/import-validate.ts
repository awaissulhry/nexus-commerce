/**
 * AX-IE.4 — parse and validate an uploaded bulksheet. Writes NOTHING.
 *
 * Two stages, in this order, because the order is the whole design:
 *
 *   Structural (all-or-nothing) — is this even the right kind of file? Wrong
 *     answer here means one clear message, not 40,000 row errors.
 *   Row (never fail fast) — validate EVERY row and collect every problem. The
 *     old importer validated inside the apply loop, so a bad row 900 left rows
 *     1-899 already written with no plan and no record of intent.
 *
 * Nothing is written to Amazon or to our own ad tables here. The output is a
 * plan, which AX-IE.5 previews and AX-IE.6 applies.
 */

import {
  resolveColumn, validateRow, normHeader, HEADERS,
  ROW_KEY_HEADER, BASELINE_HEADER, BULKSHEET_SCHEMA_VERSION,
  type RowVerdict,
} from '@nexus/shared/ads-bulksheet'
import { createReader, type ParsedSheet } from './spreadsheet-adapter.js'
import { SP_SHEET, DICTIONARY_SHEET, README_SHEET, META_SHEET, PORTFOLIOS_SHEET } from './build-workbook.js'

/** Sheets we generate that are never an input. */
const NON_DATA_SHEETS = new Set([DICTIONARY_SHEET, README_SHEET, META_SHEET, PORTFOLIOS_SHEET].map(normHeader))

export interface CellIssue {
  sheet: string
  /** 1-based sheet row, so it matches what the operator sees. */
  rowNumber: number
  column?: string
  /** A1-style address the operator can navigate to, e.g. "Sponsored Products!F412". */
  cellAddress?: string
  message: string
  receivedValue?: string
}

export interface StagedRow {
  sheet: string
  rowNumber: number
  entity: string | null
  operation: string | null
  rowKey: string
  baseline: string
  /** Canonical-header → trimmed string. The plan, frozen. */
  values: Record<string, string>
  status: 'READY' | 'ERROR' | 'NO_OP' | 'PREVIEW_ONLY'
  issues: CellIssue[]
}

export interface ValidationResult {
  ok: boolean
  /** Set when the file is rejected outright; row validation never ran. */
  structuralError?: string
  sheet?: string
  meta: Record<string, string>
  schemaMismatch?: string
  headers: string[]
  unknownColumns: string[]
  missingColumns: string[]
  counts: { total: number; ready: number; noOp: number; previewOnly: number; errors: number }
  issues: CellIssue[]
  issuesTruncated: boolean
  rows: StagedRow[]
}

/** A cap so a garbage file cannot OOM the worker while still being useful. */
export const MAX_ISSUES = 5000
export const MAX_ROWS = 100_000

/** 0-based column index → spreadsheet letters (0 → A, 26 → AA). */
export function columnLetter(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/**
 * Magic-byte sniff. `.xlsx` is a ZIP, so it must start `PK\x03\x04`. Checking
 * the bytes rather than the filename or the browser-supplied MIME type, both of
 * which are attacker-controlled.
 */
export function looksLikeXlsx(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

/**
 * Zip-bomb defence, run BEFORE any parsing.
 *
 * The upload cap bounds the COMPRESSED size; a 50 MB zip bomb can expand to
 * many gigabytes. Read the central directory ourselves and refuse on entry count
 * or total uncompressed size, so the decompressor is never pointed at it.
 */
export function assertNotZipBomb(
  buf: Buffer,
  opts: { maxEntries?: number; maxUncompressed?: number } = {},
): { entries: number; uncompressed: number } {
  const maxEntries = opts.maxEntries ?? 512
  const maxUncompressed = opts.maxUncompressed ?? 600 * 1024 * 1024

  // End of Central Directory: scan back from the tail (comment is <= 64 KB).
  const scanFrom = Math.max(0, buf.length - 66 * 1024)
  let eocd = -1
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a readable .xlsx — the ZIP directory is missing or the file is truncated.')

  const entries = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entries > maxEntries) throw new Error(`Refused: the file contains ${entries} internal entries (limit ${maxEntries}).`)
  // 0xFFFFFFFF means ZIP64, whose sizes live in an extra field we do not parse.
  // Refusing is the safe answer — a legitimate bulksheet is never ZIP64.
  if (cdOffset === 0xffffffff) throw new Error('Refused: ZIP64 archives are not accepted.')

  let p = cdOffset
  let uncompressed = 0
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length) throw new Error('Refused: the ZIP directory is malformed.')
    if (!(buf[p] === 0x50 && buf[p + 1] === 0x4b && buf[p + 2] === 0x01 && buf[p + 3] === 0x02)) {
      throw new Error('Refused: the ZIP directory is malformed.')
    }
    const size = buf.readUInt32LE(p + 24)
    if (size === 0xffffffff) throw new Error('Refused: ZIP64 entry sizes are not accepted.')
    uncompressed += size
    if (uncompressed > maxUncompressed) {
      throw new Error(`Refused: the file expands to more than ${Math.round(maxUncompressed / 1024 / 1024)} MB when decompressed.`)
    }
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return { entries, uncompressed }
}

/** Pick the data sheet: our own name if present, else whichever looks most like it. */
function pickDataSheet(sheets: ParsedSheet[]): ParsedSheet | null {
  const candidates = sheets.filter((s) => !NON_DATA_SHEETS.has(normHeader(s.name)))
  if (!candidates.length) return null
  const exact = candidates.find((s) => normHeader(s.name) === normHeader(SP_SHEET))
  if (exact) return exact
  // Most recognised headers wins — tolerates a renamed tab, which operators do.
  return candidates
    .map((s) => ({ s, score: s.headers.filter((h) => resolveColumn(h)).length }))
    .sort((a, b) => b.score - a.score)[0]!.s
}

function readMeta(sheets: ParsedSheet[]): Record<string, string> {
  const meta = sheets.find((s) => normHeader(s.name) === normHeader(META_SHEET))
  if (!meta) return {}
  const out: Record<string, string> = {}
  for (const r of meta.rows) {
    const [k, v] = Object.values(r.cells)
    if (k) out[k] = v ?? ''
  }
  return out
}

export async function validateBulksheet(buf: Buffer): Promise<ValidationResult> {
  const empty: ValidationResult = {
    ok: false, meta: {}, headers: [], unknownColumns: [], missingColumns: [],
    counts: { total: 0, ready: 0, noOp: 0, previewOnly: 0, errors: 0 },
    issues: [], issuesTruncated: false, rows: [],
  }

  const reader = await createReader()
  let sheets: ParsedSheet[]
  try {
    sheets = await reader.read(buf)
  } catch (e) {
    return { ...empty, structuralError: `Could not read the file: ${(e as Error).message}` }
  }

  const sheet = pickDataSheet(sheets)
  if (!sheet) return { ...empty, structuralError: 'No data sheet found. Expected a sheet of bulksheet rows alongside README/Dictionary.' }

  const meta = readMeta(sheets)
  const result: ValidationResult = { ...empty, sheet: sheet.name, meta, headers: sheet.headers }

  // ── Structural, all-or-nothing ──────────────────────────────────────
  // Columns are matched by NAME (slug + alias table), never by position:
  // analysts reorder columns and insert scratch ones, and punishing that makes
  // the file hostile to work in. Extra columns are allowed and reported.
  const resolved = new Map<string, string>() // canonical header → the sheet's own header
  const unknown: string[] = []
  for (const h of sheet.headers) {
    if (!h) continue
    if (h === ROW_KEY_HEADER || h === BASELINE_HEADER) { resolved.set(h, h); continue }
    const col = resolveColumn(h)
    if (col) { if (!resolved.has(col.header)) resolved.set(col.header, h) } else unknown.push(h)
  }
  result.unknownColumns = unknown

  if (!resolved.has('Entity')) {
    return {
      ...result,
      structuralError: `This does not look like a bulksheet: no "Entity" column. Found: ${sheet.headers.filter(Boolean).slice(0, 12).join(', ') || '(none)'}. Download a fresh template and edit that.`,
    }
  }
  result.missingColumns = HEADERS.filter((h) => !resolved.has(h))

  if (meta.schemaVersion && meta.schemaVersion !== BULKSHEET_SCHEMA_VERSION) {
    // A warning, not a rejection: columns are matched by name, so an older file
    // still imports. Say so rather than silently accepting a stale shape.
    result.schemaMismatch = `File was produced with schema ${meta.schemaVersion}; current is ${BULKSHEET_SCHEMA_VERSION}. Columns are matched by name, so this usually still works.`
  }

  if (sheet.rows.length > MAX_ROWS) {
    return { ...result, structuralError: `File has ${sheet.rows.length} rows; the limit is ${MAX_ROWS}. Split it by campaign type or date range.` }
  }

  // ── Row validation, never fail fast ─────────────────────────────────
  const headerIndex = new Map(sheet.headers.map((h, i) => [h, i]))
  const issues: CellIssue[] = []
  let truncated = false
  const addr = (own: string | undefined, rowNumber: number): string | undefined => {
    if (!own) return undefined
    const i = headerIndex.get(own)
    return i == null ? undefined : `${sheet.name}!${columnLetter(i)}${rowNumber}`
  }

  for (const r of sheet.rows) {
    // Accessor over CANONICAL headers, resolving whatever the sheet actually calls them.
    const get = (canonical: string): string => {
      const own = resolved.get(canonical)
      return own ? (r.cells[own] ?? '') : ''
    }
    const verdict: RowVerdict = validateRow(get)

    const rowIssues: CellIssue[] = verdict.issues.map((i) => {
      const own = i.column ? resolved.get(i.column) ?? i.column : undefined
      return {
        sheet: sheet.name,
        rowNumber: r.rowNumber,
        column: i.column,
        cellAddress: addr(own, r.rowNumber),
        message: i.message,
        receivedValue: i.column ? get(i.column) || undefined : undefined,
      }
    })

    for (const i of rowIssues) {
      if (issues.length >= MAX_ISSUES) { truncated = true; break }
      issues.push(i)
    }

    const values: Record<string, string> = {}
    for (const canonical of resolved.keys()) {
      const v = get(canonical)
      if (v) values[canonical] = v
    }

    const status: StagedRow['status'] = !verdict.ok ? 'ERROR'
      : verdict.readOnly ? 'NO_OP'
      : verdict.previewOnly ? 'PREVIEW_ONLY'
      : 'READY'

    result.rows.push({
      sheet: sheet.name,
      rowNumber: r.rowNumber,
      entity: verdict.entity,
      operation: verdict.operation,
      rowKey: get(ROW_KEY_HEADER),
      baseline: get(BASELINE_HEADER),
      values,
      status,
      issues: rowIssues,
    })
  }

  const c = result.counts
  for (const row of result.rows) {
    c.total++
    if (row.status === 'ERROR') c.errors++
    else if (row.status === 'NO_OP') c.noOp++
    else if (row.status === 'PREVIEW_ONLY') c.previewOnly++
    else c.ready++
  }
  result.issues = issues
  result.issuesTruncated = truncated
  // "ok" means the file is usable, not that every row is perfect — refusing
  // 4,000 good rows over 3 bad ones is user-hostile.
  result.ok = c.total > 0
  return result
}

// ── Streaming path ────────────────────────────────────────────────────

/** Everything the buffered result carries EXCEPT the rows, which are handed out in batches. */
export type StreamValidationResult = Omit<ValidationResult, 'rows'>

/**
 * Validate a bulksheet off disk, batching staged rows to a sink.
 *
 * Same verdicts as `validateBulksheet` — it shares `validateRow` — but it never
 * holds the whole plan. The buffered path measured 1.4 GB RSS on a 100k-row
 * file; this one is bounded by the batch size, so the documented 100k cap is a
 * cap we can actually honour rather than one that takes the container down.
 */
export async function validateBulksheetStreaming(
  filePath: string,
  sink: (batch: StagedRow[]) => Promise<void>,
  opts: { batchSize?: number; onProgress?: (rows: number) => void } = {},
): Promise<StreamValidationResult> {
  const batchSize = opts.batchSize ?? 2000
  const { streamWorkbook, isExcelJsStreamOrderingBug } = await import('./spreadsheet-adapter.js')

  /**
   * ExcelJS's streaming reader throws on workbooks whose zip orders
   * `workbook.xml.rels` before `workbook.xml` (its own unguarded `this.model`).
   * The buffered reader does not care about part order, so fall back to it —
   * bounded by size, because buffering is what costs 1.4 GB on a 5.5 MB file and
   * a big file must fail loudly rather than take the process with it.
   */
  const FALLBACK_MAX_BYTES = 8 * 1024 * 1024
  const bufferedFallback = async (): Promise<StreamValidationResult> => {
    const { statSync, readFileSync } = await import('node:fs')
    const size = statSync(filePath).size
    if (size > FALLBACK_MAX_BYTES) {
      return {
        ok: false, meta: {}, headers: [], unknownColumns: [], missingColumns: [],
        counts: { total: 0, ready: 0, noOp: 0, previewOnly: 0, errors: 0 },
        issues: [], issuesTruncated: false,
        structuralError: 'This workbook is laid out in a way our streaming reader cannot follow, and it is too large to read the slower way. Open it in Excel or Numbers, "Save As" a fresh .xlsx, and upload that.',
      }
    }
    const res = await validateBulksheet(readFileSync(filePath))
    const { rows, ...rest } = res
    for (let i = 0; i < rows.length; i += batchSize) await sink(rows.slice(i, i + batchSize))
    return rest
  }

  const out: StreamValidationResult = {
    ok: false, meta: {}, headers: [], unknownColumns: [], missingColumns: [],
    counts: { total: 0, ready: 0, noOp: 0, previewOnly: 0, errors: 0 },
    issues: [], issuesTruncated: false,
  }

  let resolved: Map<string, string> | null = null
  let headerIndex: Map<string, number> = new Map()
  let dataSheet = ''
  let batch: StagedRow[] = []
  let structural: string | null = null

  const flush = async () => {
    if (!batch.length) return
    await sink(batch)
    batch = []
  }

  let streamed: Awaited<ReturnType<typeof streamWorkbook>>
  try {
    streamed = await streamWorkbook(filePath, async (row, headers) => {
      if (structural) return
      // First data sheet encountered wins; the generated sheets are skipped below.
      if (!resolved) {
        dataSheet = row.sheet
        out.headers = headers
        resolved = new Map()
        const unknown: string[] = []
        headers.forEach((h, i) => {
          if (!h) return
          headerIndex.set(h, i)
          if (h === ROW_KEY_HEADER || h === BASELINE_HEADER) { resolved!.set(h, h); return }
          const col = resolveColumn(h)
          if (col) { if (!resolved!.has(col.header)) resolved!.set(col.header, h) } else unknown.push(h)
        })
        out.unknownColumns = unknown
        out.sheet = dataSheet
        if (!resolved.has('Entity')) {
          structural = `This does not look like a bulksheet: no "Entity" column. Found: ${headers.filter(Boolean).slice(0, 12).join(', ') || '(none)'}. Download a fresh template and edit that.`
          return
        }
        out.missingColumns = HEADERS.filter((h) => !resolved!.has(h))
      }
      if (row.sheet !== dataSheet) return

      if (out.counts.total >= MAX_ROWS) {
        structural = `File has more than ${MAX_ROWS} rows. Split it by campaign type or date range.`
        return
      }

      const get = (canonical: string): string => {
        const own = resolved!.get(canonical)
        return own ? (row.cells[own] ?? '') : ''
      }
      const verdict: RowVerdict = validateRow(get)

      const rowIssues: CellIssue[] = verdict.issues.map((i) => {
        const own = i.column ? resolved!.get(i.column) ?? i.column : undefined
        const idx = own ? headerIndex.get(own) : undefined
        return {
          sheet: dataSheet,
          rowNumber: row.rowNumber,
          column: i.column,
          cellAddress: idx == null ? undefined : `${dataSheet}!${columnLetter(idx)}${row.rowNumber}`,
          message: i.message,
          receivedValue: i.column ? get(i.column) || undefined : undefined,
        }
      })
      for (const i of rowIssues) {
        if (out.issues.length >= MAX_ISSUES) { out.issuesTruncated = true; break }
        out.issues.push(i)
      }

      const values: Record<string, string> = {}
      for (const canonical of resolved.keys()) {
        const v = get(canonical)
        if (v) values[canonical] = v
      }
      const status: StagedRow['status'] = !verdict.ok ? 'ERROR'
        : verdict.readOnly ? 'NO_OP'
        : verdict.previewOnly ? 'PREVIEW_ONLY'
        : 'READY'

      out.counts.total++
      if (status === 'ERROR') out.counts.errors++
      else if (status === 'NO_OP') out.counts.noOp++
      else if (status === 'PREVIEW_ONLY') out.counts.previewOnly++
      else out.counts.ready++

      batch.push({
        sheet: dataSheet, rowNumber: row.rowNumber, entity: verdict.entity, operation: verdict.operation,
        rowKey: get(ROW_KEY_HEADER), baseline: get(BASELINE_HEADER), values, status, issues: rowIssues,
      })
      if (batch.length >= batchSize) {
        await flush()
        opts.onProgress?.(out.counts.total)
        // Yield so a long file cannot monopolise the event loop.
        await new Promise((r) => setImmediate(r))
      }
    }, { skipSheets: (name) => NON_DATA_SHEETS.has(normHeader(name)) })
  } catch (e) {
    if (!isExcelJsStreamOrderingBug(e)) throw e
    // Anything already staged is discarded by the caller re-staging from scratch;
    // the fallback re-reads the whole file.
    return bufferedFallback()
  }

  await flush()

  if (structural) return { ...out, structuralError: structural }
  if (!resolved) {
    return { ...out, structuralError: 'No data sheet found. Expected a sheet of bulksheet rows alongside README/Dictionary.' }
  }
  // _meta is one of the skipped sheets, so pull it from the sheet list we walked.
  void streamed
  out.ok = out.counts.total > 0
  return out
}
