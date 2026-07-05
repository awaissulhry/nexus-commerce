// FF0 — Sample workbook generator (gate artifact).
// Read-only deliverable: produces FF0-SAMPLE-WORKBOOK.xlsx demonstrating the
// FF0-WORKBOOK-SPEC structure + Excel-proofing. Row values are ILLUSTRATIVE
// (clearly labelled), not a live catalog export. Run from repo root:
//   node docs/flat-file/v2/FF0-sample-generator.mjs
import ExcelJS from 'exceljs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'FF0-SAMPLE-WORKBOOK.xlsx')

// Deterministic, non-volatile (Contract §1): fixed snapshot id + fixed exportedAt.
const SNAPSHOT_ID = 'ff0-sample-0001'
const SCHEMA_VERSION = 'ff-v2.0'
const EXPORTED_AT = '2026-07-05'
const MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] // IT-first, then alphabetical (deterministic)

const GREY = 'FFEFEFEF'
const HDR = 'FF1F2933'
const HDR_FONT = { bold: true, color: { argb: 'FFFFFFFF' } }
const BAND = { IT: 'FFE8F0FE', DE: 'FFFCEfE6', FR: 'FFE6F6EC', ES: 'FFF3E8FD', UK: 'FFFDECEC' }

const fp = (sku, channel, obj) =>
  createHash('sha256').update(`${sku}|${channel}|${JSON.stringify(obj)}`).digest('hex').slice(0, 16)

const wb = new ExcelJS.Workbook()
wb.creator = 'Nexus Flat File v2 (FF0 sample)'
wb.created = new Date(Date.UTC(2026, 6, 5))

// ---- helpers ---------------------------------------------------------------
function styleHeader(ws, greyCols = new Set(), bandCols = {}) {
  const row = ws.getRow(1)
  row.height = 22
  row.eachCell((cell, col) => {
    const key = ws.getColumn(col).key
    cell.font = HDR_FONT
    cell.alignment = { vertical: 'middle', wrapText: true }
    let fill = HDR
    if (greyCols.has(key)) fill = 'FF6B7280'
    for (const [mkt, cols] of Object.entries(bandCols)) {
      if (cols.has(key)) fill = { IT: 'FF3B6FE0', DE: 'FFB4632A', FR: 'FF2F8F4E', ES: 'FF7C3AED', UK: 'FFC0392B' }[mkt]
    }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } }
  })
}
function greyColumn(ws, key) {
  const col = ws.getColumn(key)
  col.eachCell((cell, rowNo) => {
    if (rowNo === 1) return
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } }
    cell.font = { color: { argb: 'FF6B7280' } }
    cell.protection = { locked: true }
  })
}
function bandColumn(ws, key, mkt) {
  const col = ws.getColumn(key)
  col.eachCell((cell, rowNo) => {
    if (rowNo === 1) return
    if (!cell.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND[mkt] } }
  })
}
function forceText(ws, keys) {
  for (const k of keys) ws.getColumn(k).numFmt = '@'
}
function dropdown(ws, key, values, { strict = true } = {}) {
  const col = ws.getColumn(key)
  col.eachCell((cell, rowNo) => {
    if (rowNo === 1) return
    cell.dataValidation = {
      type: 'list', allowBlank: true, formulae: [`"${values.join(',')}"`],
      showErrorMessage: strict, errorStyle: 'warning',
      error: strict ? 'Value not in the allowed list (strict enum).' : undefined,
    }
  })
}
function note(cell, text) { cell.note = { texts: [{ text }] } }

