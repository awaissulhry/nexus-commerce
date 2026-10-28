import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { command } from '../../../core/command'
import { postMoves } from '../ledger/post-moves'
import { startInventoryFixture, type InventoryFixture } from '../ledger/testing/fixture'

/**
 * The stock overview, the stock card and the ledger check on the local stack (B-W1-22; SCM-190, SCM-191, SCM-258,
 * SCM-280, QHS-073; PLAN §4.7 "the stock ledger reconciles"). Run with `node scripts/factory/run-pg-tests.mjs inventory`.
 */

type Json = Record<string, any>
let f: InventoryFixture
let ids: InventoryFixture['ids']
let serial = 0
const key = () => `stock-${Date.now()}-${++serial}`

async function post(path: string, body: Json, session = 'manager'): Promise<Json> {
  const response = await f.call(session, 'POST', path, { siteId: ids.siteA1, ...body }, key())
  expect(response.statusCode, response.body).toBe(201)
  return response.json().move
}

beforeAll(async () => {
  f = await startInventoryFixture('stock')
  ids = f.ids
  // Hides 1 and 2 of the released lot (cost 7 and 8), hide 3 of the quarantined lot (standard 6.25), 120 m of lining,
  // 10 protectors; then hide 1 to the cutting rack, 20 m of lining to bin 1, 2 protectors scrapped.
  await post('/inventory/adjustments', { itemId: ids.leather, hideId: ids.hide1, locationId: ids.store, direction: 'IN', quantity: '53.2', unitCost: '7.000000', note: 'Opening.' })
  await post('/inventory/adjustments', { itemId: ids.leather, hideId: ids.hide2, locationId: ids.store, direction: 'IN', quantity: '51.8', unitCost: '8.000000', note: 'Opening.' })
  await post('/inventory/adjustments', { itemId: ids.leather, hideId: ids.hide3, locationId: ids.store, direction: 'IN', quantity: '40', note: 'Opening.' })
  await post('/inventory/adjustments', { itemId: ids.lining, lotId: ids.liningLot, locationId: ids.store, direction: 'IN', quantity: '120', note: 'Opening.' })
  await post('/inventory/adjustments', { itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '10', note: 'Opening.' })
  await post('/inventory/transfers', { itemId: ids.leather, hideId: ids.hide1, fromLocationId: ids.store, toLocationId: ids.cut, quantity: '53.2' })
  await post('/inventory/transfers', { itemId: ids.lining, lotId: ids.liningLot, fromLocationId: ids.store, toLocationId: ids.bin1, quantity: '20' })
  await post('/inventory/scraps', { itemId: ids.protector, fromLocationId: ids.store, quantity: '2', note: 'Cracked shell.' })
}, 60_000)

afterAll(async () => {
  await f?.close()
}, 60_000)

describe('the stock overview (SCM-190, SCM-280, QHS-073)', () => {
  it('shows on hand, held and available per location and stock key, and per item with hides and area side by side', async () => {
    const response = await f.call('manager', 'GET', `/inventory/stock?siteId=${ids.siteA1}`)
    expect(response.statusCode, response.body).toBe(200)
    const { rows, items, truncated } = response.json()
    expect(truncated).toBe(false)
    const row = (locationId: string, itemId: string, hideId: string | null = null) => rows.find((entry: Json) => entry.location.id === locationId && entry.item.id === itemId && (entry.hide?.id ?? null) === hideId)
    expect(row(ids.store, ids.leather, ids.hide3)).toMatchObject({ onHand: '40.0000', held: '40.0000', available: '0.0000', lot: { code: 'TEST-LOT-LEA-2', qualityStatus: 'QUARANTINE' }, colour: { code: 'BLK' } })
    expect(row(ids.cut, ids.leather, ids.hide1)).toMatchObject({ onHand: '53.2000', held: '0.0000', available: '53.2000', unitCost: '7.493333', value: 39_865 })
    expect(row(ids.store, ids.protector)).toMatchObject({ onHand: '8.0000', held: '0.0000', unitCost: '4.000000', value: 3200, item: { tracking: 'NONE', baseUom: 'PCS' } })
    expect(row(ids.bin1, ids.lining)).toMatchObject({ onHand: '20.0000', unitCost: '3.100000', value: 6200 })
    expect(rows).toHaveLength(6)

    const leather = items.find((total: Json) => total.itemId === ids.leather)
    expect(leather).toMatchObject({ onHand: '145.0000', held: '40.0000', available: '105.0000', hides: 3, heldHides: 1, locations: 2, currency: 'EUR' })
    // 53.2 and 51.8 at the lot's average 7.493333 (together the 786.80 they came in at) and 40 at the standard 6.25.
    expect(leather.value).toBe(39_865 + 38_815 + 25_000)
    expect(items.find((total: Json) => total.itemId === ids.lining)).toMatchObject({ onHand: '120.0000', hides: 0, locations: 2 })
  })

  it('filters by location, item and held stock', async () => {
    const held = (await f.call('manager', 'GET', `/inventory/stock?held=true`)).json()
    expect(held.rows.map((entry: Json) => entry.hide?.code)).toEqual(['TEST-HIDE-3'])
    const bin = (await f.call('manager', 'GET', `/inventory/stock?locationId=${ids.bin1}`)).json()
    expect(bin.rows.map((entry: Json) => [entry.item.code, entry.onHand])).toEqual([['TEST-LINING', '20.0000']])
    const protector = (await f.call('manager', 'GET', `/inventory/stock?itemId=${ids.protector}`)).json()
    expect(protector.items).toEqual([expect.objectContaining({ onHand: '8.0000', value: 3200 })])
  })

  it('values only with the cost grain; nothing for another company, site or tenant', async () => {
    const plain = await f.call('warehouse', 'GET', `/inventory/stock?siteId=${ids.siteA1}`)
    expect(plain.statusCode).toBe(200)
    expect(plain.body).not.toMatch(/unitCost|"value"|currency/)
    expect(plain.json().rows).toHaveLength(6)
    expect((await f.call('company-two', 'GET', '/inventory/stock')).json().rows).toEqual([])
    expect((await f.call('manager-b', 'GET', '/inventory/stock')).json().rows).toEqual([])
    expect((await f.call('floor-a1', 'GET', '/inventory/stock')).statusCode).toBe(403)
  })
})

