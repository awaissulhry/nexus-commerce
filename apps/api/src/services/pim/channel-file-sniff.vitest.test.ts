/**
 * CFI-1 — the sniff says what a workbook is from its own content, with a zip walk only.
 *
 * Why it matters (records/2026-09-24-results.md §3, d6): "Nexus workbook" + Amazon's own template sent the file to
 * ExcelJS on the API's main thread for > 8 min. Every generic reader now asks this module first.
 */
import { describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { sniffWorkbook } from './channel-file-sniff.js'
import { readTransferFile } from './catalog-transfer-file.js'
import { readSourceFile } from './catalog-source-file.js'
import { ooxmlWorkbook, amazonTemplateSheets, oldAmazonFlatFileSheets, EBAY_HEADERS, ATTRIBUTE_SHEET_HEADERS } from './catalog-transfer-test/channel-file-fixtures.js'

describe('sniffWorkbook', () => {
  it('finds the Amazon template sheet by its key row, not the dictionary sheet that also lists keys', async () => {
    const sniff = await sniffWorkbook(await ooxmlWorkbook({ sheets: amazonTemplateSheets(), sharedStrings: true }))
    expect(sniff).toMatchObject({ kind: 'amazon-template', sheet: 'Modello', flavor: 'transitional' })
  })

  it('reads a Strict OOXML template (purl.oclc.org namespaces) the same way', async () => {
    const sniff = await sniffWorkbook(await ooxmlWorkbook({ sheets: amazonTemplateSheets(), strict: true, sharedStrings: true }))
    expect(sniff).toMatchObject({ kind: 'amazon-template', sheet: 'Modello', flavor: 'strict' })
  })

  it('recognises the old flat file (TemplateType marker, item_sku key row)', async () => {
    expect(await sniffWorkbook(await ooxmlWorkbook({ sheets: oldAmazonFlatFileSheets() }))).toMatchObject({ kind: 'amazon-template', sheet: 'Modello' })
  })

  it('recognises our eBay workbook by its headers under any sheet name', async () => {
    for (const name of ['ebay_it', 'AIREON']) {
      const sniff = await sniffWorkbook(await ooxmlWorkbook({ sheets: [{ name, rows: { 1: EBAY_HEADERS, 2: ['AIREON', '', 'parent', '', '', '', '', 'Giacca', '1000', '177104'] } }] }))
      expect(sniff).toMatchObject({ kind: 'ebay-workbook', sheet: name })
    }
  })

  it('names the Title-Case Amazon attribute sheet as what it is — not a template', async () => {
    const sniff = await sniffWorkbook(await ooxmlWorkbook({ sheets: [{ name: 'amazon_OUTERWEAR_IT', rows: { 1: ATTRIBUTE_SHEET_HEADERS, 2: ['GALE-JACKET', 'OUTERWEAR', 'partial_update'] } }] }))
    expect(sniff).toMatchObject({ kind: 'amazon-attribute-sheet', sheet: 'amazon_OUTERWEAR_IT' })
    expect(sniff.label).toMatch(/not an Amazon template/)
  })

  it('recognises a Nexus workbook from its sheet names', async () => {
    expect((await sniffWorkbook(await ooxmlWorkbook({ sheets: [{ name: 'Products', rows: { 1: ['sku'] } }, { name: 'Overrides', rows: { 1: ['sku'] } }] }))).kind).toBe('nexus-workbook')
    expect((await sniffWorkbook(await ooxmlWorkbook({ sheets: [{ name: 'Nexus workbook', rows: { 1: ['kind'] } }, { name: 'Amazon IT', rows: { 1: ['sku'] } }] }))).kind).toBe('nexus-workbook')
  })

  it('calls anything else "other", including bytes that are not a workbook', async () => {
    expect(await sniffWorkbook(Buffer.from('SKU,Name\nA,B'))).toMatchObject({ kind: 'other', flavor: null })
    expect((await sniffWorkbook(await ooxmlWorkbook({ sheets: [{ name: 'Sheet1', rows: { 1: ['sku', 'name'], 2: ['A', 'B'] } }] }))).kind).toBe('other')
  })

  it('decodes a large shared-string table in one pass (it was O(n²): 0.8 s on an Italian template)', async () => {
    // 30,000 strings the sheet never uses, like a real template's valid-value lists; only `<si>` items, never `<si …>`.
    const extra = Array.from({ length: 30_000 }, (_, i) => `valore valido numero ${i} con testo di riempimento`)
    const file = await ooxmlWorkbook({ sheets: amazonTemplateSheets(), sharedStrings: true, extraSharedStrings: extra })
    const started = performance.now()
    expect((await sniffWorkbook(file)).kind).toBe('amazon-template')
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('no generic reader hands an Amazon template to ExcelJS', () => {
  it('the catalog "Nexus workbook" reader refuses it at once and names the right door', async () => {
    const load = vi.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get')
    try {
      const file = await ooxmlWorkbook({ sheets: amazonTemplateSheets(), sharedStrings: true, complete: true })
      const started = performance.now()
      await expect(readTransferFile(file, 'GALE IT.xlsx')).rejects.toThrow(/is an Amazon template/)
      expect(performance.now() - started).toBeLessThan(1000)
      expect(load).not.toHaveBeenCalled()
      // `.xlsm` is Amazon's own extension: it reaches the same refusal, not "Use CSV or XLSX".
      await expect(readTransferFile(file, 'GALE IT.xlsm')).rejects.toThrow(/is an Amazon template/)
    } finally { load.mockRestore() }
  })

  it('the catalog reader sends the Amazon attribute sheet to "Map a source file"', async () => {
    const file = await ooxmlWorkbook({ sheets: [{ name: 'amazon_OUTERWEAR_IT', rows: { 1: ATTRIBUTE_SHEET_HEADERS } }], complete: true })
    await expect(readTransferFile(file, 'amazon_OUTERWEAR_IT.xlsx')).rejects.toThrow(/Map a source file/)
  })

  it('the "Map a source file" reader refuses an Amazon template without loading it', async () => {
    const load = vi.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get')
    try {
      await expect(readSourceFile(await ooxmlWorkbook({ sheets: amazonTemplateSheets(), complete: true }), 'template.xlsx')).rejects.toThrow(/is an Amazon template/)
      expect(load).not.toHaveBeenCalled()
    } finally { load.mockRestore() }
  })

  it('the "Map a source file" reader still opens the Amazon attribute sheet as a plain table', async () => {
    const table = await readSourceFile(await ooxmlWorkbook({ sheets: [{ name: 'amazon_OUTERWEAR_IT', rows: { 1: ATTRIBUTE_SHEET_HEADERS, 2: ['GALE-JACKET', 'OUTERWEAR', 'partial_update'] } }], complete: true }), 'amazon_OUTERWEAR_IT.xlsx')
    expect(table.headers).toEqual(ATTRIBUTE_SHEET_HEADERS)
    expect(table.records[0]).toMatchObject({ 'Seller SKU': 'GALE-JACKET', Operation: 'partial_update' })
  })
})
