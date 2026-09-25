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
/** CFI — separates a repeated attribute key from its occurrence number (`<key>␟2`). */
export const DUPLICATE_MARK = '\u241F'
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
  /**
   * CFI (R-CFI-1) — the template's own blank-action default (`AttributeDefaultValues`, e.g.
   * `full_update`) as its wire value; absent when the file carries none.
   */
  recordActionDefault?: string
  /** CFI — cells whose value is Excel's saved result of a formula: worksheet row → verbatim headers. */
  formulaCells?: Record<number, string[]>
  /** CFI — cells holding an Excel error (`#N/A`, `#REF!`…): worksheet row → verbatim headers. */
  errorCells?: Record<number, string[]>
  /** CFI — populated cells in a column that has no attribute key (strict mode keeps them, never throws). */
  orphanCells?: { row: number; column: string; value: string }[]
  /** CFI — non-empty rows between the key row and the template's first data row (Amazon's example row). */
  skippedRows?: { row: number; reason: string; cells: Record<string, string> }[]
  /** CFI — a key that appears in more than one column: the later columns are keyed `<key>␟<n>`. */
  duplicateHeaders?: string[]
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
  /** Original worksheet coordinates, including gaps between product rows. */
  rowNumbers: number[]
  /** Amazon's own localized label → wire value dictionary, keyed by exact attribute path. */
  valueAliases: Record<string, Record<string, string>>
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

export interface SheetRow { rowNum: number; cells: Map<number, string>; formulas?: Set<number>; errors?: Set<number> }

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
    const formulas = new Set<number>(), errors = new Set<number>()
    if (block) parseCells(block, sst, cells, formulas, errors)
    if (onRow({ rowNum, cells, formulas, errors }) === false) return
  }
}

function parseCells(rowBlock: string, sst: string[], out: Map<number, string>, formulas?: Set<number>, errors?: Set<number>): void {
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
      // CFI — the cached <v> of a formula cell IS what Excel shows; remember the coordinate so the
      // importer can say the value was computed, instead of refusing the whole workbook.
      if (/<f(?:\s|\/?>)/.test(inner)) formulas?.add(col)
      if (t === 'e') errors?.add(col)
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
    // One forward search per item (CFI, L1 measured 823 ms → the two-form search re-scanned the
    // whole ~1 MB string for the form a file never uses, once per string).
    let start = xml.indexOf('<si', i)
    while (start !== -1 && xml[start + 3] !== '>' && xml[start + 3] !== ' ') start = xml.indexOf('<si', start + 3)
    if (start === -1) break
    const close = xml.indexOf('</si>', start)
    if (close === -1) break
    out.push(joinTexts(xml.slice(start, close)))
    i = close + 5
  }
  return out
}

// ── Record-action classification ─────────────────────────────────────────────

const PARTIAL_MARKERS = ['parzial', 'partial', 'teilweise', 'teilaktualisierung', 'partiel', 'parcial']
const DELETE_MARKERS = ['elimina', 'löschen', 'loschen', 'löschung', 'loschung', 'supprimer', 'suppression', 'borrar', 'delete']
const REPLACE_MARKERS = [
  'crea', 'sostituisci', 'erstellen', 'ersetzen', 'créer', 'creer', 'remplacer',
  'crear', 'reemplazar', 'create', 'replace', 'update', 'modifica', 'aktualisieren',
  // old flat file `update_delete` labels (full update); the partial forms are caught first above
  'aggiornamento', 'aktualisierung', 'mise à jour', 'mise a jour', 'actualización', 'actualizacion',
]

/**
 * CFI (R-CFI-1) — Amazon's own action wire values, and the old flat file's `update_delete` values
 * (English wire values; the localized ones are covered by the markers above). The template's own
 * dictionary (`attributeSettings` aliases for `::record_action`) always wins over any list here.
 */
const ACTION_WIRE: Record<string, RecordAction> = {
  full_update: 'replace', create_or_replace: 'replace', update: 'replace',
  partial_update: 'partial', partialupdate: 'partial',
  delete: 'delete',
}

