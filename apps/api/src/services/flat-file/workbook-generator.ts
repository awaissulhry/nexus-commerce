/**
 * FF1.7 — Deterministic workbook generator.
 *
 * Converts a WorkbookModel + WorkbookData + export metadata into a
 * byte-reproducible .xlsx Uint8Array.
 *
 * Determinism guarantees:
 *   - wb.created = wb.modified = new Date(meta.exportedAt + 'T00:00:00Z')
 *     (fixed non-volatile timestamp keeps the ZIP central-directory stable)
 *   - Products rows: parent-first within each family, then alphabetical by sku
 *   - Channel rows: alphabetical by sku
 *   - Columns: registry order, then field@MKT groups in markets[] order
 *
 * NOTE — Images sheet: DEFERRED to FF2. WorkbookData has no image rows yet;
 * the Images sheet specification is still open. The _meta and README sheets
 * note this omission explicitly.
 *
 * writeCell() from ./xlsx-cell is the ONLY way to write a data value —
 * it enforces correct numFmt, text-forcing, decimal precision, and ISO dates.
 */
import ExcelJS from 'exceljs'
import type { FieldDefinition, SheetDefinition, WorkbookModel } from './registry/types'
import { writeCell } from './xlsx-cell'
import { resolveEffective } from './resolver'
import type { WorkbookData } from './fetch'
import { rowFingerprint } from './fingerprint'

// ── Constants ─────────────────────────────────────────────────────────────────

const GREY = 'FFEFEFEF'
const HDR_DARK = 'FF1F2933'
const GREY_HDR = 'FF6B7280'
const SCHEMA_VERSION = 'ff-v2.0'

/** Header-bar accent colors per market (FF0 palette). */
const BAND_HDR: Record<string, string> = {
  IT: 'FF3B6FE0',
  DE: 'FFB4632A',
  FR: 'FF2F8F4E',
  ES: 'FF7C3AED',
  UK: 'FFC0392B',
}

/** Row-band fill colors per market (FF0 palette). */
const BAND_ROW: Record<string, string> = {
  IT: 'FFE8F0FE',
  DE: 'FFFCEFE6',
  FR: 'FFE6F6EC',
  ES: 'FFF3E8FD',
  UK: 'FFFDECEC',
}

/** Tab colors per sheet name. */
const TAB: Record<string, string> = {
  README: 'FF1F2933',
  Products: 'FF2563EB',
  Amazon: 'FFF59E0B',
  eBay: 'FF16A34A',
  Shopify: 'FF059669',
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isReadonly(f: FieldDefinition): boolean {
  return f.cls === 'READONLY_SYNCED' || f.cls === 'DERIVED'
}

function mktHdrColor(mkt: string): string {
  return BAND_HDR[mkt] ?? 'FF334155'
}

function mktRowColor(mkt: string): string {
  return BAND_ROW[mkt] ?? 'FFF1F5F9'
}

/**
 * Style the first row (header) of a worksheet.
 * - Dark background + white bold font by default.
 * - Grey background for READONLY/DERIVED columns (keyed via greyCols).
 * - Per-market accent color for banded column groups (keyed via bandCols).
 */
function styleHeader(
  ws: ExcelJS.Worksheet,
  greyCols: Set<string>,
  bandCols: Record<string, Set<string>>,
): void {
  const row = ws.getRow(1)
  row.height = 22
  row.eachCell((cell, colNo) => {
    const key = ws.getColumn(colNo).key ?? ''
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.alignment = { vertical: 'middle', wrapText: true }
    let fillArgb = HDR_DARK
    if (greyCols.has(key)) {
      fillArgb = GREY_HDR
    } else {
      const bandEntries = Object.entries(bandCols)
      for (let i = 0; i < bandEntries.length; i++) {
        if (bandEntries[i][1].has(key)) {
          fillArgb = mktHdrColor(bandEntries[i][0])
          break
        }
      }
    }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } }
  })
}

