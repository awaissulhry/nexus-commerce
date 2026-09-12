/**
 * Editing workbook v4 — sample generator (design gate artifact, not production code).
 *
 * Reads a real v3 product-editing export and re-emits the SAME values in the proposed
 * v4 layout so the Owner can approve the layout by opening the file. Values are real;
 * the layout, grouping, vocabulary and reference sheets are the proposal.
 *
 *   node docs/workbook-v4/v4-sample-generator.mjs <v3-export.xlsx> <out.xlsx> [--tier=data|gaps|all]
 */
import ExcelJS from '../../node_modules/exceljs/excel.js'

// ── paper palette (XLSX has no CSS tokens; these mirror the Nexus surfaces) ──────────
const C = {
  ink: 'FF1C2530', mute: 'FF61708A', white: 'FFFFFFFF',
  band: 'FF24324A', bandAlt: 'FF32435F',
  keyRow: 'FFEEF1F5', keyInk: 'FF5A6A82',
  edit: 'FFFFF8E8', editHdr: 'FF234A70',
  ref: 'FFF0F3F6', refHdr: 'FF5A6A82',
  reqHdr: 'FF7A2E2E', gapFill: 'FFFDECEC', gapInk: 'FF9B2C2C',
  inherit: 'FFF7F9FB', inheritInk: 'FF8494AA',
  actionHdr: 'FF735215',
  stripe: 'FFF8FAFC', rule: 'FFD8DFE7', link: 'FF234A70',
  ok: 'FF1E6B4F', okFill: 'FFEAF6F0',
}
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })
const F = (o = {}) => ({ name: 'Aptos Narrow', size: 10, color: { argb: C.ink }, ...o })
const thin = argb => ({ style: 'thin', color: { argb } })

// ── requirement vocabulary: one closed set, four values, no casing collisions ────────
const REQUIREMENT = ['Required', 'Required when relevant', 'Recommended', 'Optional']
const normaliseRequirement = raw => {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v.startsWith('required when')) return 'Required when relevant'
  if (v === 'required for new products') return 'Required when relevant'
  if (v.startsWith('required')) return 'Required'
  if (v === 'bestpractice' || v === 'recommended') return 'Recommended'
  return 'Optional'
}

// ── group taxonomy — production reads col.group / field.group, which already exist.
//    The sample derives them because workbook v3 discards that metadata. ────────────
const GROUPS = [
  'Identity', 'Classification', 'Content', 'Specifications', 'Variation',
  'Identifiers', 'Dimensions and weight', 'Compliance and safety', 'Battery and hazmat',
  'Media', 'Offer and shipping', 'Other',
]
const GROUP_RULES = [
  [/^(sku|family|parentSku|brand|manufacturer|name|item_name|model_name|model_number|part_number|categoryIds|primaryCategoryId)$/, 'Identity'],
  [/^(productType|categoryId|category|taxonomy_id|recommended_browse_nodes|item_type_name|department|item_type_keyword)$/, 'Classification'],
  [/(description|bullet_point|bulletPoints|keywords|generic_keyword|title|descriptionHtml|body_html|search_terms|descriptionThemeId)/i, 'Content'],
  [/^(ean|upc|gtin|barcode|asin|merchant_suggested_asin|externally_assigned_product_identifier|supplier_declared_has_product_identifier_exemption|isbn)/, 'Identifiers'],
  [/(variation_theme|child_parent_sku_relationship|parentage|variant|sharedAxis)/i, 'Variation'],
  [/(weight|dimension|dim[A-Z]|package_dimensions|_length|_width|_height|_depth|diameter|size__|inseam|chest|waist|rise__|sleeve|shoulder)/i, 'Dimensions and weight'],
  [/(batter|lithium|hazmat|dangerous|dg_hz|ghs_|un_number|unNumber|flash_point|supplemental_condition)/i, 'Battery and hazmat'],
  [/(complian|gpsr|safety|ce_|declarationOfConformity|notifiedBody|ppeCategory|garmentClass|country_of_origin|countryOfOrigin|hsCode|harmonizedSystem|age_restriction|regulat|warning|certificat|expiration|shelf_life)/i, 'Compliance and safety'],
  [/(image|photo|swatch|media|video)/i, 'Media'],
  [/(shipping|handling|fulfil|merchant_shipping_group|price|quantity|inventory|policy|listingDuration|listingFormat|bestOffer|packageType|salesChannels|publishDate|templateSuffix)/i, 'Offer and shipping'],
]
const groupOf = key => (GROUP_RULES.find(([re]) => re.test(key)) ?? [null, 'Specifications'])[1]

// ── sheet naming: stable and human. Never a positional index. ───────────────────────
const CHANNEL_TITLE = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }
const ILLEGAL = /[\[\]:*?/\\]/g
const shortHash = s => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h.toString(36).slice(0, 4) }
function sheetName(scope, accountLabel, taken) {
  let base
  if (scope.entity === 'Products') base = scope.locale ? `Content ${scope.locale.toUpperCase()}` : 'Products'
  else base = [CHANNEL_TITLE[scope.channel] ?? scope.channel, scope.marketplace, accountLabel].filter(Boolean).join(' · ')
  base = base.replace(ILLEGAL, '-').slice(0, 31).trim()
  if (!taken.has(base)) { taken.add(base); return base }
  const suffixed = `${base.slice(0, 26)} ${shortHash(JSON.stringify(scope))}`.slice(0, 31)
  taken.add(suffixed); return suffixed
}

