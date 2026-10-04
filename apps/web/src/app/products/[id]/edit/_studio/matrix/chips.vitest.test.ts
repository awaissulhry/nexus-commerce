import { describe, expect, it } from 'vitest'

import { matrixChip, matrixChips, MATRIX_CHIP_IDS } from './chips'
import type { MatrixRead } from './contract'
import { buildPreviewMatrix } from './fixtures'
import { applyCells, applyVerb } from './store'
import { previewVerb } from './preview'

const ROWS = [
  { id: 'p', sku: 'GALE-JACKET', isParent: true, basePrice: 105, status: 'ACTIVE' },
  ...['XS', 'XXS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'].flatMap(s => ['BLACK', 'YELLOW'].map(c => ({ id: `${c}-${s}`, sku: `GALE-JACKET-${c}-MEN-${s}`, isParent: false, basePrice: 105, status: 'ACTIVE' }))),
]
const COORDS = [
  { channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', connected: true, accountId: 'acc-a' },
  { channel: 'AMAZON', market: 'DE', label: 'Amazon · DE', connected: true, accountId: 'acc-a' },
  { channel: 'EBAY', market: 'IT', label: 'eBay · IT', connected: true, accountId: 'acc-e' },
  { channel: 'SHOPIFY', market: 'GLOBAL', label: 'Shopify', connected: true, accountId: 'acc-s' },
]
const read = (): MatrixRead => buildPreviewMatrix('prod', ROWS, COORDS)

describe('matrixChips — counts from the read, null before it, cells keyed <key>.<kind>', () => {
  it('🔴 count is null (never 0) while there is no read, and every chip is still offered', () => {
    const chips = matrixChips(null)
    expect(chips.map(c => c.id)).toEqual(MATRIX_CHIP_IDS)
    for (const c of chips) { expect(c.count).toBeNull(); expect(c.hideWhenZero).toBe(false); expect(c.cells.byRow).toEqual({}) }
  })
  it('counts ROWS, not cells: a variant pinned on two coordinates is one variant', () => {
    const r = read()
    const chips = matrixChips(r)
    const pinned = chips.find(c => c.id === 'matrix-pinned')!
    const expected = r.rows.filter(row => Object.values(row.cells).some(c => c.sync?.kind === 'PINNED' || (c.sync?.kind === 'PAUSED' && c.sync.mode === 'PINNED'))).length
    expect(pinned.count).toEqual({ n: expected, unit: 'variants' })
    expect(Object.keys(pinned.cells.byRow).length).toBe(expected)
    /* Positive control: the fixture has at least one pinned row, or this test measures nothing. */
    expect(expected).toBeGreaterThan(0)
  })
  it('keys every tinted cell as <coordinateKey>.<kind> and names only the cells that earned the row its place', () => {
    const chips = matrixChips(read())
    for (const chip of chips) for (const [, cols] of Object.entries(chip.cells.byRow)) for (const col of cols) {
      expect(col).toMatch(/^[A-Z]+:[A-Z]+(#[\w-]+)?\.(listing|syncMode|syncQty|syncBuffer|syncState)$/)
    }
    const paused = chips.find(c => c.id === 'matrix-paused')!
    const anyRow = Object.values(paused.cells.byRow)[0]
    expect(anyRow?.some(c => c.endsWith('.syncMode'))).toBe(true)
    const issues = chips.find(c => c.id === 'matrix-sync-issues')!
    for (const cols of Object.values(issues.cells.byRow)) for (const col of cols) expect(col.endsWith('.syncState')).toBe(true)
  })
  it('narrows to the coordinates on screen when a visible set is given (the scope-bar filter)', () => {
    const r = read()
    const all = matrixChips(r).find(c => c.id === 'matrix-paused')!
    const shopify = matrixChips(r, new Set(['SHOPIFY:GLOBAL'])).find(c => c.id === 'matrix-paused')!
    /* Every Shopify preview row is paused (fixtures: non-Amazon/eBay channels), so Shopify alone is the variant count… */
    expect(shopify.count).toEqual({ n: r.rows.filter(row => row.cells['SHOPIFY:GLOBAL']?.sync?.kind === 'PAUSED').length, unit: 'variants' })
    /* …and every tinted cell is on that coordinate. */
    for (const cols of Object.values(shopify.cells.byRow)) for (const col of cols) expect(col.startsWith('SHOPIFY:GLOBAL.')).toBe(true)
    expect(all.count!.n).toBeGreaterThanOrEqual(shopify.count!.n)
    /* Positive control: an empty visible set counts nothing. */
    expect(matrixChips(r, new Set()).every(c => c.count?.n === 0 && c.count.unit === 'variants')).toBe(true)
  })
  it('moves with the store: a Pinned write on a Follow row raises the Pinned count by one', () => {
    const r = read()
    const before = matrixChips(r).find(c => c.id === 'matrix-pinned')!.count!.n
    const row = r.rows.find(x => x.role === 'variant' && x.cells['EBAY:IT']?.sync?.kind === 'FOLLOW' && x.cells['EBAY:IT'].writable.syncQty)!
    const { read: after } = applyCells(r, [{ rowId: row.id, coordinateKey: 'EBAY:IT', cell: 'syncQty', value: 7, expectedVersion: row.cells['EBAY:IT']!.version }])
    const wasPinnedElsewhere = Object.entries(row.cells).some(([k, c]) => k !== 'EBAY:IT' && c.sync?.kind === 'PINNED')
    expect(matrixChips(after).find(c => c.id === 'matrix-pinned')!.count).toEqual({ n: before + (wasPinnedElsewhere ? 0 : 1), unit: 'variants' })
  })
  it('Sync held follows a hold verb: holding one Follow row on eBay·IT adds it to the chip', () => {
    const r = read()
    const row = r.rows.find(x => x.role === 'variant' && x.cells['EBAY:IT']?.sync?.kind === 'FOLLOW')!
    const preview = previewVerb(r, { params: { verb: 'pause-sync' }, targets: [{ rowId: row.id, coordinateKey: 'EBAY:IT' }], commit: false }, { can: () => true, simulated: true })
    expect(preview.changes.length).toBe(1)
    const { read: after } = applyVerb(r, preview)
    const paused = matrixChips(after).find(c => c.id === 'matrix-paused')!
    expect(paused.cells.byRow[row.id]).toContain('EBAY:IT.syncMode')
  })
})

describe('build shape v2 (P12) — Sync held, Inactive, chips by id', () => {
  it('the held-sync chip reads "Sync held" and keeps its id (saved views)', () => {
    const held = matrixChip(matrixChips(read()), 'matrix-paused')!
    expect(held.label).toBe('Sync held')
    expect(held.tone).toBe('warning')
  })
  it('Inactive counts the rows whose listing is Inactive, Mixed or Ended — tinting the Listing cell only', () => {
    const r = read()
    const rows = r.rows.filter(x => x.role === 'variant')
    const states = ['paused', 'mixed', 'ended', 'active', 'draft', 'not_listed'] as const
    rows.slice(0, states.length).forEach((row, i) => {
      const listing = row.cells['EBAY:IT']?.listing
      if (listing) listing.selling = { state: states[i], reason: null }
    })
    const expected = r.rows.filter(row => Object.values(row.cells).some(c => {
      const l = c.listing
      if (!l) return false
      const s = l.selling?.state
      return s && s !== 'unknown' && s !== 'not_listed' ? ['paused', 'mixed', 'ended'].includes(s) : l.state === 'closed' || l.state === 'ended'
    })).length
    const chip = matrixChip(matrixChips(r), 'matrix-not-selling')!
    /* One set of selling words (Owner 2026-10-04): the chip reads Inactive; its id stays for saved views. */
    expect(chip).toMatchObject({ label: 'Inactive', tone: 'warning', count: { n: expected, unit: 'variants' } })
    expect(chip.note).toBe('Listings that are Inactive, Mixed or Ended — set Active in the sheet\'s Status column and Publish')
    /* Positive control: the three we set are on it; the Active, draft and Not listed rows only when another coordinate puts them there. */
    for (const row of rows.slice(0, 3)) expect(chip.cells.byRow[row.id]).toContain('EBAY:IT.listing')
    for (const cols of Object.values(chip.cells.byRow)) for (const col of cols) expect(col.endsWith('.listing')).toBe(true)
    expect(expected).toBeGreaterThanOrEqual(3)
  })
  it('matrixChip finds a chip by id whatever its place, and answers null for none', () => {
    const chips = matrixChips(read())
    for (const id of MATRIX_CHIP_IDS) expect(matrixChip([...chips].reverse(), id)?.id).toBe(id)
    expect(matrixChip([], 'matrix-not-selling')).toBeNull()
  })
})