/** Apply grey fill + locked protection to every data cell in a column. */
function greyCol(ws: ExcelJS.Worksheet, key: string): void {
  const lastRow = ws.rowCount
  for (let r = 2; r <= lastRow; r++) {
    const cell = ws.getRow(r).getCell(key)
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } }
    cell.font = { color: { argb: 'FF6B7280' } }
    cell.protection = { locked: true }
  }
}

/** Apply per-market row-band fill to every data cell in a column. */
function bandCol(ws: ExcelJS.Worksheet, key: string, mkt: string): void {
  const lastRow = ws.rowCount
  for (let r = 2; r <= lastRow; r++) {
    const cell = ws.getRow(r).getCell(key)
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: mktRowColor(mkt) } }
  }
}

/** Add an enum dropdown to every data cell in a column. */
function addDropdown(ws: ExcelJS.Worksheet, key: string, opts: string[], strict = true): void {
  const lastRow = ws.rowCount
  for (let r = 2; r <= lastRow; r++) {
    const cell = ws.getRow(r).getCell(key)
    const dv: ExcelJS.DataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${opts.join(',')}"`],
      showErrorMessage: strict,
    }
    if (strict) {
      dv.errorStyle = 'warning'
      dv.error = 'Value not in the allowed list (strict enum).'
    }
    cell.dataValidation = dv
  }
}

/**
 * Read a raw value from a product/listing row using the field's source spec.
 *
 * Special case: the `parent_sku` field has source.column = 'parentId' (a DB FK),
 * but fetchCatalog already resolves it to the parent SKU string and stores it
 * as `row.parent_sku`. We read from the resolved key, not the raw FK column.
 *
 * Dot-path columns (e.g. 'categoryAttributes.material') are traversed with
 * a reduce so nested JSON objects are accessed correctly.
 */
function readSource(row: Record<string, unknown>, field: FieldDefinition): unknown {
  if (field.id === 'parent_sku') return row['parent_sku'] ?? ''
  const col = field.source.column
  if (col.includes('.')) {
    return col.split('.').reduce<unknown>((o, k) => {
      if (o == null || typeof o !== 'object') return undefined
      return (o as Record<string, unknown>)[k]
    }, row) ?? ''
  }
  return row[col] ?? ''
}

// ── README sheet ──────────────────────────────────────────────────────────────

function buildReadme(
  wb: ExcelJS.Workbook,
  model: WorkbookModel,
  meta: { snapshotId: string; exportedAt: string },
): void {
  const ws = wb.addWorksheet('README', {
    properties: { tabColor: { argb: TAB['README'] } },
  })
  ws.columns = [
    { key: 'a', width: 26 },
    { key: 'b', width: 96 },
  ] as any

  const rl = (a: string, b: string, bold = false) => {
    const r = ws.addRow({ a, b })
    if (bold) r.getCell('a').font = { bold: true }
    r.getCell('b').alignment = { wrapText: true, vertical: 'top' }
    return r
  }

  // Derive expected sheet names from model (README is already added, others follow)
  const sheetNames = ['README', 'Products']
  for (const sheet of model.sheets) {
    if (sheet.name !== 'Products') sheetNames.push(sheet.name)
  }
  sheetNames.push('(Images — deferred to FF2)', '_meta')

  rl('NEXUS FLAT FILE v2', 'snapshotId: ' + meta.snapshotId + '  exportedAt: ' + meta.exportedAt, true)
  rl('', '')
  rl('SHEETS', sheetNames.join(' \xB7 '), true) // middle dot separator
  rl('Products', 'One row per SKU. Master/shared data from the Product model (parent + child rows).')
  rl('Channel sheets', 'Per-market listing data. field@MARKET groups for every discovered market.')
  rl('Images', 'DEFERRED — not included in this export (FF2 spec pending).')
  rl('_meta (hidden)', 'snapshotId, schemaVersion, exportedAt, market list, and per-row fingerprints. No volatile values live on visible sheets.')
  rl('', '')
  rl('MARKETS', '', true)
  const marketEntries = Object.entries(model.markets)
  for (let i = 0; i < marketEntries.length; i++) {
    const mkts = marketEntries[i][1] as string[]
    if (mkts.length > 0) rl(marketEntries[i][0], mkts.join(', '))
  }
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
  rl('READONLY (🔒)', 'Greyed columns are synced-from-channel or computed (fees, live status, sync state). Exported for reference; IGNORED on import.', true)
  rl('', '')
  rl('field@MARKET', 'Per-market columns, e.g. price@IT, quantity@DE. Markets are discovered from live data; a newly activated market appears automatically.', true)
  rl('follows_master', 'price_follows_master@IT shows true/false. Editing price@IT while follows_master=true writes the override AND flips follows_master=false so the edit takes effect.', true)
  rl('', '')
  rl('IDENTIFIERS', 'sku / parent_sku / ean / gtin are forced TEXT. Leading zeros and long numbers are preserved (no 8.05E+12).', true)
  rl('DECIMALS', 'Exported with "." decimal. The importer normalises Italian "," on read.')
  rl('DATES', 'ISO 8601 (YYYY-MM-DD).')
  rl('ARRAYS', 'bullet_points / keywords are one cell, joined with " | ".')
  rl('', '')
  rl('DETERMINISM', 'Rows: parent SKU first, then child SKU. Columns: registry order, then IT-first market order. Identical DB + options => byte-identical file.', true)

  ws.getRow(1).font = { bold: true, size: 14 }
}