/** The template's own record-action dictionary: localized label → wire value, and the blank default. */
export interface RecordActionDictionary { aliases?: Record<string, string>; defaultWire?: string }

/**
 * Map a localized ::record_action cell to its canonical meaning. Blank = the
 * template default ("create or replace", or the file's `AttributeDefaultValues`).
 * Delete is checked first — it is the only destructive action and must never be
 * mistaken for anything else.
 *
 * CFI — the template's OWN dictionary decides first (every current template ships one:
 * `Bearbeiten (Teilaktualisierung)` → `partial_update`, measured 2026-09-25 on the Owner's corpus);
 * the word markers are only the fallback for files that carry no dictionary (old flat files).
 */
export function classifyRecordAction(raw: string | null | undefined, dictionary?: RecordActionDictionary): RecordAction {
  const s = (raw ?? '').trim()
  if (s === '') return dictionary?.defaultWire ? ACTION_WIRE[dictionary.defaultWire.trim().toLowerCase()] ?? 'unknown' : 'replace'
  const aliased = dictionary?.aliases && Object.prototype.hasOwnProperty.call(dictionary.aliases, s) ? dictionary.aliases[s] : undefined
  const wire = (aliased ?? s).trim().toLowerCase()
  if (ACTION_WIRE[wire]) return ACTION_WIRE[wire]
  if (aliased !== undefined) return 'unknown' // the template named it, but not an action we know
  if (DELETE_MARKERS.some((m) => wire.includes(m))) return 'delete'
  if (PARTIAL_MARKERS.some((m) => wire.includes(m))) return 'partial'
  if (REPLACE_MARKERS.some((m) => wire.includes(m))) return 'replace'
  return 'unknown'
}

// ── Old flat file (fptcustom) keys → current attribute paths ─────────────────

/**
 * CFI (R-CFI-1) — Amazon's classic flat-file column ids, rewritten to the attribute-path grammar
 * of the current templates, so one mapper serves both. The old files carry NO machine map of their
 * own (their `AttributePTDMAP` sheet only lists which ids apply to which product type — measured on
 * the Owner's corpus 2026-09-25), so this is Amazon's documented legacy→JSON rename, not a family
 * or market rule. A key not listed falls back to "same name, `.value` leaf"; whatever the current
 * category schema does not know is refused per column by the importer, never silently dropped.
 * `{n}` = the numeric suffix of the key (`bullet_point3` → slot 3).
 */