// ═══════════════════════════════════════════════════════════════════════════════════
// 1. Read the real v3 export
// ═══════════════════════════════════════════════════════════════════════════════════
const [, , SRC, OUT, tierArg] = process.argv
const TIER = (tierArg ?? '--tier=gaps').split('=')[1]
const src = new ExcelJS.Workbook(); await src.xlsx.readFile(SRC)
const SUPPORT = new Set(['Instructions', 'Dictionary', 'Valid values', 'Formula examples', 'Nexus workbook'])

const man = src.getWorksheet('Nexus workbook')
const MANIFEST_COLS = ['sheet', 'entity', 'channel', 'accountId', 'marketplace', 'locale', 'category']
const scopes = []
for (let r = 5; r <= man.rowCount; r++) {
  const o = Object.fromEntries(MANIFEST_COLS.map((k, i) => [k, man.getCell(r, i + 1).text]))
  if (o.sheet) scopes.push(o)
}
const exportId = man.getCell('C2').text

const dictSrc = src.getWorksheet('Dictionary')
const meta = new Map() // "sheet|field" -> {label,type,requirement,editable,maxLength,units,schema,help,encoding}
dictSrc.eachRow((r, i) => {
  if (i === 1) return
  meta.set(JSON.stringify([r.getCell(1).text, r.getCell(2).text]), {
    label: r.getCell(3).text, type: r.getCell(4).text, requirement: normaliseRequirement(r.getCell(5).text),
    requirementRaw: r.getCell(5).text, editable: r.getCell(6).text !== 'Reference only',
    maxLength: r.getCell(7).text, units: r.getCell(8).text, schema: r.getCell(9).text,
    help: r.getCell(10).text, encoding: r.getCell(11).text || 'cell',
  })
})

const vvSrc = src.getWorksheet('Valid values')
const optionsFor = new Map(); const choiceRuleFor = new Map()
vvSrc.eachRow((r, i) => {
  if (i === 1) return
  const o = []
  for (let c = 6; c <= vvSrc.columnCount; c++) { const t = r.getCell(c).text; if (t !== '') o.push(t) }
  const k = JSON.stringify([r.getCell(1).text, r.getCell(3).text])
  optionsFor.set(k, o); choiceRuleFor.set(k, r.getCell(5).text)
})

// account labels: the v3 file has only opaque IDs, so derive a stable short label
const accountLabels = new Map()
for (const s of scopes) if (s.accountId && !accountLabels.has(s.accountId)) {
  accountLabels.set(s.accountId, `Acct ${s.accountId.slice(-4)}`) // production uses ChannelConnection.accountLabel
}

// read every data sheet into records
const IDS = new Set(['sku', 'version', 'aliasKey', 'listing'])
/** An attribute may be literally named `sku`. Its column header is escaped; its Dictionary key is not. */
const RESERVED = /^(?:sku|version|aliasKey|listing)$/
const escapeKey = field => RESERVED.test(field) || /^(?:value|action):/.test(field) || field.includes('#') ? `value:${field}` : field
const unescapeKey = header => header.startsWith('value:') ? header.slice(6) : header
const data = new Map()
for (const s of scopes) {
  const ws = src.getWorksheet(s.sheet); if (!ws) continue
  const H = []; for (let c = 1; c <= ws.columnCount; c++) H.push(String(ws.getCell(1, c).text || ''))
  // Records are keyed by the RAW header, so an escaped attribute never overwrites an identity column.
  const fields = H.filter(h => !IDS.has(h) && !h.startsWith('action:') && h !== '')
  const rows = []
  for (let r = 2; r <= ws.rowCount; r++) {
    const rec = {}
    H.forEach((h, i) => { if (!h) return; const cell = ws.getCell(r, i + 1); rec[h] = cell.value === null || cell.value === undefined ? '' : cell.text })
    if (rec.sku) rows.push(rec)
  }
  data.set(s.sheet, { scope: s, fields, rows })
}
/** `fields` and every `col.key` are RAW headers. The Dictionary is keyed by the unescaped field. */
const metaOf = (sheet, raw) => meta.get(JSON.stringify([sheet, unescapeKey(raw)]))
const optsOf = (sheet, raw) => optionsFor.get(JSON.stringify([sheet, unescapeKey(raw)]))
const ruleOf = (sheet, raw) => choiceRuleFor.get(JSON.stringify([sheet, unescapeKey(raw)]))