// ── Products sheet ────────────────────────────────────────────────────────────

function buildProductsSheet(
  wb: ExcelJS.Workbook,
  sheet: SheetDefinition,
  products: Array<Record<string, unknown>>,
  fingerprints: Array<{ key: string; hash: string }>,
): void {
  const ws = wb.addWorksheet('Products', {
    properties: { tabColor: { argb: TAB['Products'] } },
    views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }],
  })

  // Build column definitions
  const greyCols = new Set<string>()
  const colDefs: Array<{ header: string; key: string; width: number }> = [
    { header: 'Action', key: 'action', width: 9 },
  ]
  for (const f of sheet.sharedFields) {
    const label = isReadonly(f) ? '🔒 ' + f.label : f.label
    colDefs.push({ header: label, key: f.id, width: f.width ?? 16 })
    if (isReadonly(f)) greyCols.add(f.id)
  }
  ws.columns = colDefs as any

  // Sort: group children under their parent (parent first within family, then by sku)
  // Sort key: (rootKey = parent_sku || sku, isChild = parent_sku ? 1 : 0, sku)
  const sorted = [...products].sort((a, b) => {
    const rA = String(a['parent_sku'] || a['sku'] || '')
    const rB = String(b['parent_sku'] || b['sku'] || '')
    if (rA < rB) return -1
    if (rA > rB) return 1
    const cA = a['parent_sku'] ? 1 : 0
    const cB = b['parent_sku'] ? 1 : 0
    if (cA !== cB) return cA - cB
    const sA = String(a['sku'] || '')
    const sB = String(b['sku'] || '')
    return sA < sB ? -1 : sA > sB ? 1 : 0
  })

  // Write data rows
  for (const p of sorted) {
    const row = ws.addRow({})
    row.getCell('action').value = ''
    const rowObj: Record<string, unknown> = {}
    for (const f of sheet.sharedFields) {
      const value = readSource(p, f)
      writeCell(row.getCell(f.id), f, value)
      rowObj[f.id] = value
    }
    fingerprints.push({
      key: 'Products|' + String(p['sku'] ?? ''),
      hash: rowFingerprint(String(p['sku'] ?? ''), 'MASTER', rowObj),
    })
  }

  // Apply column-level formatting (after all rows exist)
  for (const f of sheet.sharedFields) {
    if (isReadonly(f)) greyCol(ws, f.id)
    if (f.kind === 'enum' && f.enumOptions) {
      addDropdown(ws, f.id, f.enumOptions, f.enumMode !== 'open')
    }
  }
  addDropdown(ws, 'action', ['', 'ADD', 'DELETE', 'IGNORE'], true)

  // Style header row last (reads cell keys via eachCell)
  styleHeader(ws, greyCols, {})
}

// ── Channel sheet ─────────────────────────────────────────────────────────────