const LEGACY_RENAMES: Record<string, string> = {
  item_sku: 'contribution_sku#1.value',
  feed_product_type: 'product_type#1.value',
  update_delete: '::record_action',
  external_product_id: 'amzn1.volt.ca.product_id_value',
  external_product_id_type: 'amzn1.volt.ca.product_id_type',
  parent_child: 'parentage_level#1.value',
  parent_sku: 'child_parent_sku_relationship#1.parent_sku',
  relationship_type: 'child_parent_sku_relationship#1.child_relationship_type',
  variation_theme: 'variation_theme#1.name',
  brand_name: 'brand#1.value',
  item_name: 'item_name#1.value',
  product_description: 'product_description#1.value',
  bullet_point: 'bullet_point#{n}.value',
  generic_keywords: 'generic_keyword#1.value',
  special_features: 'special_feature#{n}.value',
  target_audience_keywords: 'target_audience_keyword#{n}.value',
  material_type: 'material#{n}.value',
  occasion_type: 'occasion_type#{n}.value',
  sport_type: 'sport_type#{n}.value',
  supplier_declared_dg_hz_regulation: 'supplier_declared_dg_hz_regulation#{n}.value',
  supplier_declared_material_regulation: 'supplier_declared_material_regulation#{n}.value',
  main_image_url: 'main_product_image_locator#1.media_location',
  swatch_image_url: 'swatch_product_image_locator#1.media_location',
  other_image_url: 'other_product_image_locator_{n}#1.media_location',
  color_name: 'color#1.value',
  color_map: 'color#1.standardized_values#1',
  size_name: 'size#1.value',
  department_name: 'department#1.value',
  closure_type: 'closure#1.type#1.value',
  sleeve_type: 'sleeve#1.type#1.value',
  model: 'model_number#1.value',
  style_name: 'style#1.value',
  pattern_name: 'pattern#1.value',
  outer_material_type: 'outer#1.material#1.value',
  inner_material_type: 'inner#1.material#1.value',
  are_batteries_included: 'batteries_included#1.value',
  list_price_with_tax: 'list_price#1.value_with_tax',
  list_price: 'list_price#1.value',
  standard_price: 'purchasable_offer#1.our_price#1.schedule#1.value_with_tax',
  sale_price: 'purchasable_offer#1.discounted_price#1.schedule#1.value_with_tax',
  sale_from_date: 'purchasable_offer#1.discounted_price#1.schedule#1.start_at',
  sale_end_date: 'purchasable_offer#1.discounted_price#1.schedule#1.end_at',
  map_price: 'purchasable_offer#1.map_price#1.schedule#1.value_with_tax',
  offering_start_date: 'purchasable_offer#1.start_at.value',
  offering_end_date: 'purchasable_offer#1.end_at.value',
  currency: 'purchasable_offer#1.currency',
  quantity: 'fulfillment_availability#1.quantity',
  fulfillment_latency: 'fulfillment_availability#1.lead_time_to_ship_max_days',
  restock_date: 'fulfillment_availability#1.restock_date',
  fulfillment_center_id: 'fulfillment_availability#1.fulfillment_channel_code',
  merchant_shipping_group_name: 'merchant_shipping_group#1.value',
  offering_can_be_gift_messaged: 'gift_options#1.can_be_messaged',
  offering_can_be_giftwrapped: 'gift_options#1.can_be_wrapped',
  apparel_size_system: 'apparel_size#1.size_system', apparel_size_class: 'apparel_size#1.size_class', apparel_size: 'apparel_size#1.size',
  apparel_size_to: 'apparel_size#1.size_to', apparel_body_type: 'apparel_size#1.body_type', apparel_height_type: 'apparel_size#1.height_type',
  bottoms_size_system: 'bottoms_size#1.size_system', bottoms_size_class: 'bottoms_size#1.size_class', bottoms_size: 'bottoms_size#1.size',
  bottoms_size_to: 'bottoms_size#1.size_to', bottoms_body_type: 'bottoms_size#1.body_type', bottoms_height_type: 'bottoms_size#1.height_type',
  bottoms_waist_size: 'bottoms_size#1.waist_size', bottoms_inseam_size: 'bottoms_size#1.inseam_size',
  package_height: 'item_package_dimensions#1.height#1.value', package_length: 'item_package_dimensions#1.length#1.value',
  package_width: 'item_package_dimensions#1.width#1.value', package_weight: 'item_package_weight#1.value',
}
/** `<base>_unit_of_measure` keys: the base's own path with a `unit` leaf. */
const LEGACY_UNIT_SUFFIX = '_unit_of_measure'