// ═══════════════════════════════════════════════════════════════════════════════════
// 2. Decide the column set  (Decision 1: a workbook is a scope pack, not everything)
// ═══════════════════════════════════════════════════════════════════════════════════
const hasData = (sheet, field, rows) => rows.some(r => (r[field] ?? '') !== '')
/** The content spine every destination needs to be publishable, whatever the schema calls it. */
const CORE = /^(name|item_name|title|description|product_description|body_html|descriptionHtml|bulletPoints|bullet_point|keywords|generic_keyword|brand|manufacturer|productType|categoryId|category|taxonomy_id)$/
function columnsFor(sheet, fields, rows) {
  return fields.filter(f => {
    const m = metaOf(sheet, f) ?? {}
    if (TIER === 'all') return true
    if (hasData(sheet, f, rows)) return true
    if (TIER === 'data') return false
    // A destination with nothing stored yet must still arrive fillable.
    return m.requirement === 'Required' || m.requirement === 'Recommended' || CORE.test(unescapeKey(f))
  })
}

// ── measures and lists get real columns, never hand-written JSON ────────────────────
//    measure  ->  <field>            (number)   +  <field>.unit  (choice)
//    list     ->  <field>.1 … <field>.N         (N from the observed data, min 3)
// Slots must cover every stored entry — a fixed cap silently truncates a list.
// Beyond SLOT_MAX columns a list is unreadable as slots and keeps its JSON cell.
const SLOT_MIN = 3, SLOT_MAX = 20
const parseOr = (raw, fallback) => { try { return JSON.parse(raw) } catch { return fallback } }
/** Legacy values predate the current schema. A field only splits when every stored value conforms. */
function conforms(field, rows, shape) {
  return rows.every(r => {
    const raw = r[field] ?? ''
    if (raw === '') return true
    const v = parseOr(raw, Symbol.for('bad'))
    if (v === Symbol.for('bad')) return false
    if (shape === 'list') return Array.isArray(v)
    return v !== null && typeof v === 'object' && !Array.isArray(v) && 'value' in v
  })
}
function expand(sheet, field, rows) {
  const m = metaOf(sheet, field) ?? { type: 'text' }
  if (m.type === 'measure' && conforms(field, rows, 'measure')) return [
    { key: field, part: 'measure.value', label: m.label, type: 'number' },
    { key: field, part: 'measure.unit', label: `${m.label} unit`, type: 'select', options: (m.units || '').split(',').map(x => x.trim()).filter(Boolean) },
  ]
  if (m.type === 'list' && conforms(field, rows, 'list')) {
    let longest = 0
    for (const r of rows) { const a = parseOr(r[field] || '[]', []); if (Array.isArray(a)) longest = Math.max(longest, a.length) }
    const trailingBlank = rows.some(r => { const a = parseOr(r[field] || '[]', []); return Array.isArray(a) && a.length > 0 && a[a.length - 1] === '' })
    if (longest <= SLOT_MAX && !trailingBlank) {
      const n = Math.max(SLOT_MIN, longest)
      return Array.from({ length: n }, (_, i) => ({ key: field, part: `list.${i + 1}`, label: `${m.label} ${i + 1}`, type: 'text' }))
    }
    return [{ key: field, part: 'value', label: m.label, type: m.type, legacy: true, longList: trailingBlank ? 0 : longest, trailingBlank }]
  }
  // Not splittable: one cell, and the Dictionary says which encoding it uses.
  return [{ key: field, part: 'value', label: m.label, type: m.type, legacy: ['list', 'measure'].includes(m.type) }]
}
const cellFor = (rec, col) => {
  const raw = rec[col.key] ?? ''
  if (col.part === 'value') return raw
  if (raw === '') return ''
  if (col.part.startsWith('list.')) { const a = parseOr(raw, null); return Array.isArray(a) ? (a[+col.part.slice(5) - 1] ?? '') : '' }
  const o = parseOr(raw, null)
  if (!o || typeof o !== 'object') return ''
  return col.part === 'measure.unit' ? (o.unit ?? '') : (o.value ?? '')
}

// ═══════════════════════════════════════════════════════════════════════════════════
// 3. Build the v4 workbook
// ═══════════════════════════════════════════════════════════════════════════════════
const book = new ExcelJS.Workbook()
book.creator = 'Nexus Commerce'
book.calcProperties.fullCalcOnLoad = false   // no formulas in a data area that refuses them

const start = book.addWorksheet('Start here', { views: [{ showGridLines: false }] })
const SHEET_ORDER = ['Start here']
const built = []   // {name, scope, cols, rows, gaps, lists}
const taken = new Set(['Start here', 'Dictionary', 'Lists', 'Nexus workbook'])
const listRegistry = []  // {label, origin, options} -> one column on Lists

for (const s of scopes) {
  const d = data.get(s.sheet); if (!d) continue
  const name = sheetName(s, accountLabels.get(s.accountId), taken)
  const keys = columnsFor(s.sheet, d.fields, d.rows)
  const cols = keys.flatMap(k => expand(s.sheet, k, d.rows).map(c => ({ ...c, sheet: s.sheet })))
  built.push({ name, scope: s, keys, cols, rows: d.rows })
}

