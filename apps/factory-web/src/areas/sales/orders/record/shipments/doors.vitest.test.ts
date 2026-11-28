import { describe, expect, it } from 'vitest'
import { canOf, order } from '../../_demo/fixtures'
import { abilitiesOf, bandStepOf, mayCreateShipment, readyToShipOf } from '../../model'
import { createDoorOf, createHeldWords, elsewhereDoorOf } from './doors'
import { rowActsOf } from './doors' // F-OS-202
import { afterSalesDoorsOf, afterSalesRowActs } from './doors' // F-OS-303
import { headOf } from './head'
import { planOf } from './doors' // owb-ss3
import { legActsOf, shipRightsOf } from './legs/model' // owb-ss3
import { whereOf, type ShipmentRow, type WhereModel } from './where'

/**
 * F-OS-101 / F-OS-102 (order SHIPMENTS tab; plan D2; 18-lead-settles L9, L10) — the tab's doors, pure: HIDDEN without the right
 * (reverses F-OP-308 for this tab), held with TRUE words only by the order's state; Create shipment… opens only when something is ready
 * now (and the band's next step on every tab follows the same rule). And the tab's one answer. Made-up data only.
 */

const ready = order('READY', { progress: { ...order('READY').progress, released: 6, shipped: 2 } })
const where = (over: Partial<WhereModel['totals']> = {}, more: Partial<WhereModel> = {}): WhereModel => ({ ...whereOf(ready, null), mode: 'counted', totals: { shipped: 0, atWarehouse: 0, packed: 0, draft: 0, planned: 0, back: 0, ready: 0, making: 0, closed: 0, ...over }, ...more })

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

