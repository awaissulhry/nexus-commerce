/**
 * MS.2 — the master sheet's per-row pure work: does this column apply to this row, what does each
 * coordinate say about it, and how complete is the row.
 *
 * The defects these guard against are all the same kind: a readiness pill that is confidently WRONG.
 * A green row that Amazon refuses, a red row that was never going to be listed, a parent flagged for
 * a size it cannot have — each one teaches the operator to stop trusting the column.
 */
import { describe, it, expect } from 'vitest'
import {
  columnApplies,
  completenessFor,
  computeReadiness,
  decimalToNumber,
  coordKey,
} from '../pim/sheet-rows.service.js'
import type { SheetColumn, SheetCoordinate } from '../pim/sheet-columns.service.js'
import type { SheetCellValue, SheetListing } from '../pim/sheet-rows.service.js'

const AMAZON_IT: SheetCoordinate = { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true }

const col = (over: Partial<SheetColumn> & Pick<SheetColumn, 'key'>): SheetColumn => ({
  writeField: over.writeField ?? `attr_${over.key}`,
  label: over.label ?? over.key,
  group: 'Attributes',
  kind: 'text',
  storage: 'categoryAttributes',
  scope: 'global',
  requiredBy: [],
  editable: true,
  ...over,
})

const val = (value: unknown, over: Partial<SheetCellValue> = {}): SheetCellValue => ({
  value, source: 'master', inheritedFrom: null, inherited: false, ...over,
})

const listing = (over: Partial<SheetListing> = {}): SheetListing => ({
  id: 'l1', listingStatus: 'ACTIVE', isPublished: true, price: 99, quantity: 5,
  externalListingId: 'B012345678', follows: {}, ...over,
})

const CHILD = { isParent: false, productType: 'COAT' }
const PARENT = { isParent: true, productType: 'COAT' }

describe('decimalToNumber', () => {
  it('reads a Prisma Decimal without turning a real price into a silent zero', () => {
    // The trap: `typeof v === 'number' ? v : 0` prints €0.00 for every price in the sheet.
    expect(decimalToNumber({ toNumber: () => 149.5 })).toBe(149.5)
    expect(decimalToNumber('149.50')).toBe(149.5)
    expect(decimalToNumber(149.5)).toBe(149.5)
  })

  it('keeps a real zero distinct from an absent price', () => {
    expect(decimalToNumber(0)).toBe(0)
    expect(decimalToNumber(null)).toBeNull()
    expect(decimalToNumber(undefined)).toBeNull()
    expect(decimalToNumber('not a number')).toBeNull()
  })
})

describe('columnApplies', () => {
  it('locks a per-variant column on a parent instead of flagging it', () => {
    expect(columnApplies(col({ key: 'size', scope: 'per_variant' }), PARENT)).toBe(false)
    expect(columnApplies(col({ key: 'size', scope: 'per_variant' }), CHILD)).toBe(true)
  })

  it('skips a column that belongs to a different product type', () => {
    const c = col({ key: 'heel_height', applicableProductTypes: ['SHOES'] })
    expect(columnApplies(c, CHILD)).toBe(false)
    expect(columnApplies(c, { isParent: false, productType: 'SHOES' })).toBe(true)
  })

  it('applies a column with no product-type restriction to every row', () => {
    expect(columnApplies(col({ key: 'material' }), CHILD)).toBe(true)
    expect(columnApplies(col({ key: 'material' }), { isParent: false, productType: null })).toBe(true)
  })
})