function buildChannelSheet(
  wb: ExcelJS.Workbook,
  sheet: SheetDefinition,
  markets: string[],
  listings: Array<Record<string, unknown>>,
  fingerprints: Array<{ key: string; hash: string }>,
): void {
  const tabColor = TAB[sheet.name] ?? 'FF334155'
  const ws = wb.addWorksheet(sheet.name, {
    properties: { tabColor: { argb: tabColor } },
    views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }],
  })

  // Build column definitions
  const greyCols = new Set<string>()
  const bandCols: Record<string, Set<string>> = {}

  const colDefs: Array<{ header: string; key: string; width: number }> = [
    { header: 'Action', key: 'action', width: 9 },
    { header: 'sku', key: 'sku', width: 22 },
  ]

  // Shared channel fields (currently empty per registry; included for future-proofing)
  for (const f of sheet.sharedFields) {
    const label = isReadonly(f) ? '🔒 ' + f.label : f.label
    colDefs.push({ header: label, key: f.id, width: f.width ?? 16 })
    if (isReadonly(f)) greyCols.add(f.id)
  }

  // Per-market field groups — for each market, expand each field into field@MKT
  // and, for governed fields, an extra field_follows_master@MKT column.
  for (const mkt of markets) {
    bandCols[mkt] = new Set<string>()
    for (const f of sheet.marketFields) {
      const colKey = f.id + '@' + mkt
      const label = isReadonly(f) ? '🔒 ' + f.id + '@' + mkt : f.id + '@' + mkt
      colDefs.push({ header: label, key: colKey, width: f.width ?? 16 })
      if (isReadonly(f)) {
        greyCols.add(colKey)
      } else {
        bandCols[mkt].add(colKey)
      }
      // Governed field: also emit a follow-master boolean column
      if (f.followMaster) {
        const fmKey = f.id + '_follows_master@' + mkt
        colDefs.push({ header: fmKey, key: fmKey, width: 14 })
        bandCols[mkt].add(fmKey)
      }
    }
  }

  ws.columns = colDefs as any

  // Group listings by SKU (each listing row has .sku from fetchCatalog)
  const bySku: Record<string, Array<Record<string, unknown>>> = {}
  for (const l of listings) {
    const sku = String(l['sku'] ?? '')
    if (!bySku[sku]) bySku[sku] = []
    bySku[sku].push(l)
  }

  // Deterministic SKU order (alphabetical)
  const skus = Object.keys(bySku).sort()

  // Write data rows
  for (const sku of skus) {
    const row = ws.addRow({})
    row.getCell('action').value = ''
    const skuCell = row.getCell('sku')
    skuCell.value = sku
    skuCell.numFmt = '@'

    // Shared channel fields (currently empty; write empty for completeness)
    for (const f of sheet.sharedFields) {
      row.getCell(f.id).value = ''
    }

    const rowObj: Record<string, unknown> = {}

    for (const mkt of markets) {
      const listing = bySku[sku]
        ? bySku[sku].find(l => String(l['marketplace']) === mkt) ?? null
        : null

      for (const f of sheet.marketFields) {
        const colKey = f.id + '@' + mkt
        const resolved = listing
          ? resolveEffective(listing, f)
          : { value: '', followsMaster: false }
        writeCell(row.getCell(colKey), f, resolved.value)
        rowObj[colKey] = resolved.value

        if (f.followMaster) {
          const fmKey = f.id + '_follows_master@' + mkt
          row.getCell(fmKey).value = resolved.followsMaster ? 'true' : 'false'
          rowObj[fmKey] = String(resolved.followsMaster)
        }
      }
    }

    fingerprints.push({
      key: sheet.name + '|' + sku,
      hash: rowFingerprint(sku, sheet.channel ?? sheet.name.toUpperCase(), rowObj),
    })
  }

  // Apply column-level formatting (after all rows exist)
  for (const f of sheet.sharedFields) {
    if (isReadonly(f)) greyCol(ws, f.id)
    if (f.kind === 'enum' && f.enumOptions) {
      addDropdown(ws, f.id, f.enumOptions, f.enumMode !== 'open')
    }
  }

  for (const mkt of markets) {
    for (const f of sheet.marketFields) {
      const colKey = f.id + '@' + mkt
      if (isReadonly(f)) {
        greyCol(ws, colKey)
      } else {
        bandCol(ws, colKey, mkt)
        if (f.kind === 'enum' && f.enumOptions) {
          addDropdown(ws, colKey, f.enumOptions, f.enumMode !== 'open')
        }
      }
      if (f.followMaster) {
        const fmKey = f.id + '_follows_master@' + mkt
        bandCol(ws, fmKey, mkt)
        addDropdown(ws, fmKey, ['true', 'false'], true)
      }
    }
  }
  addDropdown(ws, 'action', ['', 'ADD', 'DELETE', 'IGNORE'], true)

  // Style header row last
  styleHeader(ws, greyCols, bandCols)
}

