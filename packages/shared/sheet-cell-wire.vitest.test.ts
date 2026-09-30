import { describe, expect, it } from 'vitest'
import { decodeSheetCells, encodeSheetCells, SHEET_CELL_ENCODING } from './sheet-cell-wire'

/** What the browser receives: JSON on the wire. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value))

/** A channel cell as the sheet read builds it (studio-sheet.service.ts), with synthetic ids. */
function cell(row: number, column: number, overrides: Record<string, unknown> = {}) {
  return {
    value: row % 3 ? `value ${row}-${column}` : null,
    source: row % 2 ? 'channelExplicit' : 'inherited',
    inheritedFrom: row % 2 ? null : 'parent-1',
    inherited: row % 2 === 0,
    mapped: {
      value: row % 3 ? `value ${row}-${column}` : null, derived: false,
      sourceOwner: { kind: 'listing', label: 'Listing settings', path: `listing.platformAttributes.field_${column}` },
      status: 'mapped', provenance: 'override', sourcePath: null, fallbackPath: null, usesExpression: false, legacySource: 'source',
      appliedTransforms: [], warnings: row === 4 ? [{ code: 'off_list', message: 'Not on the channel list' }] : [], errors: [], mappingErrors: [],
      autoCorrected: null, requiredByRule: column === 0, overLimit: null,
    },
    layer: 'channel', pinned: row % 2 === 1, follows: false, editable: true, linkGroupId: null,
    writeField: `attr_field_${column}`, writeVerb: 'channel', writeTarget: 'channelListing', affectsAllChannels: false,
    writable: true, writeBlockedReason: null, formula: undefined,
    contentAddress: { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-1' } },
    ...overrides,
  }
}

function sheet(rows: number, columns: number) {
  return {
    scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT' },
    columns: Array.from({ length: columns }, (_, c) => ({ key: `field_${c}`, label: `Field ${c}` })),
    meta: { tookMs: 12, schemaMissing: [], schemaAge: [] },
    rows: Array.from({ length: rows }, (_, r) => ({
      id: `product-${r}`, sku: `SKU-${r}`, parentId: r ? 'product-0' : null, isParent: r === 0, version: 1 + (r % 4),
      updatedAt: new Date(Date.UTC(2026, 8, 30, 10, r)),
      completeness: { overall: { filled: 10 + r, total: 40, pct: 25 }, required: { filled: 3, total: 5, missing: [{ key: 'brand', label: 'Brand' }, { key: 'mpn', label: 'MPN' }] } },
      listing: r % 5 ? { id: `listing-${r}`, version: 7, status: 'ACTIVE' } : null,
      values: Object.fromEntries(Array.from({ length: columns }, (_, c) => [`field_${c}`, cell(r, c)])),
    })),
  }
}

describe('the sheet read, once per column', () => {
  it('decodes to exactly what JSON would have carried, for every cell and row', () => {
    const original = sheet(21, 12)
    // The awkward shapes: a column only some rows have, a cell that is not an object, a key only one cell has, a cell
    // missing a key its column shares, a Date and a value with its own JSON form, and a real key named like the marker.
    original.rows[3].values.sparse = cell(3, 99) as never
    ;(original.rows[5].values as Record<string, unknown>).field_1 = 'plain text'
    ;(original.rows[6].values as Record<string, unknown>).field_2 = null
    ;(original.rows[7].values.field_3 as Record<string, unknown>).divergence = { publishesAs: 'Rosso', note: 'differs' }
    delete (original.rows[8].values.field_4 as Record<string, unknown>).linkGroupId
    ;(original.rows[9].values.field_5 as Record<string, unknown>).value = { toJSON: () => '12.50' }
    ;(original.rows[10].values.field_6 as Record<string, unknown>)['~'] = 'a real key'
    ;(original.rows[11].values.field_7 as Record<string, unknown>).mapped = { '~': { v: 'looks like a marker' } }
    ;(original.rows[12] as Record<string, unknown>)['~'] = { u: ['sku'] }
    const encoded = wire(encodeSheetCells(original))
    expect(encoded.meta.cellEncoding).toBe(SHEET_CELL_ENCODING)
    expect(decodeSheetCells(encoded)).toEqual(wire(original))
  })

  it('keeps every object\'s key order, so the decoded JSON is the same text', () => {
    const original = sheet(8, 3) as ReturnType<typeof sheet> & { rows: Array<Record<string, unknown>> }
    // A reader shows a row's axis values in their order (measured: "Giallo · 3XL" came back as "3XL · Giallo").
    for (const [i, row] of original.rows.entries()) row.axisValues = i === 5 ? { Taglia: '3XL', Colore: 'Giallo' } : { Colore: 'Rosso', Taglia: 'M' }
    const cell = original.rows[2].values.field_1 as Record<string, unknown>
    original.rows[2].values.field_1 = Object.fromEntries(Object.entries(cell).reverse()) as never
    const { values, ...rest } = original.rows[3]
    original.rows[3] = { values, ...rest }
    const decoded = decodeSheetCells(wire(encodeSheetCells(original)))
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(original))
    expect(Object.values(decoded.rows[5].axisValues as object)).toEqual(['3XL', 'Giallo'])
  })

  it('sends a column\'s shared cell once, and per cell only what differs (≤ 200 bytes a cell)', () => {
    const original = sheet(40, 30)
    const cells = 40 * 30
    const full = JSON.stringify(original).length
    const compact = JSON.stringify(encodeSheetCells(original)).length
    expect(full / cells).toBeGreaterThan(700)
    expect(compact / cells).toBeLessThanOrEqual(200)
    const encoded = wire(encodeSheetCells(original))
    // contentAddress is the same for the whole column: it is in the base and in no cell.
    expect(encoded.cellBase.field_0.contentAddress).toEqual({ tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-1' } })
    expect(encoded.rows.every(row => !JSON.stringify(row.values).includes('contentAddress'))).toBe(true)
  })

  it('gives every decoded cell its own objects, as JSON.parse would', () => {
    const decoded = decodeSheetCells(wire(encodeSheetCells(sheet(4, 2))))
    const [a, b] = [decoded.rows[1].values.field_0, decoded.rows[3].values.field_0] as Array<ReturnType<typeof cell>>
    a.contentAddress.coordinate.market = 'DE'
    a.mapped.appliedTransforms.push('changed' as never)
    expect(b.contentAddress.coordinate.market).toBe('IT')
    expect(b.mapped.appliedTransforms).toEqual([])
  })

  it('passes a sheet that was not encoded through unchanged', () => {
    const plain = wire(sheet(3, 2))
    expect(decodeSheetCells(plain)).toBe(plain)
    expect(decodeSheetCells(null)).toBeNull()
  })
})