// =====================================================================
// 1. README
// =====================================================================
const readme = wb.addWorksheet('README', { properties: { tabColor: { argb: 'FF1F2933' } } })
readme.columns = [{ key: 'a', width: 26 }, { key: 'b', width: 96 }]
const rl = (a, b, bold = false) => {
  const r = readme.addRow({ a, b })
  if (bold) r.getCell('a').font = { bold: true }
  r.getCell('b').alignment = { wrapText: true, vertical: 'top' }
  return r
}
rl('NEXUS FLAT FILE v2', 'Source-of-truth workbook — FF0 sample (structure demonstration)', true)
rl('⚠ ILLUSTRATIVE DATA', 'Row values below are illustrative, NOT a live catalog export. Structure, formatting and Excel-proofing are production-shaped. FF1 regenerates this from live data.')
rl('', '')
rl('SHEETS', 'README · Products (shared master data) · Amazon · eBay · (Shopify) · Images · _meta (hidden)', true)
rl('Products', 'One row per SKU. Master/shared data from the Product model (parent + child rows).')
rl('Amazon / eBay', 'Per-market listing data. Shared columns first, then field@MARKET groups for every discovered market.')
rl('_meta (hidden)', 'snapshotId, schemaVersion, exportedAt, discovered market list, and per-row fingerprints. No volatile values live on visible sheets.')
rl('', '')
rl('ACTION COLUMN', 'First column on every editable sheet:', true)
rl('(blank)', 'Update the row only where a cell differs from the current value.')
rl('ADD', 'Create this product / listing.')
rl('DELETE', 'Delete. On apply you must type "DELETE N PRODUCTS". The dry-run shows the full cascade.')
rl('IGNORE', 'Skip this row entirely.')
rl('', 'A MISSING row never means delete. Deletion is only ever via Action=DELETE.')
rl('', '')
rl('BLANK vs CLEAR', 'Blank cell = "no change". The sentinel __CLEAR__ = "set this field empty". Symmetric on export/import.', true)
rl('', '')
rl('READONLY (🔒)', 'Columns prefixed 🔒 and greyed are synced-from-channel or computed (buybox, fees, live status, sync state). Exported for reference; IGNORED on import. In production these are cell-locked.', true)
rl('', '')
rl('field@MARKET', 'Per-market columns, e.g. price@IT, quantity@DE, status@FR. Markets are DISCOVERED from live data (never hardcoded); a newly activated market appears automatically.', true)
rl('follows_master', 'price@IT shows the EFFECTIVE value. price_follows_master@IT (true/false) says whether the market follows the master value. Editing price@IT while follows_master=true will, on import, write the override AND flip follows_master=false so the edit takes effect (never a silent no-op).', true)
rl('', '')
rl('IDENTIFIERS', 'sku / parent_sku / ean / gtin / asin / ebay_item_id / listing_id@MKT are forced TEXT — leading zeros and long numbers are preserved (no 8.05E+12). Example EAN in this file: 08054323310123.', true)
rl('DECIMALS', 'Exported with "." decimal. The importer normalizes Italian "," on read.')
rl('DATES', 'ISO 8601 (YYYY-MM-DD).')
rl('ARRAYS', 'bullet_points / keywords are one cell, joined with " | ".')
rl('', '')
rl('DETERMINISM', 'Rows: parent SKU, then child SKU. Columns: registry order, then IT-first market order. Identical DB + options ⇒ byte-identical file (excluding _meta timestamps).', true)
readme.getRow(1).font = { bold: true, size: 14 }
readme.getRow(2).getCell('a').font = { bold: true, color: { argb: 'FFB45309' } }