// ── Lists sheet: VERTICAL. Rows scale to 1,048,576; the old horizontal layout dies at
//    16,379 options for a single attribute. ───────────────────────────────────────────
const lists = book.addWorksheet('Lists', { views: [{ state: 'frozen', ySplit: 2, showGridLines: false }] })
lists.state = 'visible'
const listName = new Map() // "sheet|field" -> definedName
{
  let c = 0
  for (const b of built) for (const k of b.keys) {
    const key = JSON.stringify([b.scope.sheet, k])
    const opts = optsOf(b.scope.sheet, k)
    if (!opts?.length || listName.has(key)) continue
    c += 1
    const m = metaOf(b.scope.sheet, k)
    const col = lists.getColumn(c)
    col.width = Math.min(46, Math.max(14, ...opts.slice(0, 200).map(o => o.length + 2), (m?.label ?? k).length + 2))
    lists.getCell(1, c).value = m?.label ?? k
    lists.getCell(2, c).value = `${b.name} ▸ ${k}`
    opts.forEach((o, i) => { const cell = lists.getCell(3 + i, c); cell.value = o; cell.numFmt = '@' })
    const nm = `NexusList_${c}`
    book.definedNames.add(`'Lists'!$${col.letter}$3:$${col.letter}$${2 + opts.length}`, nm)
    listName.set(key, nm)
    listRegistry.push({ col: c, label: m?.label ?? k, origin: `${b.name} ▸ ${k}`, n: opts.length, rule: ruleOf(b.scope.sheet, k) })
  }
  lists.getRow(1).font = F({ bold: true, color: { argb: C.white } })
  lists.getRow(1).height = 30
  lists.getRow(1).alignment = { vertical: 'middle', wrapText: true }
  lists.getRow(2).font = F({ size: 8, color: { argb: C.keyInk } })
  lists.getRow(2).height = 20
  for (let i = 1; i <= c; i++) {
    lists.getCell(1, i).fill = fill(C.band); lists.getCell(1, i).border = { right: thin(C.white) }
    lists.getCell(2, i).fill = fill(C.keyRow)
  }
  if (c === 0) { lists.getCell(1, 1).value = 'No fixed choices in this scope'; lists.getColumn(1).width = 42 }
}

