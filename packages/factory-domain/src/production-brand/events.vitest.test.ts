import { describe, expect, it } from 'vitest'
import type { Actor, Grant } from '../core/permissions'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { isMoneyField } from '../events/define'
import type { EventEnvelope } from '../events/envelope'
import { liveMessageFor, liveViewFor } from '../events/live'
import { WORK_ORDER_HOLD_KINDS } from '../production/holds/kinds'
import {
  assertOneParty,
  BRAND_HOLD_KINDS,
  BrandEventWallError,
  events,
  namesOnlyItsParty,
  sharesPerParty,
  supervisorChangedEvent,
  urgencyChangedEvent,
  type PartyOrder,
} from './events'

/**
 * B-PR-16 (production plan §2 the brand wall, §6; R-41, R-48; PW-P07, PW-15 events part): the production events of a customer.
 * One customer per event, ids and states only; the office's live screens send each to people who reach that customer only;
 * a command over orders of several customers emits one event per customer, and every order an event names is its customer's.
 * (The partner live channel's side: portal/notifications/notifications.vitest.test.ts.)
 */

const T = '0190a000-0000-7000-8000-000000000001'
const C1 = '0190a000-0000-7000-8000-0000000000c1'
const C2 = '0190a000-0000-7000-8000-0000000000c2'
const P1 = '0190a000-0000-7000-8000-0000000000b1'
const P2 = '0190a000-0000-7000-8000-0000000000b2'
const A1 = '0190a000-0000-7000-8000-0000000000a1'
const A2 = '0190a000-0000-7000-8000-0000000000a2'
const A3 = '0190a000-0000-7000-8000-0000000000a3'
const B1 = '0190a000-0000-7000-8000-0000000000a4'
const B2 = '0190a000-0000-7000-8000-0000000000a5'
const BATCH = '0190a000-0000-7000-8000-0000000000f1'
const BATCH_2 = '0190a000-0000-7000-8000-0000000000f2'
const PERSON = '0190a000-0000-7000-8000-0000000000e1'
const PERSON_2 = '0190a000-0000-7000-8000-0000000000e2'
const ISSUE = '0190a000-0000-7000-8000-0000000000e3'
const WO = '0190a000-0000-7000-8000-0000000000e4'
const SITE = '0190a000-0000-7000-8000-0000000000e5'

const BRAND_EVENTS = [
  'brand_production.stage_reached',
  'brand_production.health_changed',
  'brand_production.urgency_changed',
  'brand_production.supervisor_changed',
  'brand_production.hold_changed',
  'production_issue.raised',
  'production_issue.answered',
  'production_issue.escalated',
]
const HOLD_EVENTS = ['work_order_hold.placed', 'work_order_hold.lifted']

/** One payload of brand P1 per event. */
const OF_P1: Readonly<Record<string, Record<string, unknown>>> = {
  'brand_production.stage_reached': { orderId: A1, partyId: P1, stage: 'SEWING', previous: 'CUTTING' },
  'brand_production.health_changed': { orderId: A1, partyId: P1, health: 'LATE', previous: null, byNote: false },
  'brand_production.urgency_changed': { partyId: P1, orderIds: [A1, A2], urgency: 'REGULAR', by: 'FACTORY', change: 'LOCK', locked: true, undo: false, asked: false, batchId: BATCH },
  'brand_production.supervisor_changed': { partyId: P1, orderIds: [], supervisorId: PERSON, previousIds: [PERSON_2], backupId: PERSON_2, scope: 'BRAND', batchId: BATCH },
  'brand_production.hold_changed': { orderId: A1, partyId: P1, held: false, kind: 'BRAND' },
  'production_issue.raised': { issueId: ISSUE, partyId: P1, recordType: 'WorkOrder', recordId: WO, source: 'OFFICE', batchId: null },
  'production_issue.answered': { issueId: ISSUE, partyId: P1, source: 'OFFICE', salesOrderId: null, batchId: null, answeredInOrderId: null },
  'production_issue.escalated': { issueId: ISSUE, partyId: P1, batchId: BATCH, step: 2 },
  'work_order_hold.placed': { holdId: ISSUE, workOrderId: WO, number: 'WO-2026-0042', siteId: SITE, partyId: P1, kind: 'PRODUCTION', requestId: null },
  'work_order_hold.lifted': { holdId: ISSUE, workOrderId: WO, number: 'WO-2026-0042', siteId: SITE, partyId: P1, kind: 'BRAND', requestId: A3 },
}