// =====================================================================
// 2. Products (shared master data)
// =====================================================================
const products = wb.addWorksheet('Products', { properties: { tabColor: { argb: 'FF2563EB' } }, views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] })
products.columns = [
  { header: 'Action', key: 'action', width: 9 },
  { header: 'sku', key: 'sku', width: 22 },
  { header: 'parent_sku', key: 'parent_sku', width: 18 },
  { header: 'hierarchy_level', key: 'hierarchy', width: 15 },
  { header: 'variation_theme', key: 'vtheme', width: 15 },
  { header: 'variation_axes', key: 'vaxes', width: 16 },
  { header: 'brand', key: 'brand', width: 10 },
  { header: 'ean', key: 'ean', width: 16 },
  { header: 'gtin', key: 'gtin', width: 16 },
  { header: 'asin', key: 'asin', width: 14 },
  { header: 'ebay_item_id', key: 'ebay_item_id', width: 14 },
  { header: 'name', key: 'name', width: 30 },
  { header: 'description', key: 'description', width: 34 },
  { header: 'bullet_points', key: 'bullets', width: 34 },
  { header: 'base_price', key: 'base_price', width: 11 },
  { header: 'cost_price', key: 'cost_price', width: 11 },
  { header: 'weight_value', key: 'weight_value', width: 12 },
  { header: 'weight_unit', key: 'weight_unit', width: 11 },
  { header: 'garment_class', key: 'garment_class', width: 13 },
  { header: 'country_of_origin', key: 'origin', width: 15 },
  { header: 'status', key: 'status', width: 10 },
  { header: 'fulfillment_method', key: 'fulfillment', width: 16 },
  { header: '🔒 total_stock', key: 'total_stock', width: 12 },
  { header: '🔒 abc_class', key: 'abc_class', width: 11 },
]
const P = [
  { action: '', sku: 'GALE-JACKET', parent_sku: '', hierarchy: 'PARENT', vtheme: 'SizeColor', vaxes: 'Size | Color', brand: 'Xavia', ean: '', gtin: '', asin: 'B0GALEPAR01', ebay_item_id: '', name: 'GALE Textile Jacket', description: 'All-season CE-certified textile motorcycle jacket.', bullets: 'EN 17092 AA | Removable armour | 3-layer', base_price: 189.9, cost_price: 78.5, weight_value: 1.85, weight_unit: 'kg', garment_class: 'AA', origin: 'IT', status: 'ACTIVE', fulfillment: 'FBA', total_stock: 0, abc_class: 'A' },
  { action: '', sku: 'GALE-JACKET-BLK-M', parent_sku: 'GALE-JACKET', hierarchy: 'CHILD', vtheme: '', vaxes: 'Black | M', brand: 'Xavia', ean: '08054323310123', gtin: '08054323310123', asin: 'B0GALECHM01', ebay_item_id: '', name: 'GALE Textile Jacket — Black / M', description: 'All-season CE-certified textile motorcycle jacket.', bullets: 'EN 17092 AA | Removable armour | 3-layer', base_price: 189.9, cost_price: 78.5, weight_value: 1.85, weight_unit: 'kg', garment_class: 'AA', origin: 'IT', status: 'ACTIVE', fulfillment: 'FBA', total_stock: 42, abc_class: 'A' },
  { action: '', sku: 'GALE-JACKET-BLK-L', parent_sku: 'GALE-JACKET', hierarchy: 'CHILD', vtheme: '', vaxes: 'Black | L', brand: 'Xavia', ean: '08054323310147', gtin: '08054323310147', asin: 'B0GALECHL01', ebay_item_id: '', name: 'GALE Textile Jacket — Black / L', description: 'All-season CE-certified textile motorcycle jacket.', bullets: 'EN 17092 AA | Removable armour | 3-layer', base_price: 189.9, cost_price: 78.5, weight_value: 1.95, weight_unit: 'kg', garment_class: 'AA', origin: 'IT', status: 'ACTIVE', fulfillment: 'FBA', total_stock: 37, abc_class: 'A' },
  { action: '', sku: 'XAVIA-GLOVE-01', parent_sku: '', hierarchy: 'STANDALONE', vtheme: '', vaxes: '', brand: 'Xavia', ean: '08054323311011', gtin: '08054323311011', asin: 'B0GLOVE0101', ebay_item_id: '', name: 'Xavia Summer Mesh Gloves', description: 'Ventilated summer riding gloves with knuckle protection.', bullets: 'CE Level 1 | Touchscreen | Mesh', base_price: 49.9, cost_price: 16.2, weight_value: 0.18, weight_unit: 'kg', garment_class: '', origin: 'PK', status: 'ACTIVE', fulfillment: 'FBA', total_stock: 120, abc_class: 'B' },
  { action: '', sku: 'AIREON-STD', parent_sku: '', hierarchy: 'STANDALONE', vtheme: '', vaxes: '', brand: 'Xavia', ean: '08054323312022', gtin: '08054323312022', asin: 'B0AIREONS01', ebay_item_id: '335012345678', name: 'AIREON Mesh Jacket', description: 'High-flow summer mesh jacket, mixed jacket+pant program.', bullets: 'EN 17092 A | Mesh | CE armour', base_price: 219.0, cost_price: 91.0, weight_value: 1.4, weight_unit: 'kg', garment_class: 'A', origin: 'IT', status: 'ACTIVE', fulfillment: 'FBA', total_stock: 15, abc_class: 'A' },
]
P.forEach(r => products.addRow(r))
forceText(products, ['sku', 'parent_sku', 'ean', 'gtin', 'asin', 'ebay_item_id'])
products.getColumn('base_price').numFmt = '0.00'
products.getColumn('cost_price').numFmt = '0.00'
products.getColumn('weight_value').numFmt = '0.000'
dropdown(products, 'hierarchy', ['PARENT', 'CHILD', 'STANDALONE'])
dropdown(products, 'status', ['DRAFT', 'ACTIVE', 'INACTIVE'])
dropdown(products, 'fulfillment', ['FBA', 'FBM'])
dropdown(products, 'garment_class', ['AAA', 'AA', 'A', 'B', 'C'], { strict: false })
dropdown(products, 'action', ['', 'ADD', 'DELETE', 'IGNORE'])
greyColumn(products, 'total_stock'); greyColumn(products, 'abc_class')
styleHeader(products, new Set(['total_stock', 'abc_class']))
note(products.getCell('H1'), 'EAN — forced text so the leading zero (08054…) survives. No scientific notation.')
note(products.getCell('C2'), 'Parent row: no parent_sku. Children reference it.')

