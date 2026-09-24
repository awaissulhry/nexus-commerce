/**
 * CFI-1 — say what an uploaded workbook IS before anything expensive reads it.
 *
 * 🔴 The reason this exists, measured 2026-09-24 (`docs/channel-file-import/records/2026-09-24-results.md` §3):
 * the catalog page with File type "Nexus workbook" handed Amazon's own template (`GALE IT.xlsx`) to ExcelJS on
 * the API's MAIN thread and was still running after 8 min 41 s — the 2026-09-16 production-wedge class
 * (`docs/2026-09-16-studio-import-wedged-production.md`), reachable by picking the wrong option in a list. ExcelJS
 * never finishes these templates (their megabyte of valid-value named ranges); only a zip + string walk is safe.
 *
 * So this module uses JSZip and linear string walks ONLY — never ExcelJS, never a DOM — and reads no more than
 * `workbook.xml`, its relationships, the shared strings and the first rows of each sheet. The decision is made
 * from the file's own content, whatever its name or the option the operator chose:
 *
 *   amazon-template         a sheet whose A1 carries Amazon's `settings=` / `TemplateType=` marker, or whose first
 *                           rows hold a dense attribute-key row (`…#1.value`, `::record_action`, or `item_sku` +
 *                           ≥ 20 keys) — the same rule `detectAmazonTemplate` applies (template-workbook.ts:329-339)
 *   ebay-workbook           a sheet whose header row holds SKU, Parent/Child, Parent SKU and Category ID — any sheet
 *                           name (the corpus has `ebay_it` AND sheets named after the family, e.g. `AIREON`)
 *   amazon-attribute-sheet  a sheet whose header row holds Seller SKU, Product Type and Operation — the Title-Case
 *                           SP-API sheet (`amazon_OUTERWEAR_IT.xlsx`); it names no marketplace or language
 *   nexus-workbook          the Nexus manifest sheet, or only Products / Listings / Overrides (+ helper sheets)
 *   other                   anything else, including a file that is not OOXML at all
 *
 * Strict OOXML (`conformance="strict"`, purl.oclc.org namespaces — GALE IT.xlsx is one) needs nothing special: its
 * elements are unprefixed like the transitional ones. It is reported, because a namespace-bound reader breaks on it.
 */
import JSZip from 'jszip'

export type ChannelFileKind = 'amazon-template' | 'amazon-attribute-sheet' | 'ebay-workbook' | 'nexus-workbook' | 'other'

export interface WorkbookSniff {
  kind: ChannelFileKind
  /** `null` when the bytes are not an OOXML workbook. */
  flavor: 'transitional' | 'strict' | null
  sheets: string[]
  /** The sheet that decided the kind. */
  sheet?: string
  /** One operator sentence naming what the file is. */
  label: string
}

/** Rows read per sheet. Amazon's key row is row 5 (new) or row 3 (old); a header row is row 1. */
const SCAN_ROWS = 8
/** Dense-key threshold — identical to `detectAmazonTemplate`'s `MIN_ATTR_CELLS`. */
const MIN_ATTR_CELLS = 20
/** A sniff never inflates a larger part; a real template sheet is a few MB. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

const EBAY_HEADERS = ['SKU', 'Parent/Child', 'Parent SKU', 'Category ID']
const ATTRIBUTE_SHEET_HEADERS = ['Seller SKU', 'Product Type', 'Operation']
const NEXUS_DATA_SHEETS = new Set(['Products', 'Listings', 'Overrides'])
const NEXUS_HELPER_SHEETS = new Set(['Instructions', 'Dictionary', 'Effective values', 'Nexus workbook'])

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
function decodeXml(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(?:amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, m => {
    if (ENTITIES[m]) return ENTITIES[m]
    const code = /^&#x/i.test(m) ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : m
  })
}
function tagAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w:.-]+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag)) !== null) out[m[1]] = decodeXml(m[2])
  return out
}
/** The text of every `<t>` inside a block (a shared string item or an inline string). */
function joinTexts(block: string): string {
  let out = '', i = 0
  for (;;) {
    const open = block.indexOf('<t', i)
    if (open === -1) return out
    const next = block[open + 2]
    if (next !== '>' && next !== ' ' && next !== '/') { i = open + 2; continue }
    const end = block.indexOf('>', open)
    if (end === -1) return out
    if (block[end - 1] === '/') { i = end + 1; continue }
    const close = block.indexOf('</t>', end)
    if (close === -1) return out
    out += decodeXml(block.slice(end + 1, close))
    i = close + 4
  }
}
async function entry(zip: JSZip, name: string): Promise<string | null> {
  const file = zip.file(name)
  if (!file) return null
  const bytes = await file.async('uint8array')
  if (bytes.length > MAX_ENTRY_BYTES) throw new Error(`Workbook part ${name} is unreasonably large (${bytes.length} bytes)`)
  return Buffer.from(bytes).toString('utf-8')
}

