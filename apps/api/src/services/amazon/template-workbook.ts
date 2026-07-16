/**
 * A2 (XLSM hybrid) — Amazon official Custom Listings Template workbook reader.
 *
 * Amazon Seller Central's downloadable category templates (.xlsm) cannot go
 * through the generic exceljs path:
 *   • exceljs needs minutes on their 1 MB+ defined-names tables (measured on
 *     real Xavia templates — it never completed within 240 s), and
 *   • the data lives on a localized "Modello"/"Vorlage"/"Plantilla"/"Modèle"
 *     sheet with labels on row 4, attribute paths on row 5 and data from
 *     row 7 — invisible to a first-sheet/first-row parser.
 *
 * This module reads only what the import needs straight out of the OOXML zip
 * (jszip is already an api dependency): the sheet list, shared strings, and
 * the template sheet's rows, via linear string walks (no DOM). Real-file
 * cost is tens of milliseconds.
 *
 * Grammars recognized:
 *   • v2 (current downloads): template-sheet A1 holds a
 *     `settings=feedType=256&…` blob (templateIdentifier / headerLanguageTag /
 *     primaryMarketplaceId…); the attribute row uses SP-API listings paths
 *     (`item_name[marketplace_id=…][language_tag=…]#1.value`, `::record_action`).
 *   • legacy `TemplateType=fptcustom…`: plain snake_case ids (item_sku…).
 *
 * Detection requires a DENSE attribute row (≥ MIN_ATTR_CELLS attribute-like
 * cells in one of the first SCAN_ROWS rows). The vertical "Definizioni dati"
 * dictionary sheet also contains attribute paths but never a dense row; a
 * settings/TemplateType marker in A1 takes priority when present. Verified
 * against AIREON IT/DE/ES/FR (COAT+PANTS) and X-RACING IT (APPAREL),
 * including the DE/ES/FR files whose worksheet rels use absolute `/xl/…`
 * targets.
 *
 * Security: macros are inert bytes we never read or execute; only the few
 * entries named below are inflated.
 */

import JSZip from 'jszip'
import { MARKETPLACE_ID_TO_CODE } from '../../utils/marketplace-code.js'

const SCAN_ROWS = 8
const MIN_ATTR_CELLS = 20
/** Refuse to inflate any single zip entry beyond this (zip-bomb guard). */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

export type RecordAction = 'replace' | 'partial' | 'delete' | 'unknown'

export interface AmazonTemplateMeta {
  grammar: 'v2' | 'legacy'
  sheet: string
  attrRow: number
  /** First worksheet row that contained data (after skipping blanks). */
  dataStartRow: number | null
  templateIdentifier?: string
  headerLanguageTag?: string
  contentLanguageTag?: string
  /** Raw id from the settings blob, `amzn1.mp.o.` prefix stripped (e.g. APJ6JRA9NG5V4). */
  primaryMarketplaceId?: string
  /** 2-letter code resolved from primaryMarketplaceId (e.g. 'IT'), when known. */
  marketplace?: string
  feedType?: string
  /** Distinct product_type values found in the data rows (upper-cased). */
  productTypes: string[]
  /** Canonical ::record_action histogram over data rows. */
  actions: Record<RecordAction, number>
  skippedEmptyRows: number
}

export interface AmazonTemplateParse {
  /** Verbatim attribute paths from the attr row, in column order. */
  headers: string[]
  /** header → localized label (the row above the attr row), when present. */
  labels: Record<string, string>
  /**
   * Data rows keyed by verbatim header. Every row additionally carries
   * `__action` (canonical RecordAction) so the wizard can filter delete rows
   * without re-deriving localized tokens.
   */
  rows: Record<string, string>[]
  meta: AmazonTemplateMeta
}

// ── XML micro-helpers (linear walks — no DOM, no backtracking) ───────────────

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
}

export function decodeXml(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(?:amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (m) => {
    const known = ENTITIES[m]
    if (known) return known
    const num = m.startsWith('&#x') || m.startsWith('&#X')
      ? parseInt(m.slice(3, -1), 16)
      : parseInt(m.slice(2, -1), 10)
    return Number.isFinite(num) ? String.fromCodePoint(num) : m
  })
}

/** Parse attributes out of a single XML open tag (values are double-quoted in OOXML). */
function tagAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w:.-]+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag)) !== null) out[m[1]] = decodeXml(m[2])
  return out
}

