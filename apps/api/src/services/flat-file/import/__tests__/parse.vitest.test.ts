/**
 * FF2.1 — parseWorkbook TDD tests.
 *
 * Written BEFORE the implementation. Two suites:
 *   1. Structural parse of a real FF1 workbook (round-trip boundary).
 *   2. Cell-level mutation cases (hand-built cells to control raw types).
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseWorkbook } from '../parse.js'
import { generateWorkbook } from '../../workbook-generator.js'
import { MASTER_FIELDS } from '../../registry/master-fields.js'
import { CHANNEL_MARKET_FIELDS } from '../../registry/channel-fields.js'
import type { WorkbookModel } from '../../registry/types.js'
import type { WorkbookData } from '../../fetch.js'

// ── Fixtures for structural test ──────────────────────────────────────────────

const MODEL: WorkbookModel = {
  markets: { AMAZON: ['IT', 'DE'], EBAY: [], SHOPIFY: [] },
  sheets: [
    {
      name: 'Products',
      sharedFields: MASTER_FIELDS,
      marketFields: [],
    },
    {
      name: 'Amazon',
      channel: 'AMAZON',
      sharedFields: [],
      marketFields: CHANNEL_MARKET_FIELDS,
    },
  ],
}

const DATA: WorkbookData = {
  products: [
    {
      sku: 'P1',
      parent_sku: '',
      ean: '08054323310123',
    },
  ],
  listings: {
    AMAZON: [
      {
        sku: 'P1',
        marketplace: 'IT',
        followMasterPrice: true,
        masterPrice: 189.9,
        priceOverride: null,
      },
    ],
    EBAY: [],
    SHOPIFY: [],
  },
}

const META = { snapshotId: 'snap-1', exportedAt: '2026-07-05' }

// ── Helper: build a minimal hand-crafted worksheet (one header row + one data row) ──

async function buildHandCraftedWorkbook(
  headers: string[],
  values: unknown[],
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Products')
  for (let i = 0; i < headers.length; i++) {
    ws.getRow(1).getCell(i + 1).value = headers[i]
  }
  for (let i = 0; i < values.length; i++) {
    ws.getRow(2).getCell(i + 1).value = values[i] as any
  }
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

// ── Suite 1: Round-trip via FF1 generator ──────────────────────────────────────

describe('parseWorkbook — structural (FF1 round-trip)', () => {
  it('sheets map contains Products and Amazon but not _meta or README', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, META)
    const parsed = await parseWorkbook(bytes)

    expect(Object.keys(parsed.sheets)).toContain('Products')
    expect(Object.keys(parsed.sheets)).toContain('Amazon')
    expect(Object.keys(parsed.sheets)).not.toContain('_meta')
    expect(Object.keys(parsed.sheets)).not.toContain('README')
  })

  it('meta.snapshotId reads from the hidden _meta sheet', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, META)
    const parsed = await parseWorkbook(bytes)

    expect(parsed.meta.snapshotId).toBe('snap-1')
  })

  it('meta.markets contains AMAZON from _meta markets.amazon row', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, META)
    const parsed = await parseWorkbook(bytes)

    expect(parsed.meta.markets).toBeDefined()
    expect(parsed.meta.markets!['AMAZON']).toEqual(expect.arrayContaining(['IT', 'DE']))
  })

  it('EAN cell preserves leading zero — forced-text round-trip keeps string', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, META)
    const parsed = await parseWorkbook(bytes)

    const productsSheet = parsed.sheets['Products']
    expect(productsSheet).toBeDefined()
    expect(productsSheet!.rows.length).toBeGreaterThan(0)

    // The P1 product is the only product row; EAN column header = 'ean' (field id, not label)
    const row = productsSheet!.rows.find(r => r.cells['ean'] != null || r.cells['sku'] != null)
    expect(row).toBeDefined()
    const eanCell = row!.cells['ean']
    expect(eanCell).toBeDefined()
    expect(eanCell!.value).toBe('08054323310123')
    expect(eanCell!.warning).toBeUndefined()
  })

  it('parseWarnings is an array (empty for a clean workbook)', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, META)
    const parsed = await parseWorkbook(bytes)

    expect(Array.isArray(parsed.parseWarnings)).toBe(true)
  })

  // ── FF2.7: fingerprint extraction ─────────────────────────────────────────
  it('meta.fingerprints is populated with Products|P1 and Amazon|P1 keys (non-empty hashes)', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, META)
    const parsed = await parseWorkbook(bytes)

    expect(parsed.meta.fingerprints).toBeDefined()
    const fps = parsed.meta.fingerprints!
    // Products sheet fingerprint for P1 must be a non-empty hex string
    expect(typeof fps['Products|P1']).toBe('string')
    expect(fps['Products|P1'].length).toBeGreaterThan(0)
    // Amazon sheet fingerprint for P1 must be a non-empty hex string
    expect(typeof fps['Amazon|P1']).toBe('string')
    expect(fps['Amazon|P1'].length).toBeGreaterThan(0)
  })
})

// ── Suite 2: Cell-level mutation cases ────────────────────────────────────────

describe('parseWorkbook — normalizeCell mutation cases', () => {
  it('numeric EAN cell → warning + digit-string value', async () => {
    // EAN 8054323310123 stored as a raw number (lost leading zero, > 1e11 → warning fires)
    const rawNum = 8054323310123 // 8.054e12, > 1e11
    const bytes = await buildHandCraftedWorkbook(['EAN'], [rawNum])
    const parsed = await parseWorkbook(bytes)

    const cell = parsed.sheets['Products']!.rows[0]!.cells['EAN']!
    expect(cell.warning).toBe('numeric coercion — verify identifier')
    // value should be the JS string representation of the number
    expect(cell.value).toBe(String(rawNum))
    // digits only (no 'e', no '-')
    expect(cell.value).toMatch(/^\d+$/)
  })

  it('Date cell → ISO YYYY-MM-DD value + date-coercion warning', async () => {
    const rawDate = new Date('2026-07-05T12:00:00Z')
    const bytes = await buildHandCraftedWorkbook(['CreatedAt'], [rawDate])
    const parsed = await parseWorkbook(bytes)

    const cell = parsed.sheets['Products']!.rows[0]!.cells['CreatedAt']!
    expect(cell.warning).toBe('date coercion')
    // value must be a 10-char ISO date string
    expect(cell.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('__CLEAR__ cell → value === "__CLEAR__" with no warning', async () => {
    const bytes = await buildHandCraftedWorkbook(['price@IT'], ['__CLEAR__'])
    const parsed = await parseWorkbook(bytes)

    const cell = parsed.sheets['Products']!.rows[0]!.cells['price@IT']!
    expect(cell.value).toBe('__CLEAR__')
    expect(cell.warning).toBeUndefined()
  })

  it('blank (null) cell → value === ""', async () => {
    // Use two columns: 'sku' has a value (anchors the row in xlsx), 'blankField' is null.
    // A row with ALL null cells is often stripped during serialisation; the anchor ensures
    // the row survives the xlsx round-trip so we can assert the blank-cell behaviour.
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Products')
    ws.getRow(1).getCell(1).value = 'sku'
    ws.getRow(1).getCell(2).value = 'blankField'
    ws.getRow(2).getCell(1).value = 'P1'  // anchor — ensures row 2 survives
    // Cell (2,2) intentionally not set → null
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer())

    const parsed = await parseWorkbook(bytes)
    const row = parsed.sheets['Products']?.rows[0]
    expect(row).toBeDefined()
    const cells = row!.cells
    // The cells map MUST contain the key for 'blankField' (header was defined in row 1)
    expect('blankField' in cells).toBe(true)
    const cell = cells['blankField']
    expect(cell!.value).toBe('')
    expect(cell!.warning).toBeUndefined()
  })

  it('string with trailing spaces → trimmed value', async () => {
    const bytes = await buildHandCraftedWorkbook(['title'], ['hello   '])
    const parsed = await parseWorkbook(bytes)

    const cell = parsed.sheets['Products']!.rows[0]!.cells['title']!
    expect(cell.value).toBe('hello')
    expect(cell.warning).toBeUndefined()
  })

  it('boolean cell → "true" or "false" string', async () => {
    const bytes = await buildHandCraftedWorkbook(['active', 'inactive'], [true, false])
    const parsed = await parseWorkbook(bytes)

    const row = parsed.sheets['Products']!.rows[0]!
    expect(row.cells['active']!.value).toBe('true')
    expect(row.cells['inactive']!.value).toBe('false')
  })

  it('BOM-prefixed string → BOM stripped', async () => {
    const bytes = await buildHandCraftedWorkbook(['title'], ['﻿hello'])
    const parsed = await parseWorkbook(bytes)

    const cell = parsed.sheets['Products']!.rows[0]!.cells['title']!
    expect(cell.value).toBe('hello')
    expect(cell.warning).toBeUndefined()
  })

  it('curly-quote string → normalised to straight quotes', async () => {
    const bytes = await buildHandCraftedWorkbook(['title'], ['‘hello’'])
    const parsed = await parseWorkbook(bytes)

    const cell = parsed.sheets['Products']!.rows[0]!.cells['title']!
    expect(cell.value).toBe("'hello'")
    expect(cell.warning).toBeUndefined()
  })

  it('leading apostrophe is preserved (not stripped)', async () => {
    const bytes = await buildHandCraftedWorkbook(['title'], ["'O sole mio"])
    const parsed = await parseWorkbook(bytes)

    const cell = parsed.sheets['Products']!.rows[0]!.cells['title']!
    expect(cell.value).toBe("'O sole mio")
    expect(cell.warning).toBeUndefined()
  })

  it('formula cell → value is string result + warning contains "formula"', async () => {
    const bytes = await buildHandCraftedWorkbook(['calc'], [{ formula: '=1+1', result: 2 }])
    const parsed = await parseWorkbook(bytes)

    const cell = parsed.sheets['Products']!.rows[0]!.cells['calc']!
    expect(cell.value).toBe('2')
    expect(cell.warning).toContain('formula')
  })

  it('rich-text cell → joined plain text value', async () => {
    const bytes = await buildHandCraftedWorkbook(['desc'], [{ richText: [{ text: 'Hel' }, { text: 'lo' }] }])
    const parsed = await parseWorkbook(bytes)

    const cell = parsed.sheets['Products']!.rows[0]!.cells['desc']!
    expect(cell.value).toBe('Hello')
  })
})