/** The first `limit` non-empty rows of a worksheet, cell values resolved (shared, inline, boolean, number). */
function headRows(xml: string, strings: () => string[], limit: number): Map<number, string>[] {
  const rows: Map<number, string>[] = []
  let i = 0
  while (rows.length < limit) {
    const open = xml.indexOf('<row', i)
    if (open === -1) break
    const openEnd = xml.indexOf('>', open)
    if (openEnd === -1) break
    if (xml[openEnd - 1] === '/') { i = openEnd + 1; continue }
    const close = xml.indexOf('</row>', openEnd)
    if (close === -1) break
    const block = xml.slice(openEnd + 1, close)
    i = close + 6
    const cells = new Map<number, string>()
    let j = 0, lastCol = 0
    for (;;) {
      const c = block.indexOf('<c', j)
      if (c === -1) break
      const after = block[c + 2]
      if (after !== ' ' && after !== '>' && after !== '/') { j = c + 2; continue }
      const cEnd = block.indexOf('>', c)
      if (cEnd === -1) break
      const attrs = tagAttrs(block.slice(c, cEnd + 1))
      const letters = /^([A-Z]+)\d+$/.exec(attrs.r ?? '')?.[1]
      const col = letters ? [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) : lastCol + 1
      lastCol = col
      if (block[cEnd - 1] === '/') { j = cEnd + 1; continue }
      const cClose = block.indexOf('</c>', cEnd)
      if (cClose === -1) break
      const inner = block.slice(cEnd + 1, cClose)
      j = cClose + 4
      let value = ''
      if (attrs.t === 'inlineStr') value = joinTexts(inner)
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        if (v !== undefined) {
          const raw = decodeXml(v)
          value = attrs.t === 's' ? strings()[Number(raw)] ?? '' : attrs.t === 'b' ? (raw === '1' ? 'true' : 'false') : raw
        }
      }
      if (value !== '') cells.set(col, value.trim())
    }
    if (cells.size) rows.push(cells)
  }
  return rows
}

const isAttributeKey = (value: string) => value.startsWith('::') || /#\d+\./.test(value)
function amazonKeyRow(rows: Map<number, string>[]) {
  return rows.some(row => {
    const values = [...row.values()]
    return values.filter(isAttributeKey).length >= MIN_ATTR_CELLS || values.includes('item_sku') && row.size >= MIN_ATTR_CELLS
  })
}
const holds = (row: Map<number, string> | undefined, names: string[]) => !!row && names.every(name => [...row.values()].includes(name))

const LABELS: Record<ChannelFileKind, (sheet?: string) => string> = {
  'amazon-template': sheet => `an Amazon template (product sheet "${sheet}")`,
  'ebay-workbook': sheet => `an eBay workbook (sheet "${sheet}")`,
  'amazon-attribute-sheet': sheet => `an Amazon attribute sheet (sheet "${sheet}": Seller SKU, Product Type, Operation), not an Amazon template`,
  'nexus-workbook': () => 'a Nexus workbook',
  other: () => 'not a recognised channel or Nexus workbook',
}