describe('the stock card (SCM-191)', () => {
  it('shows each move of an item with its effect and the balance after it, for the site or one location', async () => {
    const site = (await f.call('viewer', 'GET', `/inventory/stock/card?siteId=${ids.siteA1}&itemId=${ids.protector}`)).json()
    expect(site).toMatchObject({ opening: '0.0000', closing: '8.0000', complete: true })
    expect(site.lines.map((line: Json) => [line.reason, line.delta, line.balance])).toEqual([
      ['ADJUSTMENT', '10.0000', '10.0000'],
      ['SCRAP', '-2.0000', '8.0000'],
    ])
    const lining = (await f.call('viewer', 'GET', `/inventory/stock/card?siteId=${ids.siteA1}&itemId=${ids.lining}&locationId=${ids.store}`)).json()
    expect(lining.lines.map((line: Json) => [line.reason, line.delta, line.balance])).toEqual([
      ['ADJUSTMENT', '120.0000', '120.0000'],
      ['TRANSFER', '-20.0000', '100.0000'],
    ])
    const latest = (await f.call('viewer', 'GET', `/inventory/stock/card?siteId=${ids.siteA1}&itemId=${ids.lining}&locationId=${ids.store}&limit=1`)).json()
    expect(latest).toMatchObject({ opening: '120.0000', closing: '100.0000', complete: false })
    expect((await f.call('viewer', 'GET', `/inventory/stock/card?siteId=${ids.siteB1}&itemId=${ids.protector}`)).statusCode).toBe(404)
  })
})

describe('the stock ledger reconciles (PLAN §4.7 end check)', () => {
  it('passes: the moves fold to the overview’s sums, nothing below zero, reversals mirror, every value-changing move valued', async () => {
    const scrap = await post('/inventory/scraps', { itemId: ids.protector, fromLocationId: ids.store, quantity: '1', note: 'Second crack.' })
    const reversal = await f.call('manager', 'POST', `/inventory/moves/${scrap.id}/reverse`, { note: 'Was fine.' }, key())
    expect(reversal.statusCode).toBe(201)
    const response = await f.call('viewer', 'GET', `/inventory/stock/reconciliation?siteId=${ids.siteA1}`)
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json()
    expect(result.ok).toBe(true)
    expect(result.sites).toHaveLength(1)
    expect(result.sites[0]).toMatchObject({ siteCode: 'A1', moves: 10, ok: true })
    expect(result.sites[0].checks.map((check: Json) => [check.name, check.ok])).toEqual([
      ['balances', true],
      ['not_below_zero', true],
      ['reversals', true],
      ['valuations', true],
    ])
  })

  it('warns about a floor move not valued yet, and passes again once the worker valued it', async () => {
    const { result } = await command(f.caller('floor-a1'), { name: 'test.floorFound', idempotencyKey: key(), input: {} }, (tools) =>
      postMoves(tools, [{ siteId: ids.siteA1, reason: 'ADJUSTMENT', itemId: ids.protector, toLocationId: ids.cut, quantity: '1', note: 'Found.' }]),
    )
    const before = (await f.call('viewer', 'GET', `/inventory/stock/reconciliation?siteId=${ids.siteA1}`)).json()
    expect(before.ok).toBe(true)
    expect(before.sites[0].checks.find((check: Json) => check.name === 'valuations')).toMatchObject({ ok: false, severity: 'warning', details: [result[0]!.id] })
    const { valueMove } = await import('../ledger/valuation')
    expect(await valueMove(f.system(), result[0]!.id, newId())).toBe(true)
    const after = (await f.call('viewer', 'GET', `/inventory/stock/reconciliation`)).json()
    expect(after.ok).toBe(true)
    expect(after.sites.map((site: Json) => site.siteCode)).toEqual(['A1', 'A2', 'C1'])
    expect(after.sites[0].checks.every((check: Json) => check.ok)).toBe(true)
  })
})
