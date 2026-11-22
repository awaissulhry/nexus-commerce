import { describe, expect, it } from 'vitest'
import { canOf, order } from '../../_demo/fixtures'
import { bandStepOf, mayCreateShipment, readyToShipOf } from '../../model'
import { createDoorOf, createHeldWords, elsewhereDoorOf } from './doors'
import { headOf } from './head'
import { whereOf, type WhereModel } from './where'

/**
 * F-OS-101 / F-OS-102 (order SHIPMENTS tab; plan D2; 18-lead-settles L9, L10) — the tab's doors, pure: HIDDEN without the right
 * (reverses F-OP-308 for this tab), held with TRUE words only by the order's state; Create shipment… opens only when something is ready
 * now (and the band's next step on every tab follows the same rule). And the tab's one answer. Made-up data only.
 */

const ready = order('READY', { progress: { ...order('READY').progress, released: 6, shipped: 2 } })
const where = (over: Partial<WhereModel['totals']> = {}, more: Partial<WhereModel> = {}): WhereModel => ({ ...whereOf(ready, null), mode: 'counted', totals: { shipped: 0, packed: 0, draft: 0, planned: 0, back: 0, ready: 0, making: 0, closed: 0, ...over }, ...more })

describe('Create shipment…: hidden without shipping.manage; open when something is ready now; else held with true words', () => {
  it('Sales, the Production manager: hidden (D2) — never a held button for a right', () => {
    expect(createDoorOf(ready, canOf('sales'), where(), '/f', true)).toEqual({ kind: 'hidden' })
    expect(createDoorOf(ready, canOf('manager'), where(), '/f', true)).toEqual({ kind: 'hidden' })
  })

  it('open in place (else Warehouse\'s page with this order chosen) by today\'s rule until the server counts ready now', () => {
    expect(createDoorOf(ready, canOf('owner'), where(), '/f', true)).toEqual({ kind: 'open', inPlace: true, href: `/f/warehouse/shipments?new=1&order=${encodeURIComponent(ready.id)}` })
    expect(createDoorOf(ready, canOf('owner'), where(), '/f', false).kind).toBe('open')
  })

  it('L9: once the server counts it, only ready now opens it — every released garment on a draft offers nothing to create', () => {
    const planned = { ...ready, progress: { ...ready.progress, planned: 4, readyNow: 0 } }
    expect(readyToShipOf(planned.progress)).toBe(0)
    expect(mayCreateShipment(planned, canOf('owner'))).toBe(false)
    expect(createDoorOf(planned, canOf('owner'), where({ planned: 4 }), '/f', true)).toEqual({ kind: 'held', words: { key: 'ships.create.held.planned' } })
    const one = { ...ready, progress: { ...ready.progress, planned: 3, readyNow: 1 } }
    expect(mayCreateShipment(one, canOf('owner'))).toBe(true)
    // The band's next step reads the same rule on every tab: a READY order with everything planned no longer offers Create shipment….
    expect(bandStepOf(planned, canOf('owner'), false).kind).not.toBe('createShipment')
    expect(bandStepOf(one, canOf('owner'), false).kind).toBe('createShipment')
  })

  it('the true words: everything shipped · still to be made or released · came back, not received · all on shipments · a final order', () => {
    const none = { ...ready, progress: { ...ready.progress, planned: 0, readyNow: 0 } }
    expect(createHeldWords(none, where({}, { allOut: true }))).toEqual({ key: 'ships.create.held.shipped' })
    expect(createHeldWords(none, where({ making: 28 }))).toEqual({ key: 'ships.create.held.making', params: { count: 28 } })
    expect(createHeldWords(none, where({ back: 70 }))).toEqual({ key: 'ships.create.held.back' })
    expect(createHeldWords(none, where({ draft: 12 }))).toEqual({ key: 'ships.create.held.planned' })
    expect(createHeldWords({ ...none, status: 'CLOSED' }, where())).toEqual({ ns: 'orders', key: 'held.final' })
    // Today's rule (no count from the server): a shipped order never hears "quality releases the garments first" (P0-B1).
    const shipped = { ...ready, progress: { ...ready.progress, released: 14, shipped: 14, toShip: 0 } }
    expect(createHeldWords(shipped, where({}, { mode: 'today' }))).toEqual({ key: 'ships.create.held.shipped' })
    expect(createHeldWords(order('CONFIRMED'), where({}, { mode: 'today' }))).toEqual({ ns: 'orders', key: 'ship.create.held.nothing' })
  })
})

