/**
 * FF1.7 — Deterministic workbook generator tests (TDD — written before implementation).
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { generateWorkbook } from '../workbook-generator'
import { rowFingerprint } from '../fingerprint'
import type { WorkbookModel, FieldDefinition } from '../registry/types'
import type { WorkbookData } from '../fetch'

// ── Fixture field definitions ─────────────────────────────────────────────────

const SKU_FIELD: FieldDefinition = {
  id: 'sku', label: 'SKU', kind: 'text', cls: 'IDENTITY', scope: 'SHARED',
  source: { model: 'Product', column: 'sku' }, forcedText: true, width: 22,
}
const PARENT_SKU_FIELD: FieldDefinition = {
  id: 'parent_sku', label: 'Parent SKU', kind: 'text', cls: 'IDENTITY', scope: 'SHARED',
  source: { model: 'Product', column: 'parentId' }, forcedText: true, width: 18,
}
const EAN_FIELD: FieldDefinition = {
  id: 'ean', label: 'EAN', kind: 'text', cls: 'IDENTITY', scope: 'SHARED',
  source: { model: 'Product', column: 'ean' }, forcedText: true, width: 16,
}
const PRICE_FIELD: FieldDefinition = {
  id: 'price', label: 'Price', kind: 'decimal', cls: 'EDITABLE', scope: 'MARKET_SCOPED',
  source: { model: 'ChannelListing', column: 'price' }, decimals: 2, width: 11,
  followMaster: {
    followColumn: 'followMasterPrice',
    overrideColumn: 'priceOverride',
    masterCacheColumn: 'masterPrice',
  },
}

// ── Fixture model & data ──────────────────────────────────────────────────────

const model: WorkbookModel = {
  markets: { AMAZON: ['IT', 'DE'], EBAY: [], SHOPIFY: [] },
  sheets: [
    {
      name: 'Products',
      sharedFields: [SKU_FIELD, PARENT_SKU_FIELD, EAN_FIELD],
      marketFields: [],
    },
    {
      name: 'Amazon',
      channel: 'AMAZON',
      sharedFields: [],
      marketFields: [PRICE_FIELD],
    },
  ],
}

const data: WorkbookData = {
  products: [
    { sku: 'PARENT-001', parent_sku: '' },
    { sku: 'CHILD-001', parent_sku: 'PARENT-001', ean: '08054323310123' },
  ],
  listings: {
    AMAZON: [
      {
        sku: 'CHILD-001',
        marketplace: 'IT',
        price: 189.9,
        followMasterPrice: true,
        masterPrice: 189.9,
        priceOverride: null,
      },
    ],
    EBAY: [],
    SHOPIFY: [],
  },
}

const META = { snapshotId: 'test-snap-001', exportedAt: '2026-07-05' }

// ── Helper: build a column-name → colNo map from a sheet's header row ─────────

function headerMap(ws: ExcelJS.Worksheet): Record<string, number> {
  const map: Record<string, number> = {}
  ws.getRow(1).eachCell((cell, colNo) => {
    if (cell.value != null && cell.value !== '') {
      map[String(cell.value)] = colNo
    }
  })
  return map
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('generateWorkbook', () => {
  it('produces README / Products / Amazon / _meta sheets; _meta is veryHidden', async () => {
    const bytes = await generateWorkbook(model, data, META)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes))

    const names = wb.worksheets.map(w => w.name)
    expect(names).toEqual(expect.arrayContaining(['README', 'Products', 'Amazon', '_meta']))

    expect(wb.getWorksheet('_meta')!.state).toBe('veryHidden')
  })

  it('Amazon sheet header row contains price@IT and price_follows_master@IT', async () => {
    const bytes = await generateWorkbook(model, data, META)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes))

    const A = wb.getWorksheet('Amazon')!
    const h = headerMap(A)

    expect(h['price@IT']).toBeDefined()
    expect(h['price_follows_master@IT']).toBeDefined()
  })

  it('EAN with leading zero is preserved as text (value string, numFmt @)', async () => {
    const bytes = await generateWorkbook(model, data, META)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes))

    const P = wb.getWorksheet('Products')!

    // Find EAN column number from header row (header is now the field id 'ean', not the label)
    let eanColNo = -1
    P.getRow(1).eachCell((cell, colNo) => {
      if (String(cell.value) === 'ean') eanColNo = colNo
    })
    expect(eanColNo).toBeGreaterThan(0)

    // CHILD-001 is sorted to row 3 (PARENT-001 comes first as parent)
    const eanCell = P.getRow(3).getCell(eanColNo)
    expect(eanCell.value).toBe('08054323310123')
    expect(eanCell.numFmt).toBe('@')
  })

  it('price_follows_master@IT cell contains "true" for the child listing that follows master', async () => {
    const bytes = await generateWorkbook(model, data, META)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes))

    const A = wb.getWorksheet('Amazon')!
    const h = headerMap(A)
    const fmColNo = h['price_follows_master@IT']
    expect(fmColNo).toBeDefined()

    // CHILD-001 is the only row (row 2, after header)
    const cell = A.getRow(2).getCell(fmColNo)
    expect(String(cell.value)).toBe('true')
  })

  it('_meta sheet contains snapshotId and a Products fingerprint row', async () => {
    const bytes = await generateWorkbook(model, data, META)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes))

    const meta = wb.getWorksheet('_meta')!
    const keys: string[] = []
    meta.eachRow(row => { keys.push(String(row.getCell(1).value ?? '')) })

    expect(keys).toContain('snapshotId')
    expect(keys.some(k => k.startsWith('Products|'))).toBe(true)
    expect(keys.some(k => k.startsWith('Amazon|'))).toBe(true)
  })
})

describe('no duplicate column keys in channel sheet header', () => {
  it('Amazon header has no duplicate column keys when using governed fields across 2+ markets', async () => {
    // Uses the existing fixture model which has AMAZON markets [IT, DE] and a governed price field.
    // buildChannelSheet auto-emits price_follows_master@IT and price_follows_master@DE;
    // C1 fix ensures those are NOT also emitted from explicit registry entries.
    const bytes = await generateWorkbook(model, data, META)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes))

    const A = wb.getWorksheet('Amazon')!
    const headers: string[] = []
    A.getRow(1).eachCell((cell) => {
      if (cell.value != null && cell.value !== '') {
        headers.push(String(cell.value))
      }
    })

    // Every header value must be unique — no duplicate column keys
    expect(headers.length).toBeGreaterThan(0)
    expect(new Set(headers).size).toBe(headers.length)
  })
})

describe('rowFingerprint', () => {
  it('is stable regardless of key insertion order', () => {
    expect(rowFingerprint('S', 'MASTER', { a: 1, b: 2 }))
      .toBe(rowFingerprint('S', 'MASTER', { b: 2, a: 1 }))
  })

  it('returns a 16-character hex string', () => {
    const fp = rowFingerprint('SKU-001', 'MASTER', { price: 189.9 })
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs for different skus', () => {
    const a = rowFingerprint('SKU-A', 'MASTER', { x: 1 })
    const b = rowFingerprint('SKU-B', 'MASTER', { x: 1 })
    expect(a).not.toBe(b)
  })
})