const definitionOf = (type: string) => EVENT_CATALOGUE.get(type, 1)
const envelopeOf = (type: string, payload: unknown, companyId: string | null = C1): EventEnvelope => ({
  eventId: '0190a000-0000-7000-8000-0000000000d1',
  type,
  version: 1,
  context: definitionOf(type).context,
  tenantId: T,
  companyId,
  siteId: type.startsWith('work_order_hold.') ? SITE : null,
  subject: 'record-of-a-customer',
  correlationId: 'req-1',
  causationId: null,
  source: 'test',
  occurredAt: '2026-11-17T10:00:00.000Z',
  payload,
})
const messageOf = (type: string, payload: Record<string, unknown> = OF_P1[type]!) => liveMessageFor(envelopeOf(type, payload), definitionOf(type))!
/** An office person holding the event's live permission, over every customer or some. */
const officeOf = (type: string, parties: Grant['parties']): Actor => ({ audience: 'office', tenantId: T, grants: [{ permissions: [definitionOf(type).live!.permission], companies: 'all', sites: 'all', parties }] })

describe('the production events of a customer (B-PR-16)', () => {
  it('declares each once in its module with a strict payload; the brand ones show on the office screens of work orders only', () => {
    expect(events.map((definition) => definition.type)).toEqual(BRAND_EVENTS)
    for (const type of BRAND_EVENTS) {
      const definition = definitionOf(type)
      expect(definition.context, type).toBe('production-brand')
      expect(definition.live, type).toEqual(expect.objectContaining({ permission: 'workorders.view', floor: null }))
      expect(definition.live!.fields, `${type} copies its customer for the partner channel and the wall`).toContain('partyId')
    }
    for (const type of HOLD_EVENTS) {
      expect(definitionOf(type).context).toBe('production')
      expect(definitionOf(type).live).toEqual({ permission: 'workorders.view', floor: 'floor.work', fields: ['workOrderId', 'number', 'holdId', 'kind'] })
    }
    // The customer's urgency replaced its rank: the old event is gone.
    expect(EVENT_CATALOGUE.find('brand_production.ranked', 1)).toBeUndefined()
    expect(EVENT_CATALOGUE.types().filter((type) => type.startsWith('brand_production.')).sort()).toEqual(BRAND_EVENTS.filter((type) => type.startsWith('brand_production.')).sort())
  })

  it.each([...BRAND_EVENTS, ...HOLD_EVENTS])('%s carries ids, states and flags only: no name, amount, note or typed reason fits any key', (type) => {
    const definition = definitionOf(type)
    expect(() => EVENT_CATALOGUE.parse(type, 1, OF_P1[type])).not.toThrow()
    for (const [key, field] of Object.entries(definition.payload.shape)) {
      expect(isMoneyField(key), `${type}.${key}`).toBe(false)
      // The work order's number is a code (as every work order event's); nothing else takes free text.
      if (key === 'number') continue
      expect((field as { safeParse(value: unknown): { success: boolean } }).safeParse('Brand Alpha Spa').success, `${type}.${key}`).toBe(false)
      expect((field as { safeParse(value: unknown): { success: boolean } }).safeParse(['Brand Alpha Spa']).success, `${type}.${key}`).toBe(false)
    }
    // Never the office's note, an urgent place, the words of a lock or a typed reason (the customer reads them, if at all, from its own read).
    for (const key of ['healthNote', 'note', 'urgentRank', 'rank', 'lockReason', 'reason', 'reasonCode', 'brandWords', 'count', 'used']) expect(Object.keys(definition.payload.shape), `${type}.${key}`).not.toContain(key)
  })

  it('kinds: a hold mark counts quality holds and the plain ones', () => {
    expect(BRAND_HOLD_KINDS).toEqual(['QUALITY', ...WORK_ORDER_HOLD_KINDS])
  })
})