/** CFI — a classic flat-file id as a current attribute path, or null when it is not a flat-file id. */
export function legacyAttributePath(key: string): string | null {
  const id = key.trim()
  if (!id || id.startsWith('::') || id.includes('[') || /#\d+/.test(id) || id.startsWith('amzn1.')) return null // already current grammar
  if (id.endsWith(LEGACY_UNIT_SUFFIX)) {
    const base = legacyAttributePath(id.slice(0, -LEGACY_UNIT_SUFFIX.length))
    return base ? base.replace(/\.value$/, '') + '.unit' : null
  }
  const ps = /^other_image_url_(ps\d+)$/i.exec(id)
  if (ps) return `image_locator_${ps[1].toLowerCase()}#1.media_location`
  if (LEGACY_RENAMES[id]) return LEGACY_RENAMES[id].replace('{n}', '1')
  const numbered = /^(.*?[a-z_])(\d+)$/.exec(id)
  if (numbered && LEGACY_RENAMES[numbered[1]]) return LEGACY_RENAMES[numbered[1]].replace('{n}', String(Number(numbered[2])))
  if (numbered) return `${numbered[1]}#${Number(numbered[2])}.value`
  return `${id}#1.value`
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
    // CFI — an old flat file's key row can carry 20+ current-grammar keys too (its offer/price
    // columns per marketplace: GLOBAL files carry 11 markets), so the classic `item_sku` id decides
    // first; a current template's key row never holds it.
    if (hasItemSku && row.cells.size >= MIN_ATTR_CELLS) return { attrRow: row, grammar: 'legacy' }
    if (attrLike >= MIN_ATTR_CELLS) return { attrRow: row, grammar: 'v2' }
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
export async function detectAmazonTemplate(bytes: Uint8Array, opts: { strict?: boolean } = {}): Promise<AmazonTemplateParse | null> {
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
    if (opts.strict && ordered.some(candidate => candidate.hasMarker) && !c.hasMarker) continue
    const found = findAttrRow(c.head)
    if (found) {
      if (chosen && opts.strict) throw new Error('Multiple Amazon product sheets were found. Import each marketplace workbook separately.')
      chosen = { c, attrRow: found.attrRow, grammar: found.grammar }
      if (!opts.strict) break
    }
  }
  if (!chosen) return null

  const { c, attrRow, grammar } = chosen
  const attrCols = [...attrRow.cells.entries()].sort((a, b) => a[0] - b[0])
  // CFI — a key in two columns no longer refuses the workbook: the later column is keyed
  // `<key>␟<n>` and the importer decides per cell (same value → kept once; different → refused).
  const seenHeaders = new Map<string, number>(), duplicateHeaders: string[] = []
  // Lenient callers (the flat-file page, the vault export) keep their verbatim header list.
  const headers = attrCols.map(([, v]) => {
    const n = (seenHeaders.get(v) ?? 0) + 1
    seenHeaders.set(v, n)
    if (n === 1 || !opts.strict) return v
    duplicateHeaders.push(`${v}${DUPLICATE_MARK}${n}`)
    return `${v}${DUPLICATE_MARK}${n}`
  })
  const colByHeaderOrder = attrCols.map(([col]) => col)
  const headerByCol = new Map(colByHeaderOrder.map((col, i) => [col, headers[i]]))

  // Localized labels = the row directly above the attr row (v2 row 4; legacy row 2).
  const labelRow = c.head.find((r) => r.rowNum === attrRow.rowNum - 1)
  const labels: Record<string, string> = {}
  if (labelRow) {
    for (let i = 0; i < headers.length; i++) {
      const lbl = labelRow.cells.get(colByHeaderOrder[i])
      if (lbl) labels[headers[i]] = lbl
    }
  }

  // Large dictionaries continue in B1 (settings2=), C1, …; decoding A1 alone truncates them.
  // CFI — an old flat file (`TemplateType=fptcustom` in A1) carries the same blob in a later
  // row-1 cell (D1 in the Owner's corpus: market, language, dataRow), so read it for both grammars.
  const settingsCells = c.head.find(r => r.rowNum === 1)?.cells
  const chunks = [...(settingsCells?.values() ?? [])].filter(v => /^settings\d*=/.test(v))
    .sort((a, b) => Number(a.match(/^settings(\d*)=/)?.[1] || 1) - Number(b.match(/^settings(\d*)=/)?.[1] || 1))
  const settings = chunks.length ? parseSettingsBlob(`settings=${chunks.map(v => v.slice(v.indexOf('=') + 1)).join('')}`) : {}
  const valueAliases: AmazonTemplateParse['valueAliases'] = Object.create(null)
  if (settings.attributeSettings) {
    try {
      const entries: unknown = JSON.parse(Buffer.from(settings.attributeSettings, 'base64').toString('utf8'))
      if (!Array.isArray(entries)) throw new Error('Invalid attribute settings')
      for (const entry of entries) if (typeof entry?.attribute === 'string' && entry.aliases && typeof entry.aliases === 'object') {
        valueAliases[entry.attribute] = Object.fromEntries(Object.entries(entry.aliases).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      }
    } catch { if (opts.strict) throw new Error('Amazon value translations are damaged. Download a fresh template before importing.') }
  }
  const rawMpId = settings.primaryMarketplaceId ?? ''
  const mpId = rawMpId.replace(/^amzn1\.mp\.o\./, '')
  // CFI — the blank-action default the template itself declares (`{"::record_action":"full_update"}`).
  let recordActionDefault: string | undefined
  if (settings.AttributeDefaultValues) {
    try {
      const defaults: unknown = JSON.parse(Buffer.from(settings.AttributeDefaultValues, 'base64').toString('utf8'))
      const value = (defaults as Record<string, unknown> | null)?.['::record_action']
      if (typeof value === 'string' && value.trim()) recordActionDefault = value.trim()
    } catch { /* an unreadable default is the same as none: blank stays "create or replace" */ }
  }
  const actionDictionary: RecordActionDictionary = { aliases: valueAliases['::record_action'], defaultWire: recordActionDefault }

  // Column indexes for row classification.
  const skuHeaderIdx = headers.findIndex(
    (h) => h === 'item_sku' || h.startsWith('contribution_sku'),
  )
  const actionIdx = headers.findIndex((h) => h === '::record_action' || h === 'update_delete')
  const typeIdx = headers.findIndex(
    (h) => h === 'feed_product_type' || h.startsWith('product_type'),
  )

  const rows: Record<string, string>[] = []
  const rowNumbers: number[] = []
  const formulaCells: Record<number, string[]> = {}, errorCells: Record<number, string[]> = {}
  const orphanCells: NonNullable<AmazonTemplateMeta['orphanCells']> = [], skippedRows: NonNullable<AmazonTemplateMeta['skippedRows']> = []
  const actions: Record<RecordAction, number> = { replace: 0, partial: 0, delete: 0, unknown: 0 }
  const productTypes = new Set<string>()
  let skippedEmptyRows = 0
  let dataStartRow: number | null = null

  walkSheetRows(c.xml, sst, (row) => {
    if (row.rowNum <= attrRow.rowNum) return
    if (opts.strict && settings.dataRow && row.rowNum < Number(settings.dataRow)) {
      // CFI — Amazon ships its example row (`ABC123`, "Sony"…) between the key row and the data
      // row it declares. Kept as evidence with a reason instead of vanishing.
      if (row.cells.size) skippedRows.push({ row: row.rowNum, reason: `Above the template's first data row (${settings.dataRow}): Amazon's example or instruction row`,
        cells: Object.fromEntries([...row.cells.entries()].map(([col, v]) => [headerByCol.get(col) ?? `@${numToColLetters(col)}`, v])) })
      return
    }
    if (opts.strict) for (const [col, v] of row.cells) if (!headerByCol.has(col)) orphanCells.push({ row: row.rowNum, column: numToColLetters(col), value: v })
    if (row.formulas?.size) formulaCells[row.rowNum] = [...row.formulas].map(col => headerByCol.get(col)).filter((h): h is string => !!h)
    if (row.errors?.size) errorCells[row.rowNum] = [...row.errors].map(col => headerByCol.get(col)).filter((h): h is string => !!h)
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
    if (!opts.strict && sku === '' && filled <= 2) { skippedEmptyRows++; return }
    const action = classifyRecordAction(actionIdx >= 0 ? obj[headers[actionIdx]] : '', actionDictionary)
    ;(obj as Record<string, string>).__action = action
    actions[action]++
    if (typeIdx >= 0 && obj[headers[typeIdx]]) productTypes.add(obj[headers[typeIdx]].toUpperCase())
    if (dataStartRow === null) dataStartRow = row.rowNum
    rows.push(obj)
    rowNumbers.push(row.rowNum)
  })

  return {
    headers,
    labels,
    rows,
    rowNumbers,
    valueAliases,
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
      ...(recordActionDefault ? { recordActionDefault } : {}),
      ...(Object.keys(formulaCells).length ? { formulaCells } : {}),
      ...(Object.keys(errorCells).length ? { errorCells } : {}),
      ...(orphanCells.length ? { orphanCells } : {}),
      ...(skippedRows.length ? { skippedRows } : {}),
      ...(duplicateHeaders.length ? { duplicateHeaders } : {}),
    },
  }
}

// ── A7 (XLSM hybrid) — surgical data-row rewrite (Export for Amazon) ─────────

export interface TemplateRewriteResult {
  bytes: Buffer
  meta: AmazonTemplateMeta
  headers: string[]
  rowsWritten: number
}

function numToColLetters(n: number): string {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function escXmlText(s: string): string {
  return s
    .replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // XML 1.0 forbids these outright
}

/**
 * Rewrite ONLY the Template sheet's data rows of an Amazon template workbook,
 * leaving every other byte of the zip untouched — instructions/dictionary/
 * valid-values sheets, macros (inert), named ranges, localized dropdowns and
 * the settings/label/attribute rows all survive verbatim. That is what makes
 * the output re-uploadable to Seller Central as if hand-edited in Excel.
 *
 * `dataRows` are keyed by VERBATIM template header (the attr-row path);
 * missing/empty values simply emit no cell. Cells are written as inlineStr —
 * self-contained, no sharedStrings surgery. The stale `<dimension>` hint and
 * `calcChain.xml` are dropped (Excel recomputes both; leaving them triggers
 * repair prompts).
 */
export async function rewriteTemplateDataRows(
  bytes: Uint8Array,
  dataRows: Array<Record<string, string>>,
): Promise<TemplateRewriteResult> {
  const parsed = await detectAmazonTemplate(bytes)
  if (!parsed) {
    throw new Error('Stored workbook is not an Amazon template — re-import the original template to refresh the vault')
  }
  const zip = await JSZip.loadAsync(bytes)
  const sheets = await sheetList(zip)
  const target = sheets.find((s) => s.name === parsed.meta.sheet)?.target
  if (!target) throw new Error(`Template sheet "${parsed.meta.sheet}" missing from workbook`)
  const xml = await readEntry(zip, target)
  if (!xml) throw new Error('Template sheet XML unreadable')
  const sst = await sharedStrings(zip)

  // Column position per verbatim header, from the attr row itself (first wins).
  const colByHeader = new Map<string, number>()
  walkSheetRows(xml, sst, (row) => {
    if (row.rowNum < parsed.meta.attrRow) return
    if (row.rowNum === parsed.meta.attrRow) {
      for (const [col, v] of row.cells) if (!colByHeader.has(v)) colByHeader.set(v, col)
    }
    return false
  })

  // Splice point: the first physical row at/after the original data start (or
  // anything past the attr row when the template shipped empty). Everything
  // before it — settings, labels, attrs, Amazon's blank spacer row — survives.
  const spliceFromRow = parsed.meta.dataStartRow ?? parsed.meta.attrRow + 1
  const sdClose = xml.lastIndexOf('</sheetData>')
  if (sdClose === -1) throw new Error('Template sheet has no <sheetData> block')
  let splicePos = sdClose
  {
    let i = xml.indexOf('<sheetData')
    while (i !== -1) {
      const open = xml.indexOf('<row', i)
      if (open === -1 || open >= sdClose) break
      const openEnd = xml.indexOf('>', open)
      if (openEnd === -1) break
      const attrs = tagAttrs(xml.slice(open, openEnd + 1))
      const r = attrs.r ? parseInt(attrs.r, 10) : NaN
      if (Number.isFinite(r) && r >= spliceFromRow) {
        splicePos = open
        break
      }
      i = openEnd + 1
    }
  }

  const genRows: string[] = []
  let rowNum = spliceFromRow
  for (const row of dataRows) {
    const cells: string[] = []
    for (const [header, col] of colByHeader) {
      const v = row[header]
      if (v == null || v === '') continue
      cells.push(
        `<c r="${numToColLetters(col)}${rowNum}" t="inlineStr"><is><t xml:space="preserve">${escXmlText(String(v))}</t></is></c>`,
      )
    }
    genRows.push(`<row r="${rowNum}">${cells.join('')}</row>`)
    rowNum++
  }

  let outXml = xml.slice(0, splicePos) + genRows.join('') + xml.slice(sdClose)
  outXml = outXml.replace(/<dimension[^>]*\/>/, '')
  zip.file(target, outXml)
  if (zip.file('xl/calcChain.xml')) zip.remove('xl/calcChain.xml')

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  return { bytes: out, meta: parsed.meta, headers: parsed.headers, rowsWritten: dataRows.length }
}