// =====================================================================
// helper to build a channel sheet with field@MARKET groups
// =====================================================================
function channelSheet(name, tab, rows, { withBestOffer = false, withTitle = true } = {}) {
  const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: tab } }, views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] })
  const cols = [
    { header: 'Action', key: 'action', width: 9 },
    { header: 'sku', key: 'sku', width: 22 },
    { header: 'product_type', key: 'product_type', width: 16 },
  ]
  const bandCols = { IT: new Set(), DE: new Set(), FR: new Set(), ES: new Set(), UK: new Set() }
  const greyCols = new Set()
  const textCols = ['sku']
  for (const m of MARKETS) {
    const add = (hdr, key, w, { grey = false, band = true } = {}) => {
      cols.push({ header: hdr, key, width: w })
      if (band) bandCols[m].add(key)
      if (grey) greyCols.add(key)
    }
    add(`price@${m}`, `price_${m}`, 10)
    add(`price_follows_master@${m}`, `pfm_${m}`, 13)
    add(`quantity@${m}`, `qty_${m}`, 10)
    add(`🔒 status@${m}`, `status_${m}`, 12, { grey: true })
    if (withBestOffer) add(`best_offer_floor@${m}`, `bof_${m}`, 14)
    add(`🔒 listing_id@${m}`, `lid_${m}`, 15, { grey: true })
    textCols.push(`lid_${m}`)
  }
  if (withTitle) { cols.push({ header: 'title@IT', key: 'title_IT', width: 30 }); cols.push({ header: 'title@DE', key: 'title_DE', width: 30 }) }
  ws.columns = cols
  rows.forEach(r => ws.addRow(r))
  forceText(ws, textCols)
  for (const m of MARKETS) ws.getColumn(`price_${m}`).numFmt = '0.00'
  if (withBestOffer) for (const m of MARKETS) ws.getColumn(`bof_${m}`).numFmt = '0.00'
  dropdown(ws, 'action', ['', 'ADD', 'DELETE', 'IGNORE'])
  for (const m of MARKETS) {
    dropdown(ws, `pfm_${m}`, ['true', 'false'])
    dropdown(ws, `status_${m}`, ['DRAFT', 'ACTIVE', 'INACTIVE', 'ENDED', 'ERROR'])
    greyColumn(ws, `status_${m}`); greyColumn(ws, `lid_${m}`)
    bandColumn(ws, `price_${m}`, m); bandColumn(ws, `pfm_${m}`, m); bandColumn(ws, `qty_${m}`, m)
    if (withBestOffer) bandColumn(ws, `bof_${m}`, m)
  }
  styleHeader(ws, greyCols, bandCols)
  return ws
}