describe('the office live wall of the production events (B-PR-16, PW-15 events part)', () => {
  it.each(BRAND_EVENTS)("%s: a person limited to brand B never receives brand A's; A's own people and the production unit do", (type) => {
    const ofA = messageOf(type)
    expect(ofA.partyIds).toEqual([P1])
    expect(liveViewFor(ofA, officeOf(type, [P2]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(ofA, officeOf(type, [P1]), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(ofA, officeOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(ofA, officeOf(type, [P1]), EVENT_CATALOGUE)).not.toHaveProperty('partyIds')
    // Brand B's own reaches B's people; never a floor tablet.
    expect(liveViewFor(messageOf(type, { ...OF_P1[type], partyId: P2 }), officeOf(type, [P2]), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(ofA, { audience: 'floor', tenantId: T, siteId: SITE, grants: [{ permissions: ['floor.work', 'workorders.view'], companies: 'all', sites: 'all', parties: 'all' }] }, EVENT_CATALOGUE)).toBeNull()
  })

  it('supervisor_changed sends the office ids only: the customer, its orders, the person, the scope and the batch', () => {
    const view = liveViewFor(messageOf('brand_production.supervisor_changed', { partyId: P1, orderIds: [A1], supervisorId: PERSON, previousIds: [PERSON_2], backupId: null, scope: 'ORDER', batchId: BATCH }), officeOf('brand_production.supervisor_changed', 'all'), EVENT_CATALOGUE)
    expect(view?.fields).toEqual({ partyId: P1, orderIds: [A1], supervisorId: PERSON, scope: 'ORDER', batchId: BATCH })
  })

  it.each(HOLD_EVENTS)('%s names its work order\'s customer (null: none — every-customer viewers only) and reaches the tablets of its site', (type) => {
    const ofA = messageOf(type)
    expect(liveViewFor(ofA, officeOf(type, [P2]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(ofA, officeOf(type, [P1]), EVENT_CATALOGUE)).not.toBeNull()
    const ofNone = messageOf(type, { ...OF_P1[type], partyId: null })
    expect(liveViewFor(ofNone, officeOf(type, [P1]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(ofNone, officeOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
    const tablet: Actor = { audience: 'floor', tenantId: T, siteId: SITE, grants: [{ permissions: ['floor.work'], companies: 'all', sites: 'all', parties: 'all' }] }
    expect(liveViewFor(ofA, tablet, EVENT_CATALOGUE)?.fields).toEqual({ workOrderId: WO, number: 'WO-2026-0042', holdId: ISSUE, kind: OF_P1[type]!.kind })
    expect(liveViewFor(ofA, { ...tablet, siteId: C2 }, EVENT_CATALOGUE)).toBeNull()
  })
})

describe('one event per customer (B-PR-16 guard test; R-48, PW-P07, PW-15)', () => {
  /** A command over orders of two customers at two companies (B1 named twice), as its own read found them. */
  const MIXED: readonly PartyOrder[] = [
    { orderId: B1, companyId: C1, partyId: P2 },
    { orderId: A1, companyId: C1, partyId: P1 },
    { orderId: A3, companyId: C2, partyId: P1 },
    { orderId: B2, companyId: C1, partyId: P2 },
    { orderId: A2, companyId: C1, partyId: P1 },
    { orderId: B1, companyId: C1, partyId: P2 },
  ]
  const partyOf = new Map(MIXED.map((order) => [order.orderId, order.partyId]))

  it('splits the orders into one share per customer and company, each with its own orders only, each once, in a stable order', () => {
    expect(sharesPerParty(MIXED)).toEqual([
      { companyId: C1, partyId: P1, orderIds: [A1, A2] },
      { companyId: C1, partyId: P2, orderIds: [B1, B2] },
      { companyId: C2, partyId: P1, orderIds: [A3] },
    ])
    expect(sharesPerParty([])).toEqual([])
    expect(() => sharesPerParty([...MIXED, { orderId: A1, companyId: C1, partyId: P2 }])).toThrow(BrandEventWallError)
  })

  it('every orderId of each urgency_changed and supervisor_changed a command emits belongs to its partyId', () => {
    const shares = sharesPerParty(MIXED)
    const urgency = shares.map((share, index) => urgencyChangedEvent(share, { urgency: 'REGULAR', by: 'FACTORY', change: 'SET_BACK', locked: false, undo: false, asked: false, batchId: index === 0 ? BATCH : BATCH_2 }))
    const supervisor = shares.map((share) => supervisorChangedEvent(share, { supervisorId: PERSON, previousIds: [], backupId: null, scope: 'ORDER', batchId: BATCH }))
    expect(urgency).toHaveLength(3)
    expect(supervisor).toHaveLength(3)
    for (const event of [...urgency, ...supervisor]) {
      expect(namesOnlyItsParty(event.payload, partyOf), `${event.type} of ${event.payload.partyId}`).toBe(true)
      expect(() => assertOneParty(event.payload, partyOf)).not.toThrow()
      expect(() => EVENT_CATALOGUE.parse(event.type, event.version, event.payload)).not.toThrow()
      // The office live message names exactly that one customer.
      expect(liveMessageFor(envelopeOf(event.type, event.payload, event.companyId ?? null), definitionOf(event.type))?.partyIds).toEqual([event.payload.partyId])
    }
    expect(urgency.map((event) => [event.companyId, event.payload.partyId, event.payload.orderIds])).toEqual([
      [C1, P1, [A1, A2]],
      [C1, P2, [B1, B2]],
      [C2, P1, [A3]],
    ])
    expect(urgency.map((event) => event.subject)).toEqual([BATCH, BATCH_2, BATCH_2])
  })

  it('refuses an event that names an order of another customer, or one its read does not know', () => {
    const mixed = { partyId: P1, orderIds: [A1, B1] }
    expect(namesOnlyItsParty(mixed, partyOf)).toBe(false)
    expect(() => assertOneParty(mixed, partyOf)).toThrow(BrandEventWallError)
    expect(() => assertOneParty({ partyId: P1, orderIds: [A1, '0190a000-0000-7000-8000-0000000000ff'] }, partyOf)).toThrow(BrandEventWallError)
    expect(() => assertOneParty({ partyId: P2, orderIds: [B1, B2] }, partyOf)).not.toThrow()
    // A share handed over with an order of another customer is caught by the same guard before the emit.
    const forged = urgencyChangedEvent({ companyId: C1, partyId: P2, orderIds: [B1, A1] }, { urgency: 'URGENT', by: 'BRAND', change: 'MARK', locked: false, undo: false, asked: false, batchId: BATCH })
    expect(() => assertOneParty(forged.payload, partyOf)).toThrow(BrandEventWallError)
  })

  it("the customer's default supervisor names no order and no company; an order change names its orders", () => {
    const brand = supervisorChangedEvent({ companyId: null, partyId: P1, orderIds: [] }, { supervisorId: PERSON, previousIds: [PERSON_2], backupId: PERSON_2, scope: 'BRAND', batchId: BATCH })
    expect(brand.payload).toMatchObject({ partyId: P1, orderIds: [], scope: 'BRAND' })
    expect(brand.companyId).toBeNull()
    expect(() => EVENT_CATALOGUE.parse(brand.type, 1, brand.payload)).not.toThrow()
    expect(() => supervisorChangedEvent({ companyId: C1, partyId: P1, orderIds: [A1] }, { supervisorId: PERSON, previousIds: [], backupId: null, scope: 'BRAND', batchId: BATCH })).toThrow(BrandEventWallError)
    expect(() => supervisorChangedEvent({ companyId: C1, partyId: P1, orderIds: [] }, { supervisorId: PERSON, previousIds: [], backupId: null, scope: 'ORDER', batchId: BATCH })).toThrow(BrandEventWallError)
    // urgency_changed always names at least one order.
    expect(() => EVENT_CATALOGUE.parse('brand_production.urgency_changed', 1, { ...OF_P1['brand_production.urgency_changed'], orderIds: [] })).toThrow()
  })
})