// ---- F-OS-202 (10-design §5 "Row ⋯"; plan D2, D3, D5, D6): a row's acts by state — hidden without the right, held only by state ----
describe('F-OS-202: the row ⋯ by the shipment\'s state', () => {
  const ALL = { manage: true, pack: true, ddt: true, holdsManage: true, holdsRelease: true }
  const ORDER_ID = 'so-2'
  const row = (status: string, over: Partial<ShipmentRow> = {}): ShipmentRow => ({ id: 'sh-1', number: 'SEED-SH-0012', status, shippedAt: null, deliveredAt: null, transportBy: 'CARRIER', origin: 'NEXUS', ddt: null, ddtRequired: true, may: ALL, orders: [{ id: ORDER_ID, number: 'SEED-SO-0002', customerRef: null }], ...over })
  const ids = (acts: ReturnType<typeof rowActsOf>) => acts.map((entry) => entry.id)

  it('no `may` (an older answer) or no right: nothing is offered (never a held item for a right)', () => {
    expect(rowActsOf(row('DRAFT', { may: undefined }), ORDER_ID, null)).toEqual([])
    expect(rowActsOf(row('DRAFT', { may: { manage: false, pack: false, ddt: false, holdsManage: false, holdsRelease: false } }), ORDER_ID, null)).toEqual([])
  })

  it('DRAFT: split, move, merge; take this order off only on a shared draft not made for it; how it travels; holds; travels without a DDT; cancel', () => {
    expect(ids(rowActsOf(row('DRAFT'), ORDER_ID, null))).toEqual(['split', 'move', 'merge', 'arrange', 'ddtOff', 'placeHold', 'cancel'])
    const shared = row('DRAFT', { orders: [{ id: 'so-3', number: 'SEED-SO-0003', customerRef: null }, { id: ORDER_ID, number: 'SEED-SO-0002', customerRef: null }] })
    expect(ids(rowActsOf(shared, ORDER_ID, null))).toContain('takeOff')
    // The order it was made for never comes off it (Split… or Move…, then cancel).
    expect(ids(rowActsOf(shared, 'so-3', null))).not.toContain('takeOff')
  })

  it('PACKED: split / move / merge held with words; unpack (shipping.pack) held by a live DDT; put back the DDT once it travels without', () => {
    const acts = rowActsOf(row('PACKED', { ddt: { number: '151/2026', date: '2026-11-18' } }), ORDER_ID, null)
    expect(acts.find((entry) => entry.id === 'split')?.held).toEqual({ key: 'ships.act.held.splitPacked' })
    expect(acts.find((entry) => entry.id === 'merge')?.held).toEqual({ key: 'ships.act.held.movePacked' })
    expect(acts.find((entry) => entry.id === 'unpack')?.held).toEqual({ key: 'ships.act.held.ddtLive' })
    expect(acts.find((entry) => entry.id === 'ddtOff')?.held).toEqual({ key: 'ships.act.held.ddtLive' })
    expect(acts.find((entry) => entry.id === 'cancel')?.held).toEqual({ key: 'ships.act.held.ddtLive' })
    expect(ids(rowActsOf(row('PACKED', { ddtRequired: false }), ORDER_ID, null))).toContain('ddtBack')
    // Made elsewhere: its own choice — no DDT door, no how it travels.
    expect(ids(rowActsOf(row('PACKED', { origin: 'ELSEWHERE' }), ORDER_ID, null))).not.toContain('ddtOff')
  })

  it('a hold in force is released by whom may: a money or system hold by finance (holds.release), a person\'s by the warehouse', () => {
    const held = row('PACKED', { holds: [{ id: 'h1', reason: 'BALANCE_UNPAID', words: null, bySystem: true, placedAt: '2026-11-19T08:00:00.000Z' }, { id: 'h2', reason: 'QUALITY', words: null, bySystem: false, placedAt: '2026-11-20T08:00:00.000Z' }] })
    expect(rowActsOf(held, ORDER_ID, null).filter((entry) => entry.id === 'releaseHold').map((entry) => entry.holdId)).toEqual(['h1', 'h2'])
    const warehouse = { ...ALL, holdsRelease: false }
    expect(rowActsOf({ ...held, may: warehouse }, ORDER_ID, null).filter((entry) => entry.id === 'releaseHold').map((entry) => entry.holdId)).toEqual(['h2'])
    expect(rowActsOf(held, ORDER_ID, null).find((entry) => entry.holdId === 'h1')?.label).toEqual({ key: 'ships.act.releaseHold', words: { reason: { ns: 'depth', key: 'holdReason.BALANCE_UNPAID' } } })
  })

  it('SHIPPED: Mark delivered / Mark returned (D5; L1), expected arrival held over a carrier\'s labels, Resolve with an open problem', () => {
    expect(ids(rowActsOf(row('SHIPPED'), ORDER_ID, null))).toEqual(['delivered', 'returned', 'eta'])
    const labelled = row('SHIPPED', { parcels: [{ id: 'p1', seq: 1, number: 'BRT-1', url: null, source: 'LABEL', live: true }] })
    expect(rowActsOf(labelled, ORDER_ID, { openProblems: 1, pod: null, returned: null }).map((entry) => [entry.id, entry.held?.key ?? null])).toEqual([
      ['delivered', null],
      ['returned', null],
      ['eta', 'ships.act.held.carrierFed'],
      ['resolve', null],
    ])
  })

  it('DELIVERED: record the proof (held once every part is kept); RETURNED: receive the garments back (held once received); CANCELLED: nothing', () => {
    expect(ids(rowActsOf(row('DELIVERED'), ORDER_ID, null))).toEqual(['proof'])
    expect(rowActsOf(row('DELIVERED'), ORDER_ID, { openProblems: 0, pod: { signedBy: 'M. Rossi', signedAt: '2026-11-14T09:30:00.000Z', image: true }, returned: null })[0]?.held).toEqual({ key: 'ships.act.held.proofKept' })
    expect(rowActsOf(row('RETURNED'), ORDER_ID, { openProblems: 0, pod: null, returned: { at: null, received: true } })[0]).toMatchObject({ id: 'receiveBack', held: { key: 'ships.act.held.received' } })
    expect(rowActsOf(row('CANCELLED'), ORDER_ID, null)).toEqual([])
  })

  it('the same words as Warehouse where the act is the same (never a second word for one thing)', () => {
    const acts = rowActsOf(row('DRAFT'), ORDER_ID, null)
    expect(acts.find((entry) => entry.id === 'split')?.label).toEqual({ ns: 'depth', key: 'split.menu' })
    expect(acts.find((entry) => entry.id === 'placeHold')?.label).toEqual({ ns: 'depth', key: 'holds.placeMenu' })
    expect(acts.find((entry) => entry.id === 'arrange')?.label).toEqual({ ns: 'depth', key: 'transport.change' })
  })
})
// ---- end F-OS-202