/** Concatenate the text of every <t> element inside an XML block. */
function joinTexts(block: string): string {
  let out = ''
  let i = 0
  while (true) {
    const open = block.indexOf('<t', i)
    if (open === -1) break
    const after = block[open + 2]
    if (after !== '>' && after !== ' ' && after !== '/') { i = open + 2; continue }
    const end = block.indexOf('>', open)
    if (end === -1) break
    if (block[end - 1] === '/') { i = end + 1; continue } // <t/>
    const close = block.indexOf('</t>', end)
    if (close === -1) break
    out += decodeXml(block.slice(end + 1, close))
    i = close + 4
  }
  return out
}

function colLettersToNum(letters: string): number {
  let c = 0
  for (let i = 0; i < letters.length; i++) c = c * 26 + (letters.charCodeAt(i) - 64)
  return c
}

export interface SheetRow { rowNum: number; cells: Map<number, string> }

/**
 * Walk the `<row>` elements of a worksheet XML string. `onRow` returns false
 * to stop early (used by the cheap first-rows scan).
 */
function walkSheetRows(xml: string, sst: string[], onRow: (row: SheetRow) => boolean | void): void {
  let i = 0
  let syntheticRow = 0
  while (true) {
    const open = xml.indexOf('<row', i)
    if (open === -1) return
    const openEnd = xml.indexOf('>', open)
    if (openEnd === -1) return
    const openTag = xml.slice(open, openEnd + 1)
    const attrs = tagAttrs(openTag)
    const rowNum = attrs.r ? parseInt(attrs.r, 10) : syntheticRow + 1
    syntheticRow = rowNum
    let block = ''
    if (xml[openEnd - 1] === '/') {
      i = openEnd + 1 // <row/> — empty
    } else {
      const close = xml.indexOf('</row>', openEnd)
      if (close === -1) return
      block = xml.slice(openEnd + 1, close)
      i = close + 6
    }
    const cells = new Map<number, string>()
    if (block) parseCells(block, sst, cells)
    if (onRow({ rowNum, cells }) === false) return
  }
}

function parseCells(rowBlock: string, sst: string[], out: Map<number, string>): void {
  let i = 0
  let syntheticCol = 0
  while (true) {
    const open = rowBlock.indexOf('<c', i)
    if (open === -1) return
    const after = rowBlock[open + 2]
    if (after !== ' ' && after !== '>' && after !== '/') { i = open + 2; continue }
    const openEnd = rowBlock.indexOf('>', open)
    if (openEnd === -1) return
    const attrs = tagAttrs(rowBlock.slice(open, openEnd + 1))
    const ref = attrs.r ?? ''
    const m = /^([A-Z]+)\d+$/.exec(ref)
    const col = m ? colLettersToNum(m[1]) : syntheticCol + 1
    syntheticCol = col
    let value = ''
    if (rowBlock[openEnd - 1] === '/') {
      i = openEnd + 1 // <c/> — blank
    } else {
      const close = rowBlock.indexOf('</c>', openEnd)
      if (close === -1) return
      const inner = rowBlock.slice(openEnd + 1, close)
      i = close + 4
      const t = attrs.t ?? ''
      if (t === 'inlineStr') {
        value = joinTexts(inner)
      } else {
        const vOpen = inner.indexOf('<v>')
        if (vOpen !== -1) {
          const vClose = inner.indexOf('</v>', vOpen)
          if (vClose !== -1) {
            const raw = decodeXml(inner.slice(vOpen + 3, vClose))
            if (t === 's') {
              const idx = parseInt(raw, 10)
              value = Number.isFinite(idx) ? (sst[idx] ?? '') : ''
            } else if (t === 'b') {
              value = raw === '1' ? 'true' : 'false'
            } else {
              value = raw
            }
          }
        }
      }
    }
    if (value !== '') out.set(col, value)
  }
}

// ── Zip plumbing ──────────────────────────────────────────────────────────────

async function readEntry(zip: JSZip, name: string): Promise<string | null> {
  const entry = zip.file(name)
  if (!entry) return null
  const buf = await entry.async('uint8array')
  if (buf.length > MAX_ENTRY_BYTES) {
    throw new Error(`Workbook part ${name} is unreasonably large (${buf.length} bytes)`)
  }
  return Buffer.from(buf).toString('utf-8')
}

