import { describe, expect, it } from 'vitest'

import { INVENTORY_CELL_KINDS, MATRIX_CELL_KINDS, type MatrixRead } from './contract'
import { buildPreviewMatrix, hashOf, previewCoordinates } from './fixtures'
import { followQty, inventoryCoordinate, previewVerb } from './preview'
import { applyCells, applyVerb, revertOperation } from './store'

const ROWS = [
  { id: 'p', sku: 'GALE-JACKET', isParent: true, basePrice: 105, status: 'ACTIVE' },
  ...['XS', 'XXS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'].flatMap(s => ['BLACK', 'YELLOW'].map(c => ({ id: `${c}-${s}`, sku: `GALE-JACKET-${c}-MEN-${s}`, isParent: false, basePrice: 105, status: 'ACTIVE' }))),
]
const COORDS = [
  { channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', connected: true, accountId: 'acc-a' },
  { channel: 'AMAZON', market: 'DE', label: 'Amazon · DE', connected: true, accountId: 'acc-a' },
  { channel: 'AMAZON', market: 'UK', label: 'Amazon · UK', connected: false, accountId: null },
  { channel: 'EBAY', market: 'IT', label: 'eBay · IT', connected: true, accountId: 'acc-e' },
  { channel: 'SHOPIFY', market: 'GLOBAL', label: 'Shopify', connected: true, accountId: 'acc-s' },
]
const read = (): MatrixRead => buildPreviewMatrix('prod', ROWS, COORDS)
const ctx = { can: () => true, simulated: true }

describe('fixtures — deterministic, region-folded, honest about absence', () => {
  it('is the same picture twice', () => { expect(JSON.stringify(read())).toBe(JSON.stringify(read())); expect(hashOf('a')).toBe(hashOf('a')) })
  it('folds the Amazon EU markets onto ONE region-inventory coordinate that carries the inventory cells', () => {
    const cs = previewCoordinates(COORDS)
    const eu = cs.find(c => c.key === 'AMAZON:EU')!
    expect(eu.kind).toBe('region-inventory'); expect(eu.sharedInventoryWith).toEqual(['IT', 'DE']); expect(eu.cells).toEqual(INVENTORY_CELL_KINDS)
    const it = cs.find(c => c.key === 'AMAZON:IT')!
    expect(it.inventoryOn).toBe('AMAZON:EU'); expect(it.cells.some(k => INVENTORY_CELL_KINDS.includes(k))).toBe(false); expect(it.cells).toContain('price')
  })
  it('keeps an unconnected coordinate with NO cells so the absence is visible, and never fabricates its cells', () => {
    const r = read(); const uk = r.coordinates.find(c => c.key === 'AMAZON:UK')!
    expect(uk.connected).toBe(false); expect(uk.cells).toEqual([]); expect(r.rows[1]!.cells['AMAZON:UK']).toBeUndefined()
  })
  it('states every absent kind with a sentence', () => {
    const cs = previewCoordinates(COORDS)
    expect(cs.find(c => c.key === 'EBAY:IT')!.absent).toEqual([{ cell: 'salePrice', reason: expect.stringContaining('promotions') }])
    expect(cs.find(c => c.key === 'SHOPIFY:GLOBAL')!.absent).toEqual([{ cell: 'fulfilment', reason: 'Shopify has no fulfilment method' }])
  })
  it('adds exactly one preview alias, on the first eBay market, as its own coordinate', () => {
    const cs = previewCoordinates(COORDS); const aliases = cs.filter(c => c.alias)
    expect(aliases).toHaveLength(1); expect(aliases[0]!.key).toBe('EBAY:IT#preview-alias'); expect(aliases[0]!.label).toBe('eBay · IT ②')
  })
  it('an FBA row is Amazon-managed: no writable inventory cell, every refusal named', () => {
    const r = read(); const fba = r.rows.filter(x => x.role === 'variant').map(x => x.cells['AMAZON:EU']!).filter(c => c.sync?.kind === 'FBA_EXCLUDED')
    expect(fba.length).toBeGreaterThan(0)
    for (const c of fba) for (const k of ['syncMode', 'syncQty', 'syncBuffer'] as const) { expect(c.writable[k]).toBe(false); expect(c.writeBlockedReason[k]).toBe('Amazon-managed') }
  })
  it('the parent row derives the family stock and writes nothing but price', () => {
    const r = read(); const p = r.rows.find(x => x.role === 'parent')!
    expect(p.stock.available).toBe(r.rows.filter(x => x.role === 'variant').reduce((n, x) => n + (x.stock.available ?? 0), 0))
    expect(p.cells['AMAZON:EU']!.writable.syncQty).toBe(false)
  })
  it('never paints an unknown state — every listing and queue word on every cell is a member of its vocabulary (MX.P found a signed shift producing undefined)', () => {
    const r = read()
    const LISTING = new Set(['listed', 'draft', 'excluded', 'not-set-up', 'needs-value', 'suppressed', 'closed', 'error', 'ended'])
    const QUEUE = new Set(['sent', 'queued', 'sending', 'failed', 'dead', 'paused', 'never'])
    let seen = 0
    for (const row of r.rows) for (const cells of Object.values(row.cells)) {
      if (cells.listing) { expect(LISTING.has(cells.listing.state)).toBe(true); seen++ }
      if (cells.queue) { expect(QUEUE.has(cells.queue.state)).toBe(true); seen++ }
    }
    expect(seen).toBeGreaterThan(100)
  })
  it('counts listed/draft per coordinate from the rows, and the eight kinds are the contract order', () => {
    const r = read(); const it = r.coordinates.find(c => c.key === 'AMAZON:IT')!
    expect((it.listed ?? 0) + (it.draft ?? 0)).toBeLessThanOrEqual(20); expect(it.listed).not.toBeNull()
    expect(MATRIX_CELL_KINDS).toEqual(['listing', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price', 'salePrice'])
  })
})

describe('preview — every change labelled, every refusal named, inventory verbs route to the region', () => {
  const firstFbm = (r: MatrixRead) => r.rows.find(x => x.role === 'variant' && x.cells['AMAZON:EU']!.sync?.kind === 'FOLLOW')!
  it('adjust-prices computes server-side arithmetic once, labels currency, refuses a formula cell', () => {
    const r = read()
    const targets = r.rows.filter(x => x.role === 'variant').map(x => ({ rowId: x.id, coordinateKey: 'AMAZON:IT' }))
    const p = previewVerb(r, { params: { verb: 'adjust-prices', percent: -5 }, targets, commit: false }, ctx)
    const formula = r.rows.filter(x => x.role === 'variant' && x.cells['AMAZON:IT']!.price?.source === 'formula')
    expect(p.refusals.filter(x => x.kind === 'formula')).toHaveLength(formula.length)
    expect(p.changes.length + formula.length).toBe(20)
    expect(p.changes[0]!.toLabel).toBe('€99.75'); expect(p.changes[0]!.to).toBe(99.75)
    expect(p.confirm).toBe('confirm'); expect(p.notices).toContain('Preview — nothing is sent')
  })
  it('−30 % escalates to type-to-confirm; the parent row is refused as not applicable', () => {
    const r = read(); const p = previewVerb(r, { params: { verb: 'adjust-prices', percent: -30 }, targets: [{ rowId: 'p', coordinateKey: 'AMAZON:IT' }, { rowId: 'BLACK-XS', coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
    expect(p.confirm).toBe('type-to-confirm'); expect(p.refusals[0]).toMatchObject({ rowId: 'p', kind: 'not-applicable' })
  })
  it('copy-prices refuses a currency mismatch instead of converting', () => {
    const r = buildPreviewMatrix('prod', ROWS, [...COORDS, { channel: 'AMAZON', market: 'UK', label: 'Amazon · UK', connected: true, accountId: 'acc-a' }].filter((c, i, a) => a.findIndex(x => x.market === c.market && x.channel === c.channel) === i || c.connected))
    const uk = r.coordinates.find(c => c.key === 'AMAZON:UK')!; expect(uk.currency).toBe('GBP')
    const p = previewVerb(r, { params: { verb: 'copy-prices', fromCoordinateKey: 'AMAZON:IT' }, targets: [{ rowId: 'BLACK-XS', coordinateKey: 'AMAZON:UK' }], commit: false }, ctx)
    expect(p.refusals[0]?.kind).toBe('currency')
  })
  it('pin-quantity on an EU market routes to the region group and carries the EU notice; FBA rows are refused as Amazon-managed', () => {
    const r = read(); expect(inventoryCoordinate(r, 'AMAZON:DE')).toBe('AMAZON:EU')
    const targets = r.rows.filter(x => x.role === 'variant').map(x => ({ rowId: x.id, coordinateKey: 'AMAZON:DE' }))
    const p = previewVerb(r, { params: { verb: 'pin-quantity', value: 10 }, targets, commit: false }, ctx)
    expect(p.notices).toContain('Amazon EU: this covers IT DE'); expect(p.changes.every(c => c.coordinateKey === 'AMAZON:EU')).toBe(true)
    expect(p.refusals.filter(x => x.kind === 'amazon-managed').length).toBeGreaterThan(0); expect(p.confirm).toBe('none')
  })
  it('set-follow labels the resolver number; pause names the held quantity; resume of a policy pause is refused with the Sync Control pointer', () => {
    const r = read(); const row = firstFbm(r)
    const pin = applyCells(r, [{ rowId: row.id, coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 3, expectedVersion: row.cells['AMAZON:EU']!.version }]).read
    const f = previewVerb(pin, { params: { verb: 'set-follow' }, targets: [{ rowId: row.id, coordinateKey: 'AMAZON:EU' }], commit: false }, ctx)
    expect(f.changes[0]!.fromLabel).toBe('Pinned 3'); expect(f.changes[0]!.toLabel).toBe(`Follow ${followQty(row.cells['AMAZON:EU']!.sync!)}`)
    const pz = previewVerb(r, { params: { verb: 'pause-sync' }, targets: [{ rowId: row.id, coordinateKey: 'AMAZON:EU' }], commit: false }, ctx)
    expect(pz.changes[0]!.note).toMatch(/^Holds \d+ on the channel/)
    const policy = r.rows.find(x => x.role === 'variant' && x.cells['SHOPIFY:GLOBAL']?.sync?.via === 'POLICY')
    if (policy) { const rs = previewVerb(r, { params: { verb: 'resume-sync' }, targets: [{ rowId: policy.id, coordinateKey: 'SHOPIFY:GLOBAL' }], commit: false }, ctx); expect(rs.refusals[0]?.reason).toContain('Sync Control') }
  })
  it('set-follow on a PAUSED row that already follows is NOT a change (MX.F: the door would noop it)', () => {
    const r = read(); const row = r.rows.find(x => x.role === 'variant' && x.cells['AMAZON:EU']!.sync?.kind === 'FOLLOW')!
    const paused = applyVerb(r, previewVerb(r, { params: { verb: 'pause-sync' }, targets: [{ rowId: row.id, coordinateKey: 'AMAZON:EU' }], commit: false }, ctx)).read
    const p = previewVerb(paused, { params: { verb: 'set-follow' }, targets: [{ rowId: row.id, coordinateKey: 'AMAZON:EU' }], commit: false }, ctx)
    expect(p.changes).toEqual([]); expect(p.refusals).toEqual([])
  })
  it('set-fulfilment is type-to-confirm with the method as the word, and the guard refuses FBA→FBM while FBA stock is on hand', () => {
    const r = read(); const fba = r.rows.find(x => x.role === 'variant' && x.cells['AMAZON:EU']!.sync?.kind === 'FBA_EXCLUDED')!
    const p = previewVerb(r, { params: { verb: 'set-fulfilment', method: 'FBM' }, targets: [{ rowId: fba.id, coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
    expect(p.confirm).toBe('type-to-confirm'); expect(p.confirmWord).toBe('FBM'); expect(p.refusals[0]?.kind).toBe('guard')
    const q = previewVerb(r, { params: { verb: 'set-fulfilment', method: 'MCF' }, targets: [{ rowId: fba.id, coordinateKey: 'AMAZON:IT' }], commit: false }, ctx)
    expect(q.refusals[0]?.reason).toContain('not a method')
  })
  it('a missing permission refuses every price change and changes nothing', () => {
    const r = read(); const p = previewVerb(r, { params: { verb: 'set-price', value: 80 }, targets: [{ rowId: 'BLACK-XS', coordinateKey: 'AMAZON:IT' }], commit: false }, { can: () => false, simulated: true })
    expect(p.changes).toEqual([]); expect(p.refusals[0]?.kind).toBe('permission')
  })
})

describe('store — one door, CAS, typing pins, region expansion, restore by value', () => {
  it('a stale expectedVersion is a conflict carrying the CURRENT version and writes nothing', () => {
    const r = read(); const row = r.rows.find(x => x.role === 'variant' && x.cells['AMAZON:EU']!.sync?.kind === 'FOLLOW')!
    const v = row.cells['AMAZON:EU']!.version
    const out = applyCells(r, [{ rowId: row.id, coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 9, expectedVersion: v + 5 }])
    expect(out.result.results[0]).toMatchObject({ outcome: 'conflict', version: v }); expect(out.read).toBe(r)
  })
  it('typing a number into a Follow cell pins it, bumps the version, queues a push and names the EU expansion', () => {
    const r = read(); const row = r.rows.find(x => x.role === 'variant' && x.cells['AMAZON:EU']!.sync?.kind === 'FOLLOW')!
    const v = row.cells['AMAZON:EU']!.version
    const out = applyCells(r, [{ rowId: row.id, coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 9, expectedVersion: v }])
    const after = out.read.rows.find(x => x.id === row.id)!.cells['AMAZON:EU']!
    expect(out.result.results[0]).toMatchObject({ outcome: 'applied', version: v + 1, expandedTo: ['AMAZON:IT', 'AMAZON:DE'] })
    expect(after.sync).toMatchObject({ kind: 'PINNED', mode: 'PINNED', intended: 9, held: 9 }); expect(after.queue?.state).toBe('queued'); expect(after.writable.syncBuffer).toBe(false)
  })
  it('an unchanged write is a noop and does not spend a version', () => {
    const r = read(); const row = r.rows.find(x => x.role === 'variant' && x.cells['AMAZON:IT']!.price?.source === 'override' || false) ?? r.rows[1]!
    const c = row.cells['AMAZON:IT']!; const out = applyCells(r, [{ rowId: row.id, coordinateKey: 'AMAZON:IT', cell: 'price', value: c.price!.value, expectedVersion: c.version }])
    expect(out.result.results[0]!.outcome).toBe(c.price!.source === 'override' ? 'noop' : 'applied')
  })
  it('a refused cell answers with the cell\'s own reason', () => {
    const r = read(); const fba = r.rows.find(x => x.role === 'variant' && x.cells['AMAZON:EU']!.sync?.kind === 'FBA_EXCLUDED')!
    const out = applyCells(r, [{ rowId: fba.id, coordinateKey: 'AMAZON:EU', cell: 'syncQty', value: 1, expectedVersion: fba.cells['AMAZON:EU']!.version }])
    expect(out.result.results[0]).toMatchObject({ outcome: 'refused', reason: 'Amazon-managed' })
  })
  it('a verb applies as one operation and reverts by VALUE, every touched cell restored and re-versioned', () => {
    const r = read()
    const targets = r.rows.filter(x => x.role === 'variant').map(x => ({ rowId: x.id, coordinateKey: 'AMAZON:IT' }))
    const p = previewVerb(r, { params: { verb: 'adjust-prices', percent: -10 }, targets, commit: false }, ctx)
    const { read: applied, operation } = applyVerb(r, p, new Date(0))
    expect(operation.applied).toBe(p.changes.length)
    const ch = p.changes[0]!
    expect(applied.rows.find(x => x.id === ch.rowId)!.cells['AMAZON:IT']!.price!.value).toBe(ch.to)
    const reverted = revertOperation(applied, operation)
    const back = reverted.rows.find(x => x.id === ch.rowId)!.cells['AMAZON:IT']!
    expect(back.price!.value).toBe(ch.from); expect(back.version).toBe(applied.rows.find(x => x.id === ch.rowId)!.cells['AMAZON:IT']!.version + 1)
  })
  it('pause then resume round-trips the mode and the queue state', () => {
    const r = read(); const row = r.rows.find(x => x.role === 'variant' && x.cells['AMAZON:EU']!.sync?.kind === 'FOLLOW')!
    const t = [{ rowId: row.id, coordinateKey: 'AMAZON:EU' }]
    const paused = applyVerb(r, previewVerb(r, { params: { verb: 'pause-sync' }, targets: t, commit: false }, ctx)).read
    const s1 = paused.rows.find(x => x.id === row.id)!.cells['AMAZON:EU']!
    expect(s1.sync).toMatchObject({ kind: 'PAUSED', via: 'LISTING', mode: 'FOLLOW' }); expect(s1.queue?.state).toBe('paused')
    const resumed = applyVerb(paused, previewVerb(paused, { params: { verb: 'resume-sync' }, targets: t, commit: false }, ctx)).read
    const s2 = resumed.rows.find(x => x.id === row.id)!.cells['AMAZON:EU']!
    expect(s2.sync).toMatchObject({ kind: 'FOLLOW', via: null }); expect(s2.queue?.state).toBe('queued')
  })
  it('set-fulfilment FBM→FBA turns a row Amazon-managed in the same write', () => {
    const r = read(); const row = r.rows.find(x => x.role === 'variant' && x.cells['AMAZON:EU']!.sync?.kind === 'FOLLOW')!
    const out = applyCells(r, [{ rowId: row.id, coordinateKey: 'AMAZON:EU', cell: 'fulfilment', value: 'FBA', expectedVersion: row.cells['AMAZON:EU']!.version }])
    const c = out.read.rows.find(x => x.id === row.id)!.cells['AMAZON:EU']!
    expect(c.sync?.kind).toBe('FBA_EXCLUDED'); expect(c.writable.syncQty).toBe(false); expect(c.fulfilment?.guard).toBe('FBA')
  })
})