// ── data sheets ──────────────────────────────────────────────────────────────────────
const HDR_BAND = 1, HDR_LABEL = 2, HDR_KEY = 3, FIRST_DATA = 4
for (const b of built) {
  const ws = book.addWorksheet(b.name, { views: [{ showGridLines: false }] })
  const isProduct = b.scope.entity === 'Products'
  const idCols = isProduct ? ['sku', 'version'] : ['sku', 'listing', 'aliasKey', 'version']
  const valueStart = idCols.length + 1
  const actionStart = valueStart + b.cols.length
  b.actionKeys = [...new Set(b.cols.map(c => c.key))]

  // order: group workflow order, then the requirement tier, then label
  const tierRank = r => ({ Required: 0, Recommended: 1, 'Required when relevant': 2, Optional: 3 })[r] ?? 3
  b.cols.sort((x, y) => {
    const gx = GROUPS.indexOf(groupOf(unescapeKey(x.key))), gy = GROUPS.indexOf(groupOf(unescapeKey(y.key)))
    if (gx !== gy) return gx - gy
    const mx = metaOf(b.scope.sheet, x.key) ?? {}, my = metaOf(b.scope.sheet, y.key) ?? {}
    return tierRank(mx.requirement) - tierRank(my.requirement) || String(x.label).localeCompare(String(y.label)) || x.part.localeCompare(y.part)
  })

  const lastRow = Math.max(FIRST_DATA, FIRST_DATA + b.rows.length - 1)

  // identity block
  idCols.forEach((k, i) => {
    const c = i + 1, col = ws.getColumn(c)
    col.width = k === 'sku' ? 30 : k === 'listing' ? 26 : 10
    col.numFmt = '@'
    ws.getCell(HDR_LABEL, c).value = { sku: 'SKU', listing: 'Listing', aliasKey: 'Alias key', version: 'Version' }[k]
    ws.getCell(HDR_KEY, c).value = k
    if (k === 'aliasKey' || k === 'version') { col.hidden = true }
  })
  ws.mergeCells(HDR_BAND, 1, HDR_BAND, idCols.length)
  ws.getCell(HDR_BAND, 1).value = 'RECORD IDENTITY — keep intact'

  // value block, banded by group
  let bandFrom = valueStart, bandGroup = null
  b.cols.forEach((col, i) => {
    const c = valueStart + i
    const m = metaOf(b.scope.sheet, col.key) ?? {}
    const g = groupOf(unescapeKey(col.key))
    if (bandGroup === null) bandGroup = g
    if (g !== bandGroup) {
      if (c - 1 >= bandFrom) ws.mergeCells(HDR_BAND, bandFrom, HDR_BAND, c - 1)
      ws.getCell(HDR_BAND, bandFrom).value = bandGroup.toUpperCase()
      bandFrom = c; bandGroup = g
    }
    const wsCol = ws.getColumn(c)
    wsCol.width = /description|bullet|name|title|keyword/i.test(unescapeKey(col.key)) ? 52 : col.part === 'measure.unit' ? 14 : 30
    wsCol.numFmt = col.type === 'number' ? '0.####' : '@'
    wsCol.alignment = { wrapText: true, vertical: 'top' }
    ws.getCell(HDR_LABEL, c).value = col.label || col.key
    ws.getCell(HDR_KEY, c).value = col.part === 'value' ? col.key : `${col.key}#${col.part}`
    // Excel outline grouping: collapse a whole group the operator is not working on
    wsCol.outlineLevel = 1
  })
  if (b.cols.length) {
    ws.mergeCells(HDR_BAND, bandFrom, HDR_BAND, valueStart + b.cols.length - 1)
    ws.getCell(HDR_BAND, bandFrom).value = String(bandGroup).toUpperCase()
  }

  // action block (advanced; hidden, one outline group)
  b.actionKeys.forEach((key, i) => {
    const c = actionStart + i
    const m = metaOf(b.scope.sheet, key) ?? {}
    ws.getColumn(c).width = 18
    ws.getColumn(c).hidden = true
    ws.getColumn(c).outlineLevel = 2
    ws.getCell(HDR_LABEL, c).value = `${m.label ?? key} — action`
    ws.getCell(HDR_KEY, c).value = `action:${key}`
  })
  if (b.actionKeys.length) {
    ws.mergeCells(HDR_BAND, actionStart, HDR_BAND, actionStart + b.actionKeys.length - 1)
    ws.getCell(HDR_BAND, actionStart).value = 'ADVANCED ACTIONS — SET / CLEAR / INHERIT (one per field)'
  }

  // data
  b.rows.forEach((rec, ri) => {
    const r = FIRST_DATA + ri
    idCols.forEach((k, i) => { ws.getCell(r, i + 1).value = k === 'listing' ? (rec.listing || 'Primary listing') : (rec[k] ?? '') })
    b.cols.forEach((col, i) => {
      const v = cellFor(rec, col)
      const cell = ws.getCell(r, valueStart + i)
      if (v === '') return
      cell.value = col.type === 'number' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : String(v)
    })
  })

  // ── styling ────────────────────────────────────────────────────────────────────────
  const bandRow = ws.getRow(HDR_BAND)
  bandRow.height = 22
  bandRow.font = F({ bold: true, size: 9, color: { argb: C.white } })
  bandRow.alignment = { vertical: 'middle', horizontal: 'center' }
  const lastCol = actionStart + b.actionKeys.length - 1
  for (let c = 1; c <= lastCol; c++) {
    const cell = ws.getCell(HDR_BAND, c)
    cell.fill = fill(c === 1 ? C.refHdr : c >= actionStart ? C.actionHdr : (GROUPS.indexOf(groupOf(unescapeKey(b.cols[c - valueStart]?.key ?? ''))) % 2 ? C.bandAlt : C.band))
    cell.border = { right: thin(C.white) }
  }
  const labelRow = ws.getRow(HDR_LABEL)
  labelRow.height = 40
  labelRow.font = F({ bold: true, color: { argb: C.white } })
  labelRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  const keyRow = ws.getRow(HDR_KEY)
  keyRow.height = 16
  keyRow.font = F({ size: 8, color: { argb: C.keyInk } })
  keyRow.alignment = { vertical: 'middle', horizontal: 'center' }

  for (let c = 1; c <= lastCol; c++) {
    const col = c < valueStart ? null : c >= actionStart ? 'action' : b.cols[c - valueStart]
    const m = col && col !== 'action' ? (metaOf(b.scope.sheet, col.key) ?? {}) : {}
    const required = m.requirement === 'Required'
    ws.getCell(HDR_LABEL, c).fill = fill(!col ? C.refHdr : col === 'action' ? C.actionHdr : required ? C.reqHdr : m.editable === false ? C.refHdr : C.editHdr)
    ws.getCell(HDR_LABEL, c).border = { right: thin(C.white) }
    ws.getCell(HDR_KEY, c).fill = fill(C.keyRow)
    ws.getCell(HDR_KEY, c).border = { right: thin(C.rule), bottom: thin(C.rule) }

    if (lastRow < FIRST_DATA) continue
    const L = ws.getColumn(c).letter
    const range = `${L}${FIRST_DATA}:${L}${lastRow}`
    // one fill per column instead of one per cell
    for (let r = FIRST_DATA; r <= lastRow; r++) {
      const cell = ws.getCell(r, c)
      cell.fill = fill(!col ? C.ref : col === 'action' ? C.ref : m.editable === false ? C.ref : C.edit)
      cell.border = { right: thin(C.rule), bottom: thin(C.rule) }
      cell.alignment = { wrapText: true, vertical: 'top' }
    }
    if (col === 'action') {
      ws.dataValidations.add(range, { type: 'list', allowBlank: true, formulae: ['"SET,CLEAR,INHERIT"'], showErrorMessage: true, error: 'Choose SET, CLEAR or INHERIT.' })
      continue
    }
    if (!col || m.editable === false) continue

    // Decision 4: ONE range-level validation per column (v3 wrote one per cell)
    const lk = listName.get(JSON.stringify([b.scope.sheet, col.key]))
    const strict = /^Listed values only/i.test(ruleOf(b.scope.sheet, col.key) ?? '')
    if (lk && (col.part === 'value' || col.part.startsWith('list.'))) {
      ws.dataValidations.add(range, {
        type: 'list', allowBlank: true, formulae: [lk],
        showErrorMessage: true, errorStyle: strict ? 'stop' : 'warning',
        errorTitle: strict ? 'Not an accepted value' : 'Value outside the list',
        error: strict ? 'This field accepts only the listed values. Open Lists to see them.' : 'Unlisted values are allowed here but may be refused by the channel. Open Lists to see the suggestions.',
        showInputMessage: true, promptTitle: String(col.label).slice(0, 32),
        prompt: `${strict ? 'Listed values only.' : 'Suggestions; custom values allowed.'}${m.maxLength ? ` Max ${m.maxLength} characters.` : ''} Full guidance in Dictionary.`,
      })
    } else if (col.part === 'measure.unit' && col.options?.length) {
      ws.dataValidations.add(range, { type: 'list', allowBlank: true, formulae: [`"${col.options.join(',')}"`], showErrorMessage: true, error: 'Choose one of the units allowed for this field.' })
    } else if (col.type === 'number') {
      ws.dataValidations.add(range, { type: 'decimal', allowBlank: true, operator: 'greaterThanOrEqual', formulae: [0], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Check this number', error: 'Enter a number. Use a decimal point, no thousands separator and no unit — the unit has its own column.' })
    } else if (col.type === 'boolean') {
      ws.dataValidations.add(range, { type: 'list', allowBlank: true, formulae: ['"TRUE,FALSE"'], showErrorMessage: true, error: 'Enter TRUE or FALSE.' })
    } else if (m.maxLength && Number(m.maxLength) > 0) {
      ws.dataValidations.add(range, { type: 'textLength', allowBlank: true, operator: 'lessThanOrEqual', formulae: [Number(m.maxLength)], showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Too long for this channel', error: `This field accepts at most ${m.maxLength} characters.`, showInputMessage: true, promptTitle: String(col.label).slice(0, 32), prompt: `Max ${m.maxLength} characters. Full guidance in Dictionary.` })
    }

    // Decision 11: a required cell left empty is visible, at range level
    if (required) ws.addConditionalFormatting({ ref: range, rules: [{ type: 'expression', priority: 1, formulae: [`ISBLANK(${L}${FIRST_DATA})`], style: { fill: fill(C.gapFill), font: { color: { argb: C.gapInk } } } }] })
  }

  ws.views = [{ state: 'frozen', xSplit: isProduct ? 1 : 2, ySplit: HDR_KEY, showGridLines: false }]
  ws.properties.outlineLevelCol = 2
  ws.autoFilter = { from: { row: HDR_KEY, column: 1 }, to: { row: Math.max(FIRST_DATA, lastRow), column: lastCol } }
  ws.pageSetup = { orientation: 'landscape', printTitlesRow: `${HDR_BAND}:${HDR_KEY}`, paperSize: 9 }
  ws.properties.tabColor = { argb: isProduct ? C.editHdr : C.band }

  b.gaps = b.cols.filter(c => (metaOf(b.scope.sheet, c.key) ?? {}).requirement === 'Required')
    .reduce((n, c, i) => n + b.rows.filter(r => cellFor(r, c) === '').length, 0)
}

// ── Dictionary: compact, one row per emitted column, normalised vocabulary ───────────
const dict = book.addWorksheet('Dictionary', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3, showGridLines: false }] })
const dictHeaders = ['Sheet', 'Group', 'Field key', 'Attribute', 'Requirement', 'Type', 'Encoding', 'Choices', 'Allowed units', 'Max. length', 'Editing', 'Schema version', 'Guidance']
dict.columns = dictHeaders.map((h, i) => ({ header: h, key: h, width: [24, 22, 34, 30, 20, 12, 14, 10, 24, 12, 14, 24, 70][i] }))
for (const b of built) for (const col of b.cols) {
  const m = metaOf(b.scope.sheet, col.key) ?? {}
  const opts = optsOf(b.scope.sheet, col.key) ?? []
  dict.addRow([
    b.name, groupOf(unescapeKey(col.key)), col.part === 'value' ? col.key : `${col.key}#${col.part}`, col.label,
    m.requirement ?? 'Optional', col.type, col.part === 'value' ? (m.encoding ?? 'cell') : col.part,
    opts.length || null, m.units || null, m.maxLength || null,
    m.editable === false ? 'Reference only' : 'Editable', m.schema || null,
    [m.help, col.part.startsWith('measure') ? 'Split from a measure: the number and its unit have their own columns; Nexus recombines them on import.' : '',
     col.part.startsWith('list.') ? 'One list entry per column, in order. Blank slots at the end shorten the list; a blank slot between two filled ones is a real empty entry. Blank every slot and set the action to CLEAR to store an empty list.' : '',
     col.legacy ? 'Kept as a single JSON cell because a stored value in this scope does not match the declared type. Use ["one","two"] for a list or {"value":1.2,"unit":"kg"} for a measure.' : '',
     m.requirementRaw && m.requirementRaw !== m.requirement ? `Source requirement: ${m.requirementRaw}.` : ''].filter(Boolean).join(' ') || null,
  ])
}
const dictRows = dict.rowCount
dict.getRow(1).font = F({ bold: true, color: { argb: C.white } }); dict.getRow(1).height = 30
dict.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
dict.getRow(1).eachCell(c => { c.fill = fill(C.band); c.border = { right: thin(C.white) } })
dict.eachRow((row, i) => { if (i === 1) return
  row.font = F(); row.alignment = { vertical: 'top', wrapText: true }
  const req = row.getCell(5).value
  row.getCell(5).font = F({ bold: req === 'Required', color: { argb: req === 'Required' ? C.gapInk : C.mute } })
  row.height = Math.min(64, 16 + 12 * Math.ceil(String(row.getCell(13).value ?? '').length / 90)) })
if (dictRows > 1) {
  dict.autoFilter = { from: 'A1', to: { row: dictRows, column: dictHeaders.length } }
  dict.addConditionalFormatting({ ref: `A2:M${dictRows}`, rules: [{ type: 'expression', priority: 1, formulae: ['MOD(ROW(),2)=1'], style: { fill: fill(C.stripe) } }] })
}
dict.properties.tabColor = { argb: C.refHdr }

// ── Start here: a dashboard, not an essay ───────────────────────────────────────────
{
  start.columns = [{ width: 4 }, { width: 34 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 58 }]
  const put = (r, c, v, o = {}) => { const cell = start.getCell(r, c); cell.value = v; Object.assign(cell, o); return cell }
  const H = (r, text) => { start.mergeCells(r, 2, r, 7); const c = put(r, 2, text, { font: F({ bold: true, size: 12, color: { argb: C.white } }), fill: fill(C.band), alignment: { vertical: 'middle', indent: 1 } }); start.getRow(r).height = 26; return c }

  start.mergeCells(2, 2, 2, 7)
  put(2, 2, 'Product editing workbook', { font: F({ bold: true, size: 20 }), alignment: { vertical: 'middle' } })
  start.getRow(2).height = 34
  start.mergeCells(3, 2, 3, 7)
  put(3, 3, '')
  put(3, 2, `Export ${exportId} · ${built.reduce((n, b) => n + b.rows.length, 0)} records across ${built.length} sheets · layout v4 sample`, { font: F({ color: { argb: C.mute } }) })

  let r = 5
  H(r++, 'What is in this file')
  const hdr = ['Sheet', 'What it changes', 'Records', 'Columns', 'Required gaps', 'Open']
  hdr.forEach((h, i) => put(r, i + 2, h, { font: F({ bold: true, color: { argb: C.white } }), fill: fill(C.refHdr), alignment: { horizontal: i > 1 && i < 5 ? 'center' : 'left', vertical: 'middle', indent: 1 } }))
  start.getRow(r).height = 22; r++
  for (const b of built) {
    const what = b.scope.entity === 'Products'
      ? (b.scope.locale ? `Translated content · ${b.scope.locale.toUpperCase()}` : 'Shared product facts — inherited everywhere')
      : `Overrides for ${CHANNEL_TITLE[b.scope.channel] ?? b.scope.channel} ${b.scope.marketplace}${b.scope.category ? ` · ${b.scope.category}` : ''}`
    put(r, 2, b.name, { font: F({ bold: true }) })
    put(r, 3, what, { font: F({ color: { argb: C.mute } }), alignment: { wrapText: true, vertical: 'middle' } })
    put(r, 4, b.rows.length, { alignment: { horizontal: 'center' } })
    put(r, 5, b.cols.length, { alignment: { horizontal: 'center' } })
    const g = put(r, 6, b.gaps ?? 0, { alignment: { horizontal: 'center' }, font: F({ bold: (b.gaps ?? 0) > 0, color: { argb: (b.gaps ?? 0) > 0 ? C.gapInk : C.ok } }), fill: fill((b.gaps ?? 0) > 0 ? C.gapFill : C.okFill) })
    put(r, 7, { text: `Open ${b.name}`, hyperlink: `#'${b.name.replace(/'/g, "''")}'!A4` }, { font: F({ color: { argb: C.link }, underline: true }) })
    start.getRow(r).height = 20
    r++
  }
  r++

  H(r++, 'How to fill it in')
  const steps = [
    ['1', 'Work sheet by sheet', 'Each sheet writes to exactly one destination. A value typed on Amazon DE never reaches another marketplace.'],
    ['2', 'Read the three header rows', 'Dark band = column group. White row = the human name. Grey row = the field key Nexus writes to. Data starts on row 4.'],
    ['3', 'Type into the cream cells', 'Cream = you can edit it. Grey = reference, kept for context and ignored on import. Pink = a required value is missing.'],
    ['4', 'Use the dropdowns', 'Where a field has fixed choices the cell offers them. Every list is also on the Lists sheet, one column per attribute.'],
    ['5', 'Leave anything you are not changing blank', 'A blank or unchanged cell preserves the stored value and its inheritance. Deleting a row or column never deletes data.'],
    ['6', 'Return the file to the product editor', 'Import restores this exact scope for review. Nothing is saved until you approve the review.'],
  ]
  for (const [n, t, d] of steps) {
    put(r, 2, `${n}. ${t}`, { font: F({ bold: true }), alignment: { vertical: 'top' } })
    start.mergeCells(r, 3, r, 7)
    put(r, 3, d, { font: F({ color: { argb: C.mute } }), alignment: { wrapText: true, vertical: 'top', indent: 1 } })
    start.getRow(r).height = 30
    r++
  }
  r++

  H(r++, 'Legend')
  const legend = [
    [C.edit, C.ink, 'Editable', 'Type here. Blank preserves what is stored.'],
    [C.ref, C.mute, 'Reference', 'Identity or channel-managed. Ignored on import.'],
    [C.gapFill, C.gapInk, 'Required and empty', 'The channel needs this before it can publish.'],
    [C.reqHdr, C.white, 'Required column', 'Its header is dark red.'],
    [C.actionHdr, C.white, 'Advanced actions', 'Hidden column group on the far right. SET / CLEAR / INHERIT.'],
  ]
  for (const [bg, fg, label, note] of legend) {
    put(r, 2, label, { fill: fill(bg), font: F({ bold: true, color: { argb: fg } }), alignment: { vertical: 'middle', indent: 1 }, border: { top: thin(C.rule), bottom: thin(C.rule), left: thin(C.rule), right: thin(C.rule) } })
    start.mergeCells(r, 3, r, 7)
    put(r, 3, note, { font: F({ color: { argb: C.mute } }), alignment: { vertical: 'middle', indent: 1 } })
    start.getRow(r).height = 20
    r++
  }
  r++

  H(r++, 'Which value wins')
  start.mergeCells(r, 2, r + 1, 7)
  put(r, 2, 'Products  →  Content <language>  →  <channel sheet>.   A value on a channel sheet overrides the shared one for that destination only. '
    + 'Clear a channel cell with the advanced INHERIT action to go back to the shared value. Editing Products can change every destination that still inherits it.',
    { font: F(), alignment: { wrapText: true, vertical: 'middle', indent: 1 }, fill: fill(C.stripe), border: { top: thin(C.rule), bottom: thin(C.rule), left: thin(C.rule), right: thin(C.rule) } })
  start.getRow(r).height = 24; start.getRow(r + 1).height = 24
  r += 3

  H(r++, 'Rules that protect your data')
  const rules = [
    'Keep the SKU, Listing and hidden Version columns exactly as exported — they are how Nexus matches your edits.',
    'Sort the whole data range, never a single column. Sorting one column separates values from their SKU.',
    'Formulas are refused on import. Calculate elsewhere, then paste the results as values.',
    'Numbers and their units have separate columns. Enter 1.4 and choose kg; never type "1.4 kg" into one cell.',
    'Price, stock and publishing keep their own workflows. They are not in this file and cannot be changed by it.',
    'Hidden and filtered rows are still imported. Delete a row from the file to leave that record alone.',
  ]
  for (const text of rules) {
    put(r, 2, '•', { font: F({ color: { argb: C.mute } }), alignment: { horizontal: 'right' } })
    start.mergeCells(r, 3, r, 7)
    put(r, 3, text, { font: F(), alignment: { wrapText: true, vertical: 'middle', indent: 1 } })
    start.getRow(r).height = 20
    r++
  }
  start.properties.tabColor = { argb: C.editHdr }
  start.views = [{ showGridLines: false, state: 'frozen', ySplit: 3 }]
}

// ── hidden manifest — unchanged contract, plus the v4 marker ────────────────────────
{
  const m = book.addWorksheet('Nexus workbook')
  m.state = 'hidden'
  m.addRow(['format', 'version', 'exportId', 'headerRows', 'labelRow', 'keyRow', 'firstDataRow'])
  m.addRow(['nexus-catalog-wide', 4, exportId, 3, HDR_LABEL, HDR_KEY, FIRST_DATA])
  m.addRow([])
  m.addRow([...MANIFEST_COLS])
  for (const b of built) m.addRow(MANIFEST_COLS.map(k => (k === 'sheet' ? b.name : b.scope[k]) || null))
  m.getRow(1).font = F({ bold: true }); m.getRow(4).font = F({ bold: true })
  ;[30, 12, 40, 12, 12, 12, 14].forEach((w, i) => { m.getColumn(i + 1).width = w })
}

for (const s of [dict, lists]) await s.protect('', { autoFilter: true, sort: false, formatColumns: true, formatRows: true })

// Deterministic tab order: Start here, the working sheets, then reference, then metadata.
{
  const want = ['Start here', ...built.map(b => b.name), 'Dictionary', 'Lists', 'Nexus workbook']
  const ordered = book.worksheets.slice().sort((a, b) => want.indexOf(a.name) - want.indexOf(b.name))
  ordered.forEach((w, i) => { w.orderNo = i + 1 })
}

await book.xlsx.writeFile(OUT)
const bytes = (await import('node:fs')).statSync(OUT).size
console.log(`wrote ${OUT}  ${bytes.toLocaleString()} bytes`)
console.log(`sheets: ${book.worksheets.map(w => w.name).join(' | ')}`)
console.log(`columns per data sheet: ${built.map(b => `${b.name}=${b.cols.length}`).join(', ')}`)
console.log(`option lists: ${listRegistry.length} (vertical, widest ${Math.max(0, ...listRegistry.map(l => l.n))} options)`)