// ---- F-OS-303 (order SHIPMENTS tab, 10-design §5 "SHIPPED, DELIVERED", §6 head, §8; 18-lead-settles L8) ----
describe('F-OS-303: the after-sales doors — Open a return…, Log a complaint…, Send a claim link… (their pages\' own windows, in place)', () => {
  const ORDER_ID = 'so-2'
  const row = (status: string, over: Partial<ShipmentRow> = {}): ShipmentRow => ({ id: 'sh-1', number: 'SEED-SH-0012', status, shippedAt: null, deliveredAt: null, transportBy: 'CARRIER', origin: 'NEXUS', ddt: null, ddtRequired: true, orders: [{ id: ORDER_ID, number: 'SEED-SO-0002', customerRef: null }], ...over })
  const BOTH = { returnsManage: true, complaintsLog: true }
  const ids = (acts: ReturnType<typeof rowActsOf>) => acts.map((entry) => entry.id)

  it('the rights: sales.returns.manage opens a return and sends a claim link, quality.complaints.log logs a complaint', () => {
    expect(abilitiesOf(['sales.returns.manage'])).toMatchObject({ returnsManage: true, complaintsLog: false })
    expect(abilitiesOf(['quality.complaints.log'])).toMatchObject({ returnsManage: false, complaintsLog: true })
  })

  it('a shipped or delivered row offers them by right, in their own group, last before the danger acts; hidden without the right (D2)', () => {
    expect(ids(afterSalesRowActs(row('SHIPPED'), BOTH))).toEqual(['return', 'complaint', 'claim'])
    expect(ids(afterSalesRowActs(row('DELIVERED'), { complaintsLog: true }))).toEqual(['complaint'])
    expect(ids(afterSalesRowActs(row('DELIVERED'), { returnsManage: true }))).toEqual(['return', 'claim'])
    expect(afterSalesRowActs(row('SHIPPED'), {})).toEqual([])
    for (const status of ['DRAFT', 'PACKED', 'RETURNED', 'CANCELLED']) expect(afterSalesRowActs(row(status), BOTH), status).toEqual([])
    expect(afterSalesRowActs(row('SHIPPED'), BOTH).every((entry) => entry.group === 'after' && entry.held === null)).toBe(true)
    // Beside Warehouse's own acts (the row's `may`), and also on an older answer without `may` (the order's rights, not the row's).
    expect(ids(rowActsOf(row('SHIPPED', { may: { manage: true, pack: true, ddt: true, holdsManage: true, holdsRelease: true } }), ORDER_ID, null, BOTH))).toEqual(['delivered', 'returned', 'eta', 'return', 'complaint', 'claim'])
    expect(ids(rowActsOf(row('DELIVERED'), ORDER_ID, null, BOTH))).toEqual(['return', 'complaint', 'claim'])
    expect(afterSalesRowActs(row('SHIPPED'), BOTH).map((entry) => entry.label)).toEqual([{ key: 'ships.act.return' }, { key: 'ships.act.complaint' }, { key: 'ships.act.claim' }])
  })

  it('the head: Open a return… and Log a complaint… as buttons, Send a claim link… in its ⋯; a return and a link wait until something left', () => {
    const none = { chain: { ...ready.chain, shipments: [row('DRAFT')] } }
    expect(afterSalesDoorsOf(none, BOTH)).toEqual({
      buttons: [
        { kind: 'return', label: { key: 'after.act.return' }, held: { key: 'after.held.return' } },
        { kind: 'complaint', label: { key: 'after.act.complaint' }, held: null },
      ],
      claim: { kind: 'claim', label: { key: 'after.act.claim' }, held: { key: 'after.held.claim' } },
    })
    const left = { chain: { ...ready.chain, shipments: [row('DRAFT'), row('RETURNED', { id: 'sh-2' })] } }
    expect(afterSalesDoorsOf(left, BOTH).buttons.map((door) => door.held)).toEqual([null, null])
    expect(afterSalesDoorsOf(left, BOTH).claim?.held).toBeNull()
    expect(afterSalesDoorsOf(left, {})).toEqual({ buttons: [], claim: null })
    expect(afterSalesDoorsOf(left, { complaintsLog: true }).buttons.map((door) => door.kind)).toEqual(['complaint'])
  })
})
// ---- end F-OS-303

// ── os-fx7 (30-walk W-02, W-04, W-11, W-13) ──
describe('os-fx7: the walk\'s gaps on the head, the cards and the dialogs', () => {
  it('W-11: our van on its way says it has not reported the delivery yet (never "on its way" with nothing to follow); a set day still says it', () => {
    const value = order('PARTLY_SHIPPED')
    const van = { id: 'v', number: 'SEED-SH-0101', status: 'SHIPPED', shippedAt: '2026-11-18T08:00:00.000Z', deliveredAt: null, transportBy: 'SENDER' as const }
    const parts = (rows: ShipmentRow[]) => headOf({ ...value, chain: { ...value.chain, shipments: rows } }, where(), null).parts
    expect(parts([van])).toContainEqual({ key: 'head.vanNotReported', params: { number: 'SEED-SH-0101' } })
    expect(parts([{ ...van, expectedDeliveryAt: '2026-11-21T11:00:00.000Z' }])).toContainEqual({ key: 'head.expected', params: { number: 'SEED-SH-0101' }, instants: { day: '2026-11-21T11:00:00.000Z' } })
    expect(parts([{ ...van, transportBy: 'CARRIER' }])).toContainEqual({ key: 'head.onItsWay', params: { number: 'SEED-SH-0101' } })
  })

  it('W-02: a lone or odd last style card spans both columns of the two-per-row grid (no dead half at 1920)', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('./view/shipments.css', import.meta.url), 'utf8')
    expect(css).toContain('.fw-os-wcs > .fw-os-wc:last-child:nth-child(odd) { grid-column: 1 / -1; }')
  })

  it('W-04: joining an existing shipment never says it takes the next number; W-13: "Whole order" / "Tutto l\'ordine"', async () => {
    const { readFileSync } = await import('node:fs')
    const { CATALOGUE } = await import('../../../../../lib/i18n/messages')
    expect(readFileSync(new URL('../../../../warehouse/shipments/list/view/NewShipmentDialog.tsx', import.meta.url), 'utf8')).toContain("{!model.join && <p className=\"fw-sh-hint\">{t('new.number')}</p>}")
    expect(CATALOGUE.en['order-shipments']?.['after.about.order']).toBe('Whole order')
    expect(CATALOGUE.it['order-shipments']?.['after.about.order']).toBe("Tutto l'ordine")
    expect(readFileSync(new URL('./view/AfterSalesSection.tsx', import.meta.url), 'utf8')).toContain("t('after.about.order')")
  })
})
// ── end os-fx7 ──