// ── Meta sheet ────────────────────────────────────────────────────────────────

function buildMetaSheet(
  wb: ExcelJS.Workbook,
  model: WorkbookModel,
  meta: { snapshotId: string; exportedAt: string },
  fingerprints: Array<{ key: string; hash: string }>,
): void {
  const ws = wb.addWorksheet('_meta')
  // veryHidden: not visible in the sheet tab bar, not accessible via Format > Sheet > Unhide
  ;(ws as any).state = 'veryHidden'
  ws.columns = [
    { header: 'key', key: 'k', width: 24 },
    { header: 'value', key: 'v', width: 60 },
  ] as any

  // Snapshot metadata
  ws.addRow({ k: 'snapshotId', v: meta.snapshotId })
  ws.addRow({ k: 'schemaVersion', v: SCHEMA_VERSION })
  ws.addRow({ k: 'exportedAt', v: meta.exportedAt })

  // Per-channel market lists
  const channelEntries = Object.entries(model.markets)
  for (let i = 0; i < channelEntries.length; i++) {
    const mkts = channelEntries[i][1] as string[]
    if (mkts.length > 0) {
      ws.addRow({ k: 'markets.' + channelEntries[i][0].toLowerCase(), v: mkts.join(',') })
    }
  }

  // Fingerprint table
  ws.addRow({ k: '', v: '' })
  ws.addRow({ k: '--- fingerprints ---', v: 'key | hash (sha256[:16])' })
  for (const fp of fingerprints) {
    ws.addRow({ k: fp.key, v: fp.hash })
  }

  ws.getRow(1).font = { bold: true }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a byte-reproducible .xlsx workbook from the given model and data.
 *
 * @param model - Sheet/field definitions and discovered markets (from Task 5).
 * @param data  - Product rows and channel listing rows (from Task 6).
 * @param meta  - Snapshot identifier and export date (YYYY-MM-DD).
 * @returns The XLSX file contents as a Uint8Array.
 */
export async function generateWorkbook(
  model: WorkbookModel,
  data: WorkbookData,
  meta: { snapshotId: string; exportedAt: string },
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Nexus Flat File v2'
  // Fixed date → stable ZIP central-directory metadata → byte-identical output
  const fixedDate = new Date(meta.exportedAt + 'T00:00:00Z')
  wb.created = fixedDate
  wb.modified = fixedDate

  const fingerprints: Array<{ key: string; hash: string }> = []

  // Sheet order: README, Products, then per-channel sheets, then _meta
  buildReadme(wb, model, meta)

  for (const sheet of model.sheets) {
    if (sheet.name === 'Products') {
      buildProductsSheet(wb, sheet, data.products, fingerprints)
    } else if (sheet.channel) {
      const markets = model.markets[sheet.channel] ?? []
      const listings = data.listings[sheet.channel] ?? []
      buildChannelSheet(wb, sheet, markets, listings, fingerprints)
    }
    // Images sheet: DEFERRED — not emitted in FF1 (no image rows in WorkbookData yet)
  }

  buildMetaSheet(wb, model, meta, fingerprints)

  return new Uint8Array(await wb.xlsx.writeBuffer())
}