async function sheetList(zip: JSZip): Promise<Array<{ name: string; target: string }>> {
  const relsXml = await readEntry(zip, 'xl/_rels/workbook.xml.rels')
  const wbXml = await readEntry(zip, 'xl/workbook.xml')
  if (!relsXml || !wbXml) return []
  const rels: Record<string, string> = {}
  {
    const re = /<Relationship\b[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(relsXml)) !== null) {
      const a = tagAttrs(m[0])
      if (a.Id && a.Target) rels[a.Id] = a.Target
    }
  }
  // Sheets are declared before definedNames — slice to </sheets> so the walk
  // never touches the megabyte of valid-values named ranges.
  const sheetsEnd = wbXml.indexOf('</sheets>')
  const head = sheetsEnd === -1 ? wbXml : wbXml.slice(0, sheetsEnd)
  const out: Array<{ name: string; target: string }> = []
  const re = /<sheet\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(head)) !== null) {
    const a = tagAttrs(m[0])
    const rid = a['r:id'] ?? a.id
    let target = (rid && rels[rid]) || ''
    if (!target) continue
    // DE/ES/FR templates store ABSOLUTE targets ("/xl/worksheets/sheet1.xml");
    // IT stores relative ("worksheets/sheet1.xml"). Normalize both.
    target = target.replace(/^\//, '')
    if (!target.startsWith('xl/')) target = `xl/${target}`
    out.push({ name: a.name ?? target, target })
  }
  return out
}

async function sharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await readEntry(zip, 'xl/sharedStrings.xml')
  if (!xml) return []
  const out: string[] = []
  let i = 0
  while (true) {
    const open = xml.indexOf('<si>', i)
    const openAlt = xml.indexOf('<si ', i)
    const start = open === -1 ? openAlt : openAlt === -1 ? open : Math.min(open, openAlt)
    if (start === -1) break
    const close = xml.indexOf('</si>', start)
    if (close === -1) break
    out.push(joinTexts(xml.slice(start, close)))
    i = close + 5
  }
  return out
}

// ── Record-action classification ─────────────────────────────────────────────

const PARTIAL_MARKERS = ['parzial', 'partial', 'teilweise', 'partiel', 'parcial']
const DELETE_MARKERS = ['elimina', 'löschen', 'loschen', 'supprimer', 'borrar', 'delete']
const REPLACE_MARKERS = [
  'crea', 'sostituisci', 'erstellen', 'ersetzen', 'créer', 'creer', 'remplacer',
  'crear', 'reemplazar', 'create', 'replace', 'update', 'modifica', 'aktualisieren',
]

/**
 * Map a localized ::record_action cell to its canonical meaning. Blank = the
 * template default ("create or replace"). Delete is checked first — it is the
 * only destructive action and must never be mistaken for anything else.
 */
export function classifyRecordAction(raw: string | null | undefined): RecordAction {
  const s = (raw ?? '').trim().toLowerCase()
  if (s === '') return 'replace'
  if (DELETE_MARKERS.some((m) => s.includes(m))) return 'delete'
  if (PARTIAL_MARKERS.some((m) => s.includes(m))) return 'partial'
  if (REPLACE_MARKERS.some((m) => s.includes(m))) return 'replace'
  return 'unknown'
}

// ── Settings blob (v2 A1 cell) ───────────────────────────────────────────────

function parseSettingsBlob(a1: string): Record<string, string> {
  // Shape: `settings=feedType=256&timestamp=…&primaryMarketplaceId=amzn1.mp.o.APJ…&…`
  const out: Record<string, string> = {}
  const body = a1.startsWith('settings=') ? a1.slice('settings='.length) : a1
  for (const pair of body.split('&')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq)
    let value = pair.slice(eq + 1)
    try { value = decodeURIComponent(value) } catch { /* keep raw */ }
    out[key] = value
  }
  return out
}

// ── Detection + parse ────────────────────────────────────────────────────────

function isAttrPathCell(v: string): boolean {
  return v.startsWith('::') || /#\d+\./.test(v)
}

function findAttrRow(rows: SheetRow[]): { attrRow: SheetRow; grammar: 'v2' | 'legacy' } | null {
  for (const row of rows) {
    let attrLike = 0
    let hasItemSku = false
    for (const v of row.cells.values()) {
      if (isAttrPathCell(v)) attrLike++
      if (v === 'item_sku') hasItemSku = true
    }
    if (attrLike >= MIN_ATTR_CELLS) return { attrRow: row, grammar: 'v2' }
    if (hasItemSku && row.cells.size >= MIN_ATTR_CELLS) return { attrRow: row, grammar: 'legacy' }
  }
  return null
}