// =====================================================================
// 3. Amazon sheet
// =====================================================================
const az = (over = {}) => ({
  action: '', product_type: 'JACKET',
  ...Object.fromEntries(MARKETS.flatMap(m => [[`price_${m}`, 189.9], [`pfm_${m}`, 'true'], [`qty_${m}`, 40], [`status_${m}`, 'ACTIVE'], [`lid_${m}`, '']])),
  ...over,
})
const amazonRows = [
  { ...az(), sku: 'GALE-JACKET', product_type: 'JACKET', ...Object.fromEntries(MARKETS.flatMap(m => [[`price_${m}`, ''], [`pfm_${m}`, ''], [`qty_${m}`, ''], [`status_${m}`, ''], [`lid_${m}`, '']])), title_IT: 'Giacca da moto GALE', title_DE: 'GALE Motorradjacke' },
  { ...az({ qty_IT: 42, lid_IT: 'B0GALECHM01', lid_DE: 'B0GALECHM01', lid_FR: 'B0GALECHM01', lid_ES: 'B0GALECHM01', lid_UK: 'B0GALECHM01' }), sku: 'GALE-JACKET-BLK-M', title_IT: 'Giacca da moto GALE — Nero / M', title_DE: 'GALE Motorradjacke — Schwarz / M' },
  { ...az({ pfm_DE: 'false', price_DE: 199.9, qty_IT: 37, lid_IT: 'B0GALECHL01' }), sku: 'GALE-JACKET-BLK-L', title_IT: 'Giacca da moto GALE — Nero / L', title_DE: 'GALE Motorradjacke — Schwarz / L' },
  { ...az({ price_IT: 49.9, price_DE: 49.9, price_FR: 49.9, price_ES: 49.9, price_UK: 44.9, qty_IT: 120, product_type: 'GLOVES', lid_IT: 'B0GLOVE0101' }), sku: 'XAVIA-GLOVE-01', title_IT: 'Guanti estivi Xavia', title_DE: '__CLEAR__' },
  { ...az({ price_IT: 219.0, price_DE: 219.0, price_FR: 219.0, price_ES: 219.0, price_UK: 199.0, qty_IT: 15, lid_IT: 'B0AIREONS01' }), sku: 'AIREON-STD', title_IT: 'Giacca AIREON in mesh', title_DE: 'AIREON Mesh-Jacke' },
]
const amazon = channelSheet('Amazon', 'FFF59E0B', amazonRows, { withTitle: true })
note(amazon.getCell('D2'), 'Parent row: no per-market price/qty (non-buyable). Children carry the offers.')
// find title@DE cell for XAVIA-GLOVE-01 (row 5) to annotate __CLEAR__
note(amazon.getCell(`${amazon.getColumn('title_DE').letter}5`), '__CLEAR__ empties the German title on import. A blank cell would mean "no change".')

// =====================================================================
// 4. eBay sheet (multi-channel item only)
// =====================================================================
const ebayRows = [
  {
    action: '', sku: 'AIREON-STD', product_type: 'JACKET',
    ...Object.fromEntries(MARKETS.flatMap(m => [[`price_${m}`, m === 'UK' ? 205.0 : 225.0], [`pfm_${m}`, 'false'], [`qty_${m}`, 8], [`status_${m}`, 'ACTIVE'], [`bof_${m}`, m === 'UK' ? 180.0 : 195.0], [`lid_${m}`, m === 'IT' ? '335012345678' : '']])),
    title_IT: 'Giacca moto AIREON mesh estiva', title_DE: 'AIREON Mesh Motorradjacke',
  },
]
const ebay = channelSheet('eBay', 'FF16A34A', ebayRows, { withBestOffer: true, withTitle: true })
note(ebay.getCell('B2'), 'Same SKU as on the Amazon sheet — one product, two channels, independent per-market columns.')

// =====================================================================
// 5. _meta (veryHidden) — snapshot id, schema, market list, fingerprints
// =====================================================================
const meta = wb.addWorksheet('_meta')
meta.state = 'veryHidden'
meta.columns = [{ header: 'key', key: 'k', width: 24 }, { header: 'value', key: 'v', width: 60 }]
meta.addRow({ k: 'snapshotId', v: SNAPSHOT_ID })
meta.addRow({ k: 'schemaVersion', v: SCHEMA_VERSION })
meta.addRow({ k: 'exportedAt', v: EXPORTED_AT })
meta.addRow({ k: 'markets.amazon', v: MARKETS.join(',') })
meta.addRow({ k: 'markets.ebay', v: MARKETS.join(',') })
meta.addRow({ k: 'note', v: 'ILLUSTRATIVE sample — not live catalog data.' })
meta.addRow({ k: '', v: '' })
meta.addRow({ k: '--- fingerprints ---', v: 'sheet | row_key | hash (sha256[:16])' })
for (const r of P) meta.addRow({ k: `Products|${r.sku}`, v: fp(r.sku, 'MASTER', r) })
for (const r of amazonRows) meta.addRow({ k: `Amazon|${r.sku}`, v: fp(r.sku, 'AMAZON', r) })
for (const r of ebayRows) meta.addRow({ k: `eBay|${r.sku}`, v: fp(r.sku, 'EBAY', r) })
meta.getRow(1).font = { bold: true }

await wb.xlsx.writeFile(OUT)
console.log('Wrote', OUT)
console.log('Sheets:', wb.worksheets.map(w => `${w.name}${w.state && w.state !== 'visible' ? `(${w.state})` : ''}`).join(', '))
