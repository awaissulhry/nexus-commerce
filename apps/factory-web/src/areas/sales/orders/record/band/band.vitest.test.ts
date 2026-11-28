import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ORDER_LIFE, type OrderLife } from '@nexus/factory-domain/sales/order-life'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { backPlaceOf } from '../../../../../lib/record-frame/back'
import { previousAddresses } from '../../../../../lib/record-frame/use-back'
import { abilitiesOf, bandStepOf, BAND_ACT_KINDS, isBandAct } from '../../model'
import { order } from '../../_demo/fixtures'
import { ORDER_FLOW_NS } from '../flow-words'
import { BAND_TAGS, bandTagsOf, lifeOfOrder, openProblemsOf, orderActOf, type LegFacts } from './model'

/**
 * owb-of5 step 1 — the order band (design plan § 5i "ONE frame"; prototype rec.js orderBand, office.js officeNext): each life → its ONE
 * act; in production → none; an act this reader may not do is not drawn (sales without production.print.start: no Print button);
 * the tags in the design's order; Back says where it goes (§ 5p point 2). Written, not run (Owner rule: checks at the end).
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const ALL = { confirm: true, print: true, ship: true }
const leg = (state: LegFacts['state'], may: Partial<LegFacts['may']> = {}): LegFacts => ({ shipmentId: 'shipment-1', state, may: { arrived: true, sendOn: true, ...may } })

describe('owb-of5 step 1: each life → its ONE act', () => {
  it('Draft · Sent → Confirm · Confirmed → Print · Ready to ship → Ship · a leg on its way → It arrived · at our warehouse → Send on', () => {
    expect(orderActOf({ life: 'DRAFT', may: ALL })).toEqual({ act: 'CONFIRM' })
    expect(orderActOf({ life: 'SENT', may: ALL })).toEqual({ act: 'CONFIRM' })
    expect(orderActOf({ life: 'CONFIRMED', may: ALL })).toEqual({ act: 'PRINT' })
    expect(orderActOf({ life: 'READY_TO_SHIP', may: ALL })).toEqual({ act: 'SHIP' })
    expect(orderActOf({ life: 'SHIPPED', may: ALL, legs: [leg('ON_THE_WAY')] })).toEqual({ act: 'ARRIVED', shipmentId: 'shipment-1' })
    expect(orderActOf({ life: 'AT_OUR_WAREHOUSE', may: ALL, legs: [leg('AT_OUR_WAREHOUSE')] })).toEqual({ act: 'SEND_ON', shipmentId: 'shipment-1' })
  })

  it('in production → none; delivered and withdrawn → none; a Sent order that waits for the office yes keeps the yes door', () => {
    expect(orderActOf({ life: 'IN_PRODUCTION', may: ALL })).toBeNull()
    expect(orderActOf({ life: 'DELIVERED', may: ALL })).toBeNull()
    expect(orderActOf({ life: 'WITHDRAWN', may: ALL })).toBeNull()
    expect(orderActOf({ life: 'SENT', note: { kind: 'WAITS_FOR_APPROVAL' }, may: ALL })).toBeNull()
    // Every life is answered (a new life would fail here first).
    for (const life of ORDER_LIFE) expect(() => orderActOf({ life: life as OrderLife, may: ALL }), life).not.toThrow()
  })

  it('an act this reader may not do is not drawn: no Print without production.print.start, no Ship without a shipping right, no leg act without its may', () => {
    expect(orderActOf({ life: 'CONFIRMED', may: { confirm: true, ship: true } })).toBeNull()
    expect(orderActOf({ life: 'READY_TO_SHIP', may: { print: true } })).toBeNull()
    expect(orderActOf({ life: 'DRAFT', may: { print: true, ship: true } })).toBeNull()
    expect(orderActOf({ life: 'SHIPPED', may: ALL, legs: [leg('ON_THE_WAY', { arrived: false })] })).toBeNull()
    expect(orderActOf({ life: 'AT_OUR_WAREHOUSE', may: ALL, legs: [leg('AT_OUR_WAREHOUSE', { sendOn: false })] })).toBeNull()
  })

  it('the page: a confirmed order — sales WITH production.print.start gets Print and start the work…; without it, no main button', () => {
    const sales = abilitiesOf(['orders.view', 'orders.manage', 'workorders.view', 'production.print.start'])
    const salesWithout = abilitiesOf(['orders.view', 'orders.manage', 'workorders.view'])
    expect(bandStepOf(order('CONFIRMED'), sales, false)).toEqual({ kind: 'printStart', held: null })
    expect(bandStepOf(order('CONFIRMED'), salesWithout, false)).toEqual({ kind: null, held: null })
    // "Make work orders" is never the band's act any more (it stays in the ⋯ for production roles).
    expect(bandStepOf(order('CONFIRMED'), abilitiesOf(['orders.view', 'workorders.manage']), false).kind).not.toBe('makeWorkOrders')
  })

  it('the page: in production → no main button (not Change promise date…); ready with pieces ready → Ship…; read-only → none', () => {
    const owner = abilitiesOf(['orders.view', 'orders.manage', 'orders.close', 'shipping.manage', 'shipping.plan', 'production.print.start'])
    expect(bandStepOf(order('IN_PRODUCTION'), owner, false)).toEqual({ kind: null, held: null })
    const ready = order('READY')
    expect(bandStepOf({ ...ready, progress: { ...ready.progress, readyNow: 4 } }, owner, false).kind).toBe('ship')
    expect(bandStepOf({ ...ready, progress: { ...ready.progress, readyNow: 0, released: 0, shipped: 0 } }, owner, false).kind).toBeNull()
    expect(bandStepOf({ ...ready, progress: { ...ready.progress, readyNow: 4 } }, abilitiesOf(['orders.view', 'shipping.plan']), false).kind).toBe('ship')
    expect(bandStepOf(order('CONFIRMED'), owner, true)).toEqual({ kind: null, held: null })
  })

  it('the page: a shipped order with a leg at our warehouse → Send on (its shipment); on its way → It arrived', () => {
    const owner = abilitiesOf(['orders.view', 'orders.manage', 'orders.close', 'shipping.manage'])
    expect(bandStepOf(order('SHIPPED'), owner, false, [leg('AT_OUR_WAREHOUSE')])).toEqual({ kind: 'sendOn', held: null, shipmentId: 'shipment-1' })
    expect(bandStepOf(order('SHIPPED'), owner, false, [leg('ON_THE_WAY')])).toEqual({ kind: 'arrived', held: null, shipmentId: 'shipment-1' })
    expect(lifeOfOrder(order('SHIPPED'), [leg('AT_OUR_WAREHOUSE')]).life).toBe('AT_OUR_WAREHOUSE')
    expect(BAND_ACT_KINDS.every((kind) => isBandAct(kind))).toBe(true)
    expect(isBandAct('makeWorkOrders')).toBe(false)
  })
})

describe('owb-of5 step 1: the tags beside the ONE state chip', () => {
  it('in the design order; a fact not known draws nothing; Customer on hold only on a Draft or Sent order', () => {
    expect(bandTagsOf({ life: 'CONFIRMED' })).toEqual([])
    const all = bandTagsOf({ life: 'SENT', customerOnHold: true, design: 'WAITS', restricted: true, problems: 2, remake: true })
    expect(all.map((tag) => tag.kind)).toEqual([...BAND_TAGS])
    expect(all.find((tag) => tag.kind === 'PROBLEMS')).toEqual({ kind: 'PROBLEMS', tone: 'danger', key: 'tag.PROBLEMS', params: { count: 2 } })
    expect(bandTagsOf({ life: 'IN_PRODUCTION', customerOnHold: true }).map((tag) => tag.kind)).toEqual([])
    expect(bandTagsOf({ life: 'CONFIRMED', design: 'APPROVED' })[0]).toMatchObject({ key: 'tag.DESIGN_APPROVED', tone: 'success' })
    expect(openProblemsOf([{ status: 'OPEN' }, { status: 'ANSWERED' }, { status: 'OPEN' }])).toBe(2)
  })
})

describe('owb-of5 step 1: Back says where it goes (design § 5p point 2)', () => {
  const input = { prefix: '/w/demo', here: '/w/demo/sales/orders/order-1', customer: { id: 'party-1', name: 'Seed Racing' } }
  it('the customer page of this order → its name, on its tab; the list → Orders; the Design desk → Design desk', () => {
    expect(backPlaceOf(['http://localhost/w/demo/sales/customers/party-1?tab=work'], input)).toEqual({ href: '/w/demo/sales/customers/party-1?tab=work', kind: 'customer', name: 'Seed Racing' })
    expect(backPlaceOf(['/w/demo/sales/orders?rows=late'], input)).toEqual({ href: '/w/demo/sales/orders?rows=late', kind: 'orders' })
    expect(backPlaceOf(['/w/demo/home/design-desk'], input)).toMatchObject({ kind: 'designDesk' })
    expect(backPlaceOf(['/w/demo/sales/customers/party-9'], input)).toMatchObject({ kind: 'customers' })
  })
  it('a change of tab on this same page is not a step; outside this office or nothing before → null (the band keeps ‹ Orders)', () => {
    expect(backPlaceOf(['/w/demo/sales/orders/order-1?tab=lines', '/w/demo/warehouse/ready-to-ship'], input)).toMatchObject({ kind: 'readyToShip' })
    expect(backPlaceOf(['/p/orders'], input)).toBeNull()
    expect(backPlaceOf([], input)).toBeNull()
    expect(previousAddresses(null)).toEqual([])
    expect(previousAddresses({ currentEntry: { index: 2 }, entries: () => [{ url: '/a' }, { url: '/b' }, { url: '/c' }] })).toEqual(['/b', '/a'])
  })
})

describe('owb-of5 step 1: the page draws the band through the base parts, words in both languages', () => {
  it('ONE state chip on the life (StateChip), the picture slot, People, the act windows mounted once; the draft page too', () => {
    const view = read('../view/OrderRecordView.tsx')
    expect(view).toContain('status: <StateChip life={life.life} note={life.note} />')
    expect(view).not.toContain('<Pill tone={STATUS_TONE[order.status]}>')
    expect(view).toContain('<BandPicture')
    expect(view).toContain('<BandPeople')
    expect(view.match(/<OrderActWindows /g)?.length).toBe(1)
    const draft = read('../../draft/view/OfficeDraftView.tsx')
    expect(draft).toContain("{f('act.confirm')}")
    expect(draft).toContain('status: <StateChip life={life.life} note={life.note} />')
  })
  it('every band word in English and Italian', () => {
    const keys = ['act.confirm', ...BAND_ACT_KINDS.map((kind) => `act.${kind}`), 'tag.CUSTOMER_ON_HOLD', 'tag.DESIGN_WAITS', 'tag.DESIGN_APPROVED', 'tag.DESIGN_CHANGE', 'tag.RESTRICTED', 'tag.PROBLEMS_one', 'tag.PROBLEMS_other', 'tag.REMAKE', 'people.button', 'people.count_one', 'people.count_other', 'people.window', 'back.orders', 'back.customers', 'back.designDesk', 'back.incoming', 'back.readyToShip', 'back.today', 'back.order', 'back.page']
    for (const locale of LOCALES) for (const key of keys) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
