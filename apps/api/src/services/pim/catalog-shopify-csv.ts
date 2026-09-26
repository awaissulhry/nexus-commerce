import { assertCsvRectangle, parseCatalogCsv } from './catalog-csv-dialect.js'
import { TRANSFER_MAX_FILE_BYTES, TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'
import { shopifyChannelKeyOf } from '../channel-mapping/shopify-draft.js'

/**
 * NCF (`docs/studies/native-channel-files.md` §2, §3) — Shopify's own product CSV (admin → Products → Export).
 *
 * One row per variant; the first row of a product carries its product fields; a product's extra pictures are rows
 * with only the handle and the picture. `Handle` ties a product's rows together. Measured on the Owner's export
 * (study §7): comma, UTF-8 without BOM, LF, decimal point, classic header names.
 *
 * This module is imported by the parse WORKER: nothing here may touch the database (the host resolves identities).
 */

export interface ShopifyCsvTable {
  headers: string[]
  /** Data records in file order; `row` is the record number (the header is row 1). Blank records are dropped. */
  records: { row: number; values: Record<string, string> }[]
  /** The file's own dialect, as read. */
  dialect: { delimiter: string; lineEnding: 'LF' | 'CRLF'; bom: boolean }
}

const MAX_CELL = 256_000

/** Read the file into a table. Refuses what Shopify itself would refuse (a nameless or repeated column). */
export function readShopifyCsv(buffer: Buffer): ShopifyCsvTable {
  if (!buffer.length || buffer.length > TRANSFER_MAX_FILE_BYTES) throw new Error('Choose a non-empty Shopify product CSV up to 10 MB')
  const { grid, delimiter } = parseCatalogCsv(buffer, TRANSFER_MAX_FILE_BYTES)
  if (!grid.length) throw new Error('Shopify’s file is empty')
  assertCsvRectangle(grid, delimiter)
  const headers = grid[0].map(h => h.replace(/^﻿/, '').trim())
  if (headers.some(h => !h)) throw new Error('A column of this Shopify file has no header. Use the file as Shopify exported it.')
  const repeated = headers.filter((h, i) => headers.indexOf(h) !== i)
  if (repeated.length) throw new Error(`Column ${repeated[0]} appears twice. Keep one of them and import again.`)
  // Two spellings of ONE Shopify column (`Handle` and `URL handle`, `Barcode` and `Variant Barcodes`): Shopify refuses
  // a file with both ("can't have both"), and Nexus would not know which to believe.
  const byKey = new Map<string, string>()
  for (const h of headers) {
    const key = shopifyChannelKeyOf(h), other = byKey.get(key)
    if (other) throw new Error(`Columns ${other} and ${h} are the same Shopify column. Keep one of them and import again.`)
    byKey.set(key, h)
  }
  if (grid.length - 1 > TRANSFER_MAX_ROWS) throw new Error(`A file can contain at most ${TRANSFER_MAX_ROWS.toLocaleString()} rows`)
  const records: ShopifyCsvTable['records'] = []
  for (const [index, line] of grid.slice(1).entries()) {
    const values: Record<string, string> = {}
    for (const [c, header] of headers.entries()) {
      const cell = line[c] ?? ''
      if (cell.length > MAX_CELL) throw new Error(`Row ${index + 2}, ${header}: the cell exceeds 256,000 characters`)
      values[header] = cell
    }
    if (Object.values(values).some(v => v.trim())) records.push({ row: index + 2, values })
  }
  if (!records.length) throw new Error('Shopify’s file contains no product rows')
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  return { headers, records, dialect: { delimiter, lineEnding: buffer.includes('\r\n') ? 'CRLF' : 'LF', bom } }
}

/** How many products (handles) and variant rows a table holds: the one sentence a door says before it reads further. */
export function shopifyCsvShape(table: ShopifyCsvTable) {
  const handleHeader = table.headers.find(h => shopifyChannelKeyOf(h) === 'Handle')
  const handles = new Set(table.records.map(r => (handleHeader ? r.values[handleHeader] : '')?.trim()).filter(Boolean))
  return { products: handles.size, rows: table.records.length }
}

/** NCF N2 — the file is recognised and read; mapping it onto Nexus listings arrives with N6. */
export function shopifyCsvNotYet(filename: string, table: ShopifyCsvTable): never {
  const shape = shopifyCsvShape(table)
  throw new Error(`${filename} is Shopify’s product CSV (${shape.products} products, ${shape.rows} rows). Nexus recognised it, but cannot import it yet.`)
}