/** A2b — list a workbook's sheet names (fast zip walk; null when not OOXML). */
export async function listOoxmlSheets(bytes: Uint8Array): Promise<string[] | null> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return null
  }
  const sheets = await sheetList(zip)
  return sheets.length > 0 ? sheets.map((s) => s.name) : null
}

export interface GenericSheetParse {
  headers: string[]
  rows: Record<string, string>[]
  sheet: string
  headerRow: number
  sheets: string[]
}

/**
 * A2b — generic fast parse of ONE sheet of an OOXML workbook (operator sheet /
 * header-row override). Values come back as raw strings (numbers unformatted,
 * date serials verbatim) — the coerce stage owns typing. Used instead of
 * exceljs for overrides because template workbooks' side sheets (e.g. the
 * megarow "Valori validi") stall exceljs for minutes.
 */
export async function parseOoxmlSheet(
  bytes: Uint8Array,
  opts?: { sheet?: string; headerRow?: number },
): Promise<GenericSheetParse | null> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return null
  }
  const sheets = await sheetList(zip)
  if (sheets.length === 0) return null
  const chosen = opts?.sheet ? sheets.find((s) => s.name === opts.sheet) : sheets[0]
  if (!chosen) {
    throw new Error(`Sheet "${opts?.sheet}" not found — workbook has: ${sheets.map((s) => s.name).join(', ')}`)
  }
  const xml = await readEntry(zip, chosen.target)
  if (!xml) return null
  const sst = await sharedStrings(zip)

  let headerRowNum = opts?.headerRow ?? null
  let headerCells: Map<number, string> | null = null
  const rows: Record<string, string>[] = []
  let headers: string[] = []
  let colOrder: number[] = []

  walkSheetRows(xml, sst, (row) => {
    if (headerCells === null) {
      if (headerRowNum === null && row.cells.size > 0) headerRowNum = row.rowNum
      if (headerRowNum !== null && row.rowNum >= headerRowNum) {
        if (row.rowNum > headerRowNum || row.cells.size === 0) {
          // requested header row was empty/absent — treat as no headers
          headerCells = new Map()
          return false
        }
        headerCells = row.cells
        const sorted = [...headerCells.entries()].sort((a, b) => a[0] - b[0])
        colOrder = sorted.map(([c]) => c)
        // dedupe like services/import/parsers.ts (Price / Price__2)
        const seen = new Map<string, number>()
        headers = sorted.map(([, v]) => {
          const t = v.trim()
          if (!seen.has(t)) { seen.set(t, 1); return t }
          const n = (seen.get(t) ?? 1) + 1
          seen.set(t, n)
          return `${t}__${n}`
        })
      }
      return
    }
    if (headers.length === 0) return false
    const obj: Record<string, string> = {}
    let any = false
    for (let i = 0; i < headers.length; i++) {
      const v = row.cells.get(colOrder[i]) ?? ''
      obj[headers[i]] = v
      if (v !== '') any = true
    }
    if (any) rows.push(obj)
  })

  if (!headers.length) {
    throw new Error(
      `No headers found on sheet "${chosen.name}"${opts?.headerRow ? ` at row ${opts.headerRow}` : ''} — pick a different sheet or header row`,
    )
  }
  return { headers, rows, sheet: chosen.name, headerRow: headerRowNum ?? 1, sheets: sheets.map((s) => s.name) }
}

/**
 * Detect + parse an Amazon official listings template inside OOXML bytes.
 * Returns null when the workbook is not an Amazon template (the caller then
 * falls back to the generic exceljs parser).
 */
