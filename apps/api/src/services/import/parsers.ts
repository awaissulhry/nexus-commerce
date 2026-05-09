/**
 * W8.2 — Pure parsers for the import wizard.
 *
 * Each parser ingests raw bytes / text and emits a uniform shape:
 *
 *   { headers: string[], rows: Record<string, unknown>[] }
 *
 * Header detection rules:
 *   - CSV / XLSX: first non-empty row is the header. Cells are
 *     trimmed; duplicate headers get a numeric suffix ('Price' /
 *     'Price__2').
 *   - JSON: array of objects → headers are the union of keys (in
 *     first-seen order). Single object → headers are its keys.
 *
 * Pure-ish: no DB, no Prisma. xlsx is parsed via the existing
 * exceljs dep already in apps/api/package.json.
 */

import { parse as parseCsvSync } from 'csv-parse/sync'
import ExcelJS from 'exceljs'

export type FileKind = 'csv' | 'xlsx' | 'json'

export interface ParsedFile {
  headers: string[]
  rows: Record<string, unknown>[]
}

/**
 * Detect file kind from a filename. Falls back to 'csv' when the
 * extension is missing — caller can override via an explicit
 * fileKind argument when the upload-source is e.g. 'application/
 * json' but the filename has no extension.
 */
export function detectFileKind(filename: string | null | undefined): FileKind {
  if (!filename) return 'csv'
  const lower = filename.toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx'
  if (lower.endsWith('.json')) return 'json'
  return 'csv'
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((h) => {
    const trimmed = (h ?? '').toString().trim()
    if (!seen.has(trimmed)) {
      seen.set(trimmed, 1)
      return trimmed
    }
    const next = (seen.get(trimmed) ?? 1) + 1
    seen.set(trimmed, next)
    return `${trimmed}__${next}`
  })
}

export function parseCsv(text: string): ParsedFile {
  // csv-parse can do header-aware parsing in one pass, but we want
  // to control the dedupe semantics ourselves (our normalisation
  // is consistent with XLSX above) — so parse rows, lift the first
  // non-empty as headers, and zip.
  const records = parseCsvSync(text, {
    skip_empty_lines: true,
    relax_column_count: true,
  }) as string[][]
  if (records.length === 0) return { headers: [], rows: [] }
  const headers = dedupeHeaders(records[0])
  const rows: Record<string, unknown>[] = []
  for (let i = 1; i < records.length; i++) {
    const cells = records[i]
    const obj: Record<string, unknown> = {}
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cells[c] ?? ''
    }
    rows.push(obj)
  }
  return { headers, rows }
}

export async function parseXlsx(bytes: Uint8Array): Promise<ParsedFile> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  const sheet = wb.worksheets[0]
  if (!sheet) return { headers: [], rows: [] }
  const headers: string[] = []
  const rows: Record<string, unknown>[] = []
  let headerRowIdx: number | null = null
  sheet.eachRow({ includeEmpty: false }, (row, rowIdx) => {
    if (headerRowIdx === null) {
      const raw: string[] = []
      for (let i = 1; i <= sheet.actualColumnCount; i++) {
        const v = row.getCell(i).value
        raw.push(v == null ? '' : String(v))
      }
      headers.push(...dedupeHeaders(raw))
      headerRowIdx = rowIdx
      return
    }
    const obj: Record<string, unknown> = {}
    for (let c = 0; c < headers.length; c++) {
      const cell = row.getCell(c + 1)
      const raw = cell.value
      // ExcelJS returns rich objects for some cell types — coerce
      // to scalar where possible.
      let coerced: unknown = raw
      if (raw && typeof raw === 'object' && 'text' in raw) {
        coerced = (raw as { text?: unknown }).text ?? null
      } else if (raw && typeof raw === 'object' && 'result' in raw) {
        coerced = (raw as { result?: unknown }).result ?? null
      }
      obj[headers[c]] = coerced ?? ''
    }
    rows.push(obj)
  })
  return { headers, rows }
}

export function parseJson(text: string): ParsedFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(
      `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { headers: [], rows: [] }
    if (typeof parsed[0] !== 'object' || parsed[0] === null) {
      throw new Error('JSON array must contain objects')
    }
    const headerSet = new Set<string>()
    for (const row of parsed as Array<Record<string, unknown>>) {
      for (const k of Object.keys(row)) headerSet.add(k)
    }
    const headers = Array.from(headerSet)
    const rows = (parsed as Array<Record<string, unknown>>).map((r) => {
      const out: Record<string, unknown> = {}
      for (const h of headers) out[h] = (r as Record<string, unknown>)[h] ?? ''
      return out
    })
    return { headers, rows }
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>
    const headers = Object.keys(obj)
    return { headers, rows: [obj] }
  }
  throw new Error('JSON root must be an object or array of objects')
}

/**
 * One-stop dispatcher. Use detectFileKind() if you don't already
 * have the kind in hand.
 */
export async function parseFile(
  kind: FileKind,
  payload: { text?: string; bytes?: Uint8Array },
): Promise<ParsedFile> {
  if (kind === 'csv') {
    if (payload.text == null) throw new Error('csv parser needs text payload')
    return parseCsv(payload.text)
  }
  if (kind === 'json') {
    if (payload.text == null) throw new Error('json parser needs text payload')
    return parseJson(payload.text)
  }
  if (kind === 'xlsx') {
    if (payload.bytes == null) throw new Error('xlsx parser needs bytes payload')
    return parseXlsx(payload.bytes)
  }
  throw new Error(`Unknown file kind: ${kind as string}`)
}