// ── owb-ss3 step 3.2 (settle L3; design plan § 5n R38 "TWO rights") ───────────────────────────────────────────────────────────────
describe('owb-ss3: the two rights — plan (shipping.plan OR shipping.manage) · pack and send (shipping.manage)', () => {
  const SALES_PLAN = ['orders.view', 'shipping.view', 'shipping.plan']
  const WAREHOUSE = ['shipping.view', 'shipping.manage', 'shipping.pack']
  const leg = (state: 'ON_THE_WAY' | 'AT_OUR_WAREHOUSE' | 'SENT_ON') => ({ state, may: { arrived: state === 'ON_THE_WAY', sendOn: state === 'AT_OUR_WAREHOUSE', label: true } })

  it('sales with the plan right plans (Create shipment… opens) but never sends on; the warehouse does both; neither: nothing', () => {
    expect(shipRightsOf(SALES_PLAN)).toEqual({ plan: true, send: false })
    expect(shipRightsOf(WAREHOUSE)).toEqual({ plan: true, send: true })
    expect(shipRightsOf(['orders.view'])).toEqual({ plan: false, send: false })
    expect(planOf(canOf('sales'), shipRightsOf(SALES_PLAN))).toBe(true)
    expect(createDoorOf(ready, { createShipment: planOf(canOf('sales'), shipRightsOf(SALES_PLAN)) }, where(), '/f', true).kind).toBe('open')
    // Not read (the design index): today's rule, the order page's own ability.
    expect(planOf(canOf('sales'), null)).toBe(false)
    expect(planOf(canOf('owner'), null)).toBe(true)
  })

  it('sales plan only: no "It arrived at the warehouse", no "Send on to the customer", even where the server would let the row', () => {
    expect(legActsOf(leg('ON_THE_WAY'), shipRightsOf(SALES_PLAN))).toEqual([])
    expect(legActsOf(leg('AT_OUR_WAREHOUSE'), shipRightsOf(SALES_PLAN))).toEqual([])
    expect(legActsOf(leg('ON_THE_WAY'), shipRightsOf(WAREHOUSE))).toEqual(['ARRIVED'])
    expect(legActsOf(leg('AT_OUR_WAREHOUSE'), shipRightsOf(WAREHOUSE))).toEqual(['SEND_ON'])
    expect(legActsOf(leg('SENT_ON'), shipRightsOf(WAREHOUSE))).toEqual([])
    // The server's `may` wins: a row it does not let is offered nothing.
    expect(legActsOf({ state: 'AT_OUR_WAREHOUSE', may: { arrived: false, sendOn: false, label: false } }, shipRightsOf(WAREHOUSE))).toEqual([])
  })

  it('G9: Mark delivered… on a shipment to our warehouse first is held until it is sent on', () => {
    const ALL = { manage: true, pack: true, ddt: true, holdsManage: true, holdsRelease: true }
    const shipped: ShipmentRow = { id: 'sh-9', number: 'SEED-SH-0019', status: 'SHIPPED', shippedAt: null, deliveredAt: null, transportBy: 'CARRIER', origin: 'NEXUS', ddt: null, ddtRequired: true, may: ALL }
    const held = (state: 'ON_THE_WAY' | 'AT_OUR_WAREHOUSE' | 'SENT_ON' | null) => rowActsOf(shipped, 'so-9', null, {}, state ? { state } : null).find((entry) => entry.id === 'delivered')?.held ?? null
    expect(held('ON_THE_WAY')).toEqual({ ns: 'ways', key: 'leg.held.deliveredFirst' })
    expect(held('AT_OUR_WAREHOUSE')).toEqual({ ns: 'ways', key: 'leg.held.deliveredFirst' })
    expect(held('SENT_ON')).toBeNull()
    expect(held(null)).toBeNull()
  })
})