export async function detectAmazonTemplate(bytes: Uint8Array): Promise<AmazonTemplateParse | null> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return null // not a zip — not ours to handle
  }
  const sheets = await sheetList(zip)
  if (sheets.length === 0) return null
  const sst = await sharedStrings(zip)

  // Cheap scan: first SCAN_ROWS rows of every sheet. Prefer a sheet whose A1
  // carries the settings/TemplateType marker; fall back to any dense attr row.
  interface Candidate { name: string; xml: string; head: SheetRow[]; hasMarker: boolean }
  const candidates: Candidate[] = []
  for (const s of sheets) {
    const xml = await readEntry(zip, s.target)
    if (!xml) continue
    const head: SheetRow[] = []
    walkSheetRows(xml, sst, (row) => {
      if (row.rowNum > SCAN_ROWS) return false
      head.push(row)
    })
    const a1 = head.find((r) => r.rowNum === 1)?.cells.get(1) ?? ''
    const hasMarker = a1.startsWith('settings=') || a1.startsWith('TemplateType=')
    candidates.push({ name: s.name, xml, head, hasMarker })
  }
  const ordered = [...candidates.filter((c) => c.hasMarker), ...candidates.filter((c) => !c.hasMarker)]
  let chosen: { c: Candidate; attrRow: SheetRow; grammar: 'v2' | 'legacy' } | null = null
  for (const c of ordered) {
    const found = findAttrRow(c.head)
    if (found) { chosen = { c, attrRow: found.attrRow, grammar: found.grammar }; break }
  }
  if (!chosen) return null

  const { c, attrRow, grammar } = chosen
  const attrCols = [...attrRow.cells.entries()].sort((a, b) => a[0] - b[0])
  const headers = attrCols.map(([, v]) => v)
  const colByHeaderOrder = attrCols.map(([col]) => col)

  // Localized labels = the row directly above the attr row (v2 row 4; legacy row 2).
  const labelRow = c.head.find((r) => r.rowNum === attrRow.rowNum - 1)
  const labels: Record<string, string> = {}
  if (labelRow) {
    for (let i = 0; i < headers.length; i++) {
      const lbl = labelRow.cells.get(colByHeaderOrder[i])
      if (lbl) labels[headers[i]] = lbl
    }
  }

  const a1 = c.head.find((r) => r.rowNum === 1)?.cells.get(1) ?? ''
  const settings = grammar === 'v2' && a1.startsWith('settings=') ? parseSettingsBlob(a1) : {}
  const rawMpId = settings.primaryMarketplaceId ?? ''
  const mpId = rawMpId.replace(/^amzn1\.mp\.o\./, '')

  // Column indexes for row classification.
  const skuHeaderIdx = headers.findIndex(
    (h) => h === 'item_sku' || h.startsWith('contribution_sku'),
  )
  const actionIdx = headers.findIndex((h) => h === '::record_action')
  const typeIdx = headers.findIndex(
    (h) => h === 'feed_product_type' || h.startsWith('product_type'),
  )

  const rows: Record<string, string>[] = []
  const actions: Record<RecordAction, number> = { replace: 0, partial: 0, delete: 0, unknown: 0 }
  const productTypes = new Set<string>()
  let skippedEmptyRows = 0
  let dataStartRow: number | null = null

  walkSheetRows(c.xml, sst, (row) => {
    if (row.rowNum <= attrRow.rowNum) return
    let any = false
    const obj: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) {
      const v = row.cells.get(colByHeaderOrder[i]) ?? ''
      obj[headers[i]] = v
      if (v !== '') any = true
    }
    if (!any) { skippedEmptyRows++; return }
    // A row with content but no SKU is almost always a stray label/example row —
    // keep it only when it has real breadth (>2 filled cells) so merge logic can
    // surface it as "missing SKU" rather than silently dropping operator data.
    const sku = skuHeaderIdx >= 0 ? obj[headers[skuHeaderIdx]] : ''
    const filled = Object.values(obj).filter((v) => v !== '').length
    if (sku === '' && filled <= 2) { skippedEmptyRows++; return }
    const action = classifyRecordAction(actionIdx >= 0 ? obj[headers[actionIdx]] : '')
    ;(obj as Record<string, string>).__action = action
    actions[action]++
    if (typeIdx >= 0 && obj[headers[typeIdx]]) productTypes.add(obj[headers[typeIdx]].toUpperCase())
    if (dataStartRow === null) dataStartRow = row.rowNum
    rows.push(obj)
  })

  return {
    headers,
    labels,
    rows,
    meta: {
      grammar,
      sheet: c.name,
      attrRow: attrRow.rowNum,
      dataStartRow,
      templateIdentifier: settings.templateIdentifier || undefined,
      headerLanguageTag: settings.headerLanguageTag || undefined,
      contentLanguageTag: settings.contentLanguageTag || undefined,
      primaryMarketplaceId: mpId || undefined,
      marketplace: MARKETPLACE_ID_TO_CODE[mpId] ?? undefined,
      feedType: settings.feedType || undefined,
      productTypes: [...productTypes].sort(),
      actions,
      skippedEmptyRows,
    },
  }
}