describe('computeReadiness', () => {
  it('reports a missing required field as an ERROR naming the channel', () => {
    const r = computeReadiness({
      columns: [col({ key: 'brand', requiredBy: ['Amazon · IT'] })],
      values: {},
      row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.state).toBe('errors')
    expect(r.issues[0]).toMatchObject({ key: 'brand', severity: 'error' })
    expect(r.issues[0].message).toContain('Amazon · IT')
  })

  it('does not demand a per-variant field from a parent row', () => {
    // The defect: every parent permanently red for a missing EAN it can never have.
    const r = computeReadiness({
      columns: [col({ key: 'ean', scope: 'per_variant', requiredBy: ['Amazon · IT'] })],
      values: {}, row: PARENT, coordinate: AMAZON_IT, listing: listing(),
    })
    expect(r.issues).toEqual([])
    expect(r.state).toBe('live')
  })

  it('does not demand a field required only for another product type', () => {
    const r = computeReadiness({
      columns: [col({ key: 'heel_height', requiredBy: ['Amazon · IT'], requiredForProductTypes: ['SHOES'] })],
      values: {}, row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.issues).toEqual([])
  })

  it('WARNS on an off-list value and never turns it into an error', () => {
    // Warn-never-block: the operator may know something the cached schema does not.
    const r = computeReadiness({
      columns: [col({ key: 'gender', mode: 'strict', options: ['male', 'female'] })],
      values: { gender: val('unisex') },
      row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].severity).toBe('warn')
    expect(r.state).not.toBe('errors')
  })

  it('accepts an off-list value on an open list without a word', () => {
    const r = computeReadiness({
      columns: [col({ key: 'season', mode: 'open', options: ['Summer'] })],
      values: { season: val('Mid-season') },
      row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.issues).toEqual([])
  })

  it('matches an enum case-insensitively so a correct value is not flagged', () => {
    const r = computeReadiness({
      columns: [col({ key: 'gender', mode: 'strict', options: ['Male', 'Female'] })],
      values: { gender: val('male') },
      row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.issues).toEqual([])
  })

  it('counts BYTES, not characters, where the channel does', () => {
    // 40 accented Italian characters are 80 bytes: inside a 60-char cap, over a 60-byte one.
    const accented = 'à'.repeat(40)
    const r = computeReadiness({
      columns: [col({ key: 'title', maxLength: 60, maxBytes: 60, capFrom: 'Amazon · IT' })],
      values: { title: val(accented) },
      row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.state).toBe('errors')
    expect(r.issues[0].message).toContain('bytes')
  })

  it('reports a character overrun when there is no byte cap', () => {
    const r = computeReadiness({
      columns: [col({ key: 'title', maxLength: 10 })],
      values: { title: val('12345678901') },
      row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.state).toBe('errors')
    expect(r.issues[0].message).toContain('characters')
  })

  it('leaves a value inside its cap alone', () => {
    const r = computeReadiness({
      columns: [col({ key: 'title', maxLength: 80, maxBytes: 80 })],
      values: { title: val('XAVIA GALE Giacca') },
      row: CHILD, coordinate: AMAZON_IT, listing: listing({ externalListingId: null, isPublished: false }),
    })
    expect(r.issues).toEqual([])
    expect(r.state).toBe('ready')
  })

  it('separates "never listed" from "listed and fine"', () => {
    // The defect: showing Ready for a row the channel has never seen, so nobody publishes it.
    const columns = [col({ key: 'brand' })]
    const values = { brand: val('XAVIA') }
    expect(computeReadiness({ columns, values, row: CHILD, coordinate: AMAZON_IT, listing: null }).state).toBe('unlisted')
    expect(computeReadiness({ columns, values, row: CHILD, coordinate: AMAZON_IT, listing: listing() }).state).toBe('live')
  })

  it('carries the channel id so the cell can show Live · <ref>', () => {
    const r = computeReadiness({
      columns: [], values: {}, row: CHILD, coordinate: AMAZON_IT, listing: listing({ externalListingId: 'B0ABCDEFGH' }),
    })
    expect(r.ref).toBe('B0ABCDEFGH')
  })

  it('keeps a live listing live when the only issue is a warning', () => {
    const r = computeReadiness({
      columns: [col({ key: 'gender', mode: 'strict', options: ['male'] })],
      values: { gender: val('unisex') },
      row: CHILD, coordinate: AMAZON_IT, listing: listing(),
    })
    expect(r.state).toBe('live')
    expect(r.issues).toHaveLength(1)
  })

  it('errors beat live — a listing that would now be refused is not reported as fine', () => {
    const r = computeReadiness({
      columns: [col({ key: 'brand', requiredBy: ['Amazon · IT'] })],
      values: {}, row: CHILD, coordinate: AMAZON_IT, listing: listing(),
    })
    expect(r.state).toBe('errors')
  })

  it('treats an empty string and an empty array as missing, not as filled', () => {
    const columns = [col({ key: 'brand', requiredBy: ['Amazon · IT'] }), col({ key: 'bullets', requiredBy: ['Amazon · IT'] })]
    const r = computeReadiness({
      columns, values: { brand: val(''), bullets: val([]) },
      row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.issues.map((i) => i.key).sort()).toEqual(['brand', 'bullets'])
  })

  it('warns on a value the channel still offers but has deprecated', () => {
    const r = computeReadiness({
      columns: [col({ key: 'variation_theme', options: ['SIZE'], deprecatedOptions: ['SIZE-COLOR'] })],
      values: { variation_theme: val('SIZE-COLOR') },
      row: CHILD, coordinate: AMAZON_IT, listing: null,
    })
    expect(r.issues[0].severity).toBe('warn')
    expect(r.issues[0].message).toContain('deprecated')
  })
})

describe('completenessFor', () => {
  it('scores only the columns that apply to the row', () => {
    // A parent scored against per-variant columns can never reach 100% and the number is meaningless.
    const columns = [col({ key: 'material' }), col({ key: 'size', scope: 'per_variant' })]
    const c = completenessFor(columns, PARENT, { material: val('Leather') })
    expect(c.overall).toMatchObject({ filled: 1, total: 1, pct: 100 })
  })

  it('counts a variation against both its own and its inherited columns', () => {
    const columns = [col({ key: 'material' }), col({ key: 'size', scope: 'per_variant' })]
    const c = completenessFor(columns, CHILD, { material: val('Leather', { inherited: true }) })
    expect(c.overall).toMatchObject({ filled: 1, total: 2, pct: 50 })
  })

  it('names what is missing and required, so the number is actionable', () => {
    const columns = [col({ key: 'brand', label: 'Brand', requiredBy: ['Amazon · IT'] })]
    const c = completenessFor(columns, CHILD, {})
    expect(c.required.missing).toEqual([{ key: 'brand', label: 'Brand' }])
  })
})

describe('coordKey', () => {
  it('keys a listing by channel AND marketplace, so IT and DE never collide', () => {
    expect(coordKey({ channel: 'AMAZON', marketplace: 'IT' })).toBe('AMAZON:IT')
    expect(coordKey({ channel: 'AMAZON', marketplace: 'DE' })).not.toBe(coordKey({ channel: 'AMAZON', marketplace: 'IT' }))
  })
})
