/**
 * NCF — Shopify's own product CSV: recognised from its header, read into a table, and routed on the parse worker.
 * A Nexus CSV reads exactly as before; Shopify's inventory export is refused (stock is never imported from a file).
 */
import { describe, expect, it } from 'vitest'
import { sniffCsv } from './channel-file-sniff.js'
import { readShopifyCsv, shopifyCsvShape } from './catalog-shopify-csv.js'
import { readTransferFile } from './catalog-transfer-file.js'
import { openWorkbookParser } from './workbook-parse.js'
import { csvOf, SHOPIFY_CLASSIC_HEADERS, SHOPIFY_CURRENT_HEADERS, SHOPIFY_INVENTORY_HEADERS, SHOPIFY_SAMPLE_ROWS, shopifySampleCsv } from './catalog-transfer-test/shopify-csv-fixtures.js'

const NEXUS_CSV = Buffer.from('entity,sku,channel,accountId,marketplace,aliasKey,locale,field,action,format,value,version\nProducts,GALE-JACKET,,,,,,name,SET,text,"Gale, blue",\nOverrides,GALE-JACKET,EBAY,acct,IT,,,title,SET,text,Gale,3\n')
const refuseBaseline = async () => { throw new Error('no baseline in this suite') }

describe('NCF N2 — sniffCsv says what a CSV is from its header alone', () => {
  it('recognises Shopify’s product CSV under its classic and its current header names', () => {
    expect(sniffCsv(shopifySampleCsv())).toMatchObject({ kind: 'shopify-product-csv', delimiter: ',' })
    expect(sniffCsv(csvOf(SHOPIFY_CURRENT_HEADERS, []))).toMatchObject({ kind: 'shopify-product-csv' })
    // Re-saved by a European Excel: semicolons and a BOM.
    expect(sniffCsv(shopifySampleCsv({ delimiter: ';', bom: true, eol: '\r\n' }))).toMatchObject({ kind: 'shopify-product-csv', delimiter: ';' })
  })

  it('names Shopify’s inventory export as what it is', () => {
    expect(sniffCsv(csvOf(SHOPIFY_INVENTORY_HEADERS, [{ Handle: 'acme-jacket', SKU: 'ACME-JACKET-S', Location: 'Shop', 'On hand (current)': '4' }]))).toMatchObject({ kind: 'shopify-inventory-csv' })
  })

  it('names a Nexus attribute CSV, and anything else as other', () => {
    expect(sniffCsv(NEXUS_CSV)).toMatchObject({ kind: 'nexus-csv' })
    expect(sniffCsv(Buffer.from('Handle,Title\nacme,Acme\n'))).toMatchObject({ kind: 'other' })
    expect(sniffCsv(Buffer.from([0xff, 0x00, 0x22, 0x0a]))).toMatchObject({ kind: 'other' })
  })
})

describe('NCF N2 — readShopifyCsv', () => {
  it('reads every record in file order, with its record number and the file’s dialect', () => {
    const table = readShopifyCsv(shopifySampleCsv())
    expect(table.headers).toEqual(SHOPIFY_CLASSIC_HEADERS)
    expect(table.records.map(r => r.row)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(table.records[0].values['Body (HTML)']).toBe('<p>A warm jacket,\nwith "two" pockets.</p>')
    expect(table.dialect).toEqual({ delimiter: ',', lineEnding: 'LF', bom: false })
    expect(shopifyCsvShape(table)).toEqual({ products: 3, rows: SHOPIFY_SAMPLE_ROWS.length })
    expect(readShopifyCsv(shopifySampleCsv({ bom: true, eol: '\r\n' })).dialect).toEqual({ delimiter: ',', lineEnding: 'CRLF', bom: true })
  })

  it('refuses two spellings of one Shopify column, and a repeated or nameless column', () => {
    expect(() => readShopifyCsv(csvOf([...SHOPIFY_CLASSIC_HEADERS, 'URL handle'], []))).toThrow('Columns Handle and URL handle are the same Shopify column')
    expect(() => readShopifyCsv(csvOf([...SHOPIFY_CLASSIC_HEADERS, 'Title'], []))).toThrow('Column Title appears twice')
    expect(() => readShopifyCsv(csvOf([...SHOPIFY_CLASSIC_HEADERS, ''], []))).toThrow('has no header')
    expect(() => readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, []))).toThrow('contains no product rows')
  })
})

describe('NCF N2 — the parse worker routes a CSV by what it is', () => {
  it('reads Shopify’s product CSV as Shopify’s file, refuses its inventory CSV, and reads a Nexus CSV exactly as before', async () => {
    const session = openWorkbookParser({ resolveBaseline: refuseBaseline })
    try {
      const shopify = await session.read('products_export_1.csv', shopifySampleCsv(), 128 * 1024 * 1024)
      expect(shopify.kind).toBe('shopify')
      expect(shopify.kind === 'shopify' && shopify.table).toEqual(readShopifyCsv(shopifySampleCsv()))
      await expect(session.read('inventory_export_1.csv', csvOf(SHOPIFY_INVENTORY_HEADERS, [{ Handle: 'a', SKU: 'b', Location: 'Shop' }]), 128 * 1024 * 1024))
        .rejects.toThrow('Nexus never imports stock from a file')
      const nexus = await session.read('rows.csv', NEXUS_CSV, 128 * 1024 * 1024)
      expect(nexus).toEqual({ kind: 'transfer', parsed: await readTransferFile(NEXUS_CSV, 'rows.csv'), expandedBytes: 0 })
    } finally { await session.close() }
  }, 60_000)
})