export async function sniffWorkbook(bytes: Uint8Array): Promise<WorkbookSniff> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(bytes) } catch { return { kind: 'other', flavor: null, sheets: [], label: 'not an Excel workbook (.xlsx / .xlsm)' } }
  const workbook = await entry(zip, 'xl/workbook.xml'), rels = await entry(zip, 'xl/_rels/workbook.xml.rels')
  if (!workbook || !rels) return { kind: 'other', flavor: null, sheets: [], label: 'not an Excel workbook (.xlsx / .xlsm)' }
  // Sheets are declared before the (megabyte) defined names; stop there.
  const head = workbook.slice(0, Math.max(0, workbook.indexOf('</sheets>')) || workbook.length)
  const flavor: WorkbookSniff['flavor'] = /\bconformance="strict"/.test(head) || head.includes('purl.oclc.org/ooxml/spreadsheetml') ? 'strict' : 'transitional'
  const targets: Record<string, string> = {}
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) { const a = tagAttrs(m[0]); if (a.Id && a.Target) targets[a.Id] = a.Target }
  const sheets: { name: string; target: string }[] = []
  for (const m of head.matchAll(/<sheet\b[^>]*>/g)) {
    const a = tagAttrs(m[0]), id = a['r:id'] ?? a.id
    let target = (id && targets[id]) || ''
    if (!target) continue
    target = target.replace(/^\//, '')
    if (!target.startsWith('xl/')) target = `xl/${target}`
    sheets.push({ name: a.name ?? target, target })
  }
  const names = sheets.map(s => s.name)
  const found = (kind: ChannelFileKind, sheet?: string): WorkbookSniff => ({ kind, flavor, sheets: names, ...(sheet ? { sheet } : {}), label: LABELS[kind](sheet) })
  // Sheet names alone identify a Nexus workbook; no row needs reading.
  if (names.includes('Nexus workbook') || names.length && names.some(n => NEXUS_DATA_SHEETS.has(n)) && names.every(n => NEXUS_DATA_SHEETS.has(n) || NEXUS_HELPER_SHEETS.has(n))) return found('nexus-workbook')
  const sstXml = await entry(zip, 'xl/sharedStrings.xml') ?? ''
  let sst: string[] | null = null
  // Decoded on first use: a workbook whose first rows hold only inline strings never pays for it.
  const strings = () => {
    if (sst) return sst
    sst = []
    let i = 0
    for (;;) {
      // One forward search per item. Searching for `<si>` and `<si ` separately re-scanned the whole
      // megabyte for whichever form the file never uses — O(n²), 0.8 s on an Italian template.
      let start = sstXml.indexOf('<si', i)
      while (start !== -1 && sstXml[start + 3] !== '>' && sstXml[start + 3] !== ' ') start = sstXml.indexOf('<si', start + 3)
      if (start === -1) break
      const close = sstXml.indexOf('</si>', start)
      if (close === -1) break
      sst.push(joinTexts(sstXml.slice(start, close)))
      i = close + 5
    }
    return sst
  }
  const heads: { name: string; rows: Map<number, string>[]; a1: string }[] = []
  for (const sheet of sheets) {
    const xml = await entry(zip, sheet.target)
    if (!xml) continue
    const rows = headRows(xml, strings, SCAN_ROWS)
    // A1 is the first cell of the first non-empty row only when that row IS row 1; the marker lives in A1.
    const firstRow = /<row\b[^>]*\br="1"/.test(xml) ? rows[0] : undefined
    heads.push({ name: sheet.name, rows, a1: firstRow?.get(1) ?? '' })
    // A dense key row is conclusive: stop before inflating the megabyte valid-value sheets that follow it.
    if (amazonKeyRow(rows)) return found('amazon-template', sheet.name)
  }
  // Amazon first: its template must never reach ExcelJS, whatever else the file resembles.
  const marked = heads.find(h => h.a1.startsWith('settings=') || h.a1.startsWith('TemplateType='))
  const amazon = (marked && amazonKeyRow(marked.rows) ? marked : undefined) ?? heads.find(h => amazonKeyRow(h.rows)) ?? marked
  if (amazon) return found('amazon-template', amazon.name)
  const ebay = heads.find(h => holds(h.rows[0], EBAY_HEADERS))
  if (ebay) return found('ebay-workbook', ebay.name)
  const attributes = heads.find(h => holds(h.rows[0], ATTRIBUTE_SHEET_HEADERS))
  if (attributes) return found('amazon-attribute-sheet', attributes.name)
  return found('other')
}

/** The sentence every non-Amazon door answers an Amazon template with (records/2026-09-24-results.md §3, d6). */
export function amazonTemplateWrongDoor(filename: string) {
  return `${filename} is an Amazon template. Import it as File type "Amazon template" (it is detected automatically) or in the product sheet's import; this reader does not open Amazon templates.`
}
/** The sentence for the Title-Case SP-API sheet (BUILD.md D8). */
export function amazonAttributeSheetDoor(filename: string, sheet?: string) {
  return `${filename} is an Amazon attribute sheet${sheet ? ` (sheet "${sheet}": Seller SKU, Product Type, Operation …)` : ''}, not an Amazon template: it names no marketplace or language. Use "Map a source file" to choose where its columns go.`
}