describe('Record a shipment made elsewhere…: hidden without its rights (D2), held with words by the order\'s state', () => {
  it('no right → hidden (whatever the state); the order\'s state → held; open → open; not offered here → hidden', () => {
    const owner = canOf('owner')
    expect(elsewhereDoorOf({ held: { key: 'elsewhere.held.noRight' } }, owner)).toBeNull()
    expect(elsewhereDoorOf({ held: { key: 'elsewhere.held.state' } }, owner)).toEqual({ held: { key: 'elsewhere.held.state' } })
    expect(elsewhereDoorOf({ held: { key: 'elsewhere.held.state' } }, canOf('sales'))).toBeNull()
    expect(elsewhereDoorOf({ held: null }, owner)).toEqual({ held: null })
    expect(elsewhereDoorOf(null, owner)).toBeNull()
    expect(elsewhereDoorOf(undefined, owner)).toBeNull()
  })
})

describe('the tab\'s one answer (10-design §3)', () => {
  it('where the order stands, what can go, what is still to make; then the shipments that need a person', () => {
    const value = { ...ready, status: 'PARTLY_SHIPPED' as const, progress: { ...ready.progress, ordered: 114, shipped: 40, planned: 36, readyNow: 6 } }
    const rows = [
      { id: 'a', number: 'SEED-SH-0011', status: 'SHIPPED', shippedAt: null, deliveredAt: null, expectedDeliveryAt: '2026-11-14T00:00:00.000Z' },
      { id: 'b', number: 'SEED-SH-0012', status: 'PACKED', shippedAt: null, deliveredAt: null, holds: [{ reason: 'CREDIT', words: null, bySystem: false, placedAt: '2026-11-19T08:00:00.000Z' }] },
      { id: 'c', number: 'SEED-SH-0013', status: 'RETURNED', shippedAt: null, deliveredAt: null },
    ]
    const head = headOf({ ...value, chain: { ...value.chain, shipments: rows } }, where({ ready: 6, making: 28, closed: 4 }), { order: { id: value.id, number: value.number, status: 'PARTLY_SHIPPED', deliveredAt: null }, shipments: [{ id: 'c', number: 'SEED-SH-0013', status: 'RETURNED', carrierName: null, shippedAt: null, deliveredAt: null, deliveredVia: null, pod: null, openProblems: 0, mayOpen: true, returned: { at: '2026-11-19T10:00:00.000Z', received: false } }], steps: [] })
    expect(head.tone).toBe('warning')
    expect(head.parts).toEqual([
      { key: 'head.partly', params: { shipped: 40, ordered: 114 } },
      { key: 'head.ready', params: { count: 6 } },
      { key: 'head.making', params: { count: 28 } },
      { key: 'head.expected', params: { number: 'SEED-SH-0011' }, instants: { day: '2026-11-14T00:00:00.000Z' } },
      { key: 'head.held', params: { number: 'SEED-SH-0012' } },
      { key: 'head.backOn', params: { number: 'SEED-SH-0013' }, instants: { day: '2026-11-19T10:00:00.000Z' } },
      { key: 'head.closed', params: { count: 4 } },
    ])
  })

  it('delivered: "Delivered on {day}: every garment has shipped and every shipment has arrived" (success)', () => {
    const demo = order('DELIVERED')
    const value = { ...demo, chain: { ...demo.chain, shipments: demo.chain.shipments.filter((row) => row.status === 'DELIVERED') } }
    const head = headOf(value, where({}, { allOut: true }), { order: { id: value.id, number: value.number, status: 'DELIVERED', deliveredAt: '2026-11-18T10:00:00.000Z' }, shipments: [], steps: [] })
    expect(head).toEqual({ tone: 'success', parts: [{ key: 'head.delivered', instants: { day: '2026-11-18T10:00:00.000Z' } }] })
    expect(headOf(order('CONFIRMED'), where({}, { state: 'pending' }), null)).toEqual({ tone: 'neutral', parts: [{ key: 'where.state.pending' }] })
  })
})
