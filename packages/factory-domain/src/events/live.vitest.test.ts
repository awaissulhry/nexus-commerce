import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Actor, Grant } from '../core/permissions'
import { createCatalogue } from './catalogue'
import { defineEvent } from './define'
import type { EventEnvelope } from './envelope'
import { liveMessageFor, liveViewFor } from './live'
// B-PR-09: the brand wall of production's live messages.
import { EVENT_CATALOGUE } from './catalogue'
import { partyIdsOf } from './live'

const TENANT = '0190a000-0000-7000-8000-000000000001'
const OTHER_TENANT = '0190a000-0000-7000-8000-000000000002'
const COMPANY = '0190a000-0000-7000-8000-0000000000c1'
const OTHER_COMPANY = '0190a000-0000-7000-8000-0000000000c2'
const SITE = '0190a000-0000-7000-8000-0000000000a1'
const OTHER_SITE = '0190a000-0000-7000-8000-0000000000a2'

const scanAccepted = defineEvent({
  type: 'scan.accepted',
  context: 'production',
  description: 'A floor scan was accepted.',
  payload: z.strictObject({ bundleId: z.string(), operation: z.string(), pieceRate: z.string() }),
  live: { permission: 'production.read', floor: 'production.scan', fields: ['bundleId', 'operation'] },
})
// B-W2a-F5: the office reads (planning.view, quality.holds.view) no floor role holds; the floor's own permission.
const planPublished = defineEvent({
  type: 'plan.published',
  context: 'planning',
  description: 'A plan was published to the floor.',
  payload: z.strictObject({ planVersionId: z.string(), number: z.number() }),
  live: { permission: 'planning.view', floor: 'floor.work', fields: ['planVersionId', 'number'] },
})
const holdPlaced = defineEvent({
  type: 'hold.placed',
  context: 'quality',
  description: 'A hold was placed.',
  payload: z.strictObject({ holdId: z.string() }),
  live: { permission: 'quality.holds.view', floor: 'floor.work', fields: ['holdId'] },
})
const quoteSent = defineEvent({
  type: 'quote.sent',
  context: 'sales',
  description: 'A quote was sent.',
  payload: z.strictObject({ number: z.string(), totalMinor: z.number() }),
  live: { permission: 'quotes.read', fields: ['number'] },
})
const silent = defineEvent({ type: 'ledger.reconciled', context: 'inventory', description: 'x', payload: z.strictObject({}) })
// B-W2b-GF1 (G165): an order of one customer whose live rule does not copy the party (the message carries it anyway).
const orderConfirmed = defineEvent({
  type: 'order.confirmed',
  context: 'sales',
  description: 'An order was confirmed.',
  payload: z.strictObject({ orderId: z.string(), partyId: z.string() }),
  live: { permission: 'quotes.read', fields: ['orderId'] },
})
const termsChanged = defineEvent({
  type: 'terms.changed',
  context: 'sales',
  description: 'Payment terms shared by several customers changed.',
  payload: z.strictObject({ termsId: z.string(), partyIds: z.array(z.string()) }),
  live: { permission: 'quotes.read', fields: ['termsId'] },
})
const catalogue = createCatalogue([scanAccepted, planPublished, holdPlaced, quoteSent, silent, orderConfirmed, termsChanged])

const envelope = (definition: { type: string; version: number }, payload: unknown, scope: Partial<EventEnvelope> = {}): EventEnvelope => ({
  eventId: '0190a000-0000-7000-8000-0000000000e1',
  type: definition.type,
  version: definition.version,
  context: 'x',
  tenantId: TENANT,
  companyId: COMPANY,
  siteId: SITE,
  subject: 'subject-1',
  correlationId: 'req-1',
  causationId: null,
  source: 'x.y',
  occurredAt: '2026-10-28T09:00:00.000Z',
  payload,
  ...scope,
})

const all: Grant = { permissions: ['production.read', 'quotes.read', 'planning.view', 'quality.holds.view'], companies: 'all', sites: 'all', parties: 'all' }
/** What a floor role holds (auth/roles/templates.ts operator): floor permissions only, never the office reads. */
const floorRole: Grant = { permissions: ['floor.work', 'production.scan'], companies: 'all', sites: 'all', parties: 'all' }
const office = (grants: Grant[] = [all], tenantId = TENANT): Actor => ({ audience: 'office', tenantId, grants })
const floor = (siteId = SITE, grants: Grant[] = [floorRole]): Actor => ({ audience: 'floor', tenantId: TENANT, siteId, grants })

describe('liveMessageFor', () => {
  it('carries the scope and only the live fields, never money even if the payload has it', () => {
    const message = liveMessageFor(envelope(quoteSent, { number: 'Q-1', totalMinor: 990 }), quoteSent)
    expect(message).toEqual({
      tenantId: TENANT,
      eventId: '0190a000-0000-7000-8000-0000000000e1',
      type: 'quote.sent',
      version: 1,
      subject: 'subject-1',
      companyId: COMPANY,
      siteId: SITE,
      occurredAt: '2026-10-28T09:00:00.000Z',
      fields: { number: 'Q-1' },
      partyIds: [],
    })
  })

  it('is null for an event without a live rule, or a definition of another type', () => {
    expect(liveMessageFor(envelope(silent, {}), silent)).toBeNull()
    expect(liveMessageFor(envelope(quoteSent, {}), scanAccepted)).toBeNull()
  })
})

describe('liveViewFor', () => {
  const quote = liveMessageFor(envelope(quoteSent, { number: 'Q-1', totalMinor: 990 }), quoteSent)!
  const scan = liveMessageFor(envelope(scanAccepted, { bundleId: 'B1', operation: 'SEW', pieceRate: '0.120000' }), scanAccepted)!

  it('sends an office viewer the event without the tenant', () => {
    const { tenantId: _tenant, partyIds: _parties, ...rest } = quote
    expect(liveViewFor(quote, office(), catalogue)).toEqual(rest)
  })

  it('never sends another tenant\'s event', () => {
    expect(liveViewFor(quote, office([all], OTHER_TENANT), catalogue)).toBeNull()
    expect(liveViewFor({ ...scan, tenantId: OTHER_TENANT }, floor(), catalogue)).toBeNull()
  })

  it('needs the rule\'s permission for the event\'s company and site', () => {
    expect(liveViewFor(quote, office([{ ...all, permissions: ['production.read'] }]), catalogue)).toBeNull()
    expect(liveViewFor(quote, office([{ ...all, companies: [OTHER_COMPANY] }]), catalogue)).toBeNull()
    expect(liveViewFor(quote, office([{ ...all, companies: [COMPANY], sites: [SITE] }]), catalogue)).not.toBeNull()
  })

  it('sends the floor only floor events of its own site, without money fields', () => {
    expect(liveViewFor(quote, floor(), catalogue)).toBeNull()
    expect(liveViewFor(scan, floor(OTHER_SITE), catalogue)).toBeNull()
    expect(liveViewFor({ ...scan, siteId: null }, floor(), catalogue)).toBeNull()
    const view = liveViewFor({ ...scan, fields: { ...scan.fields, pieceRate: '0.120000', unitCost: '9.00' } }, floor(), catalogue)
    expect(view?.fields).toEqual({ bundleId: 'B1', operation: 'SEW' })
  })

  describe('the floor, through the rule\'s floor permission (B-W2a-F5)', () => {
    const plan = liveMessageFor(envelope(planPublished, { planVersionId: 'PV1', number: 2 }), planPublished)!
    const hold = liveMessageFor(envelope(holdPlaced, { holdId: 'H1' }), holdPlaced)!

    it('sends a floor viewer holding the floor permission the floor events of its own site', () => {
      const { tenantId: _plan, partyIds: _planParties, ...planView } = plan
      const { tenantId: _hold, partyIds: _holdParties, ...holdView } = hold
      expect(liveViewFor(plan, floor(), catalogue)).toEqual(planView)
      expect(liveViewFor(hold, floor(), catalogue)).toEqual(holdView)
      expect(liveViewFor(scan, floor(), catalogue)?.fields).toEqual({ bundleId: 'B1', operation: 'SEW' })
      // floor.work alone opens the plan and the hold, not the scan (its floor permission is production.scan).
      const workOnly = floor(SITE, [{ ...floorRole, permissions: ['floor.work'] }])
      expect(liveViewFor(plan, workOnly, catalogue)).toEqual(planView)
      expect(liveViewFor(scan, workOnly, catalogue)).toBeNull()
    })

    it('sends nothing about another site, or an event without a site', () => {
      expect(liveViewFor(plan, floor(OTHER_SITE), catalogue)).toBeNull()
      expect(liveViewFor(hold, floor(OTHER_SITE), catalogue)).toBeNull()
      expect(liveViewFor({ ...plan, siteId: null }, floor(), catalogue)).toBeNull()
      expect(liveViewFor(plan, { ...floor(), siteId: undefined }, catalogue)).toBeNull()
    })

    it('sends nothing of an office-only event, whatever the floor viewer holds', () => {
      expect(liveViewFor(quote, floor(), catalogue)).toBeNull()
      expect(liveViewFor(quote, floor(SITE, [all, floorRole]), catalogue)).toBeNull()
    })

    it('sends nothing to a floor viewer without the floor permission, even one holding the office read', () => {
      const officeReads = floor(SITE, [all])
      expect(liveViewFor(plan, officeReads, catalogue)).toBeNull()
      expect(liveViewFor(hold, officeReads, catalogue)).toBeNull()
      expect(liveViewFor(scan, officeReads, catalogue)).toBeNull()
      expect(liveViewFor(plan, floor(SITE, []), catalogue)).toBeNull()
      // The floor permission for another site does not reach this one.
      expect(liveViewFor(plan, floor(SITE, [{ ...floorRole, sites: [OTHER_SITE] }]), catalogue)).toBeNull()
    })

    it('still asks an office viewer the office permission, never the floor one', () => {
      expect(liveViewFor(plan, office(), catalogue)).not.toBeNull()
      expect(liveViewFor(plan, office([floorRole]), catalogue)).toBeNull()
      expect(liveViewFor(hold, office([{ ...all, sites: [OTHER_SITE] }]), catalogue)).toBeNull()
    })
  })

  describe('a viewer limited to some parties (B-W2b-GF1, G165)', () => {
    const P1 = '0190a000-0000-7000-8000-0000000000b1'
    const P2 = '0190a000-0000-7000-8000-0000000000b2'
    const rep = (parties: Grant['parties']): Actor => office([{ ...all, parties }])
    const order = (partyId: string) => liveMessageFor(envelope(orderConfirmed, { orderId: 'SO-1', partyId }), orderConfirmed)!

    it('carries the parties the payload names, even when the live rule copies none, and never sends them to the viewer', () => {
      expect(order(P2).partyIds).toEqual([P2])
      expect(order(P2).fields).toEqual({ orderId: 'SO-1' })
      expect(liveMessageFor(envelope(termsChanged, { termsId: 'T-1', partyIds: [P2, P1, 'not-a-uuid'] }), termsChanged)!.partyIds).toEqual([P1, P2])
      expect(liveViewFor(order(P1), rep([P1]), catalogue)).not.toHaveProperty('partyIds')
    })

    it("sends a rep their own parties' records only, never another party's record id", () => {
      expect(liveViewFor(order(P1), rep([P1]), catalogue)?.subject).toBe('subject-1')
      expect(liveViewFor(order(P2), rep([P1]), catalogue)).toBeNull()
      const list = liveMessageFor(envelope(termsChanged, { termsId: 'T-1', partyIds: [P1, P2] }), termsChanged)!
      expect(liveViewFor(list, rep([P1]), catalogue)).toBeNull()
      expect(liveViewFor(list, rep([P1, P2]), catalogue)).not.toBeNull()
    })

    it('sends a rep nothing that names no party (or comes from an older worker), and every party a viewer whose grant reaches all', () => {
      expect(liveViewFor(quote, rep([P1]), catalogue)).toBeNull()
      expect(liveViewFor({ ...order(P1), partyIds: undefined }, rep([P1]), catalogue)).toBeNull()
      expect(liveViewFor(quote, rep('all'), catalogue)).not.toBeNull()
      expect(liveViewFor(order(P2), rep('all'), catalogue)).not.toBeNull()
      // A grant over every party of ANOTHER company does not open this company's record to a party-limited one.
      expect(liveViewFor(order(P2), office([{ ...all, parties: [P1] }, { ...all, companies: [OTHER_COMPANY] }]), catalogue)).toBeNull()
    })
  })

  it('sends nothing for an undeclared or silent type, or to other audiences', () => {
    expect(liveViewFor({ ...quote, type: 'quote.unknown' }, office(), catalogue)).toBeNull()
    expect(liveViewFor({ ...quote, version: 2 }, office(), catalogue)).toBeNull()
    expect(liveViewFor({ ...quote, type: 'ledger.reconciled' }, office(), catalogue)).toBeNull()
    expect(liveViewFor(quote, { audience: 'partner', tenantId: TENANT, partyId: COMPANY, grants: [all] }, catalogue)).toBeNull()
    expect(liveViewFor(quote, { audience: 'system', tenantId: TENANT, grants: [all] }, catalogue)).toBeNull()
  })
})

// ── B-PR-09 ──
/**
 * B-PR-09 (production plan §2, the brand wall; PW-04): production's live messages name their customer, so an office person
 * limited to brand B never receives a message about brand A's work order, cut, bundle, rework, scrap, hold or inspection, and a
 * message of several brands reaches only who reaches every one of them. The production unit (every customer) receives them all.
 */
describe('production events name their customer (B-PR-09, PW-04)', () => {
  const P1 = '0190a000-0000-7000-8000-0000000000b1'
  const P2 = '0190a000-0000-7000-8000-0000000000b2'
  /** One work order's events: `partyId`, the work order's one customer (null: none). */
  const ONE = [
    'workorder.created',
    'workorder.changed',
    'workorder.priority_changed',
    'workorder.released',
    'workorder.status_changed',
    'workorder.finished_to_stock',
    'workorder.finished_reversed',
    'production.cut_logged',
    'production.hide_closed',
    'production.cut_reversed',
    'production.bundle_created',
    'production.bundle_reprinted',
    'production.bundle_voided',
    'production.rework_opened',
    'production.rework_moved',
    'production.replacement_requested',
    'production.replacement_changed',
    'production.scrap_posted',
    'quality.inspection_opened',
    'quality.inspection_decided',
    'quality.inspection_cancelled',
    'quality.inspection_assigned',
    'quality.inspection_sampling_set',
    'quality.garments_released',
    'quality.release_reversed',
    'final_inspection.recorded',
  ]
  /** Shared records' events: `partyIds`, the customers of the work orders they serve. */
  const SEVERAL = ['cut_order.changed', 'cut_ticket.changed', 'ply_run.changed', 'quality.hold_placed', 'quality.hold_released', 'quality.hold_changed']
  const definitionOf = (type: string) => EVENT_CATALOGUE.get(type, 1)
  /** An office person holding the event's live permission, over every customer or some. */
  const viewerOf = (type: string, parties: Grant['parties']): Actor => office([{ permissions: [definitionOf(type).live!.permission], companies: 'all', sites: 'all', parties }])
  const messageOf = (type: string, payloadParty: Record<string, unknown>) => {
    const definition = definitionOf(type)
    return { ...liveMessageFor(envelope(definition, payloadParty), definition)!, subject: 'record-of-a-brand' }
  }

  it('partyIdsOf: each customer once, sorted; none as soon as one part names no customer', () => {
    expect(partyIdsOf([P2, P1, P2])).toEqual([P1, P2])
    expect(partyIdsOf([P1, null])).toEqual([])
    expect(partyIdsOf([P1, undefined])).toEqual([])
    expect(partyIdsOf([P1, 'not-an-id'])).toEqual([])
    expect(partyIdsOf([])).toEqual([])
  })

  it.each(ONE)('%s declares an optional, nullable partyId (an id only) and shows on the office screens', (type) => {
    const definition = definitionOf(type)
    const field = definition.payload.shape.partyId
    expect(field, `${type} names its work order's customer`).toBeDefined()
    expect(field!.safeParse(P1).success).toBe(true)
    expect(field!.safeParse(null).success).toBe(true)
    expect(field!.safeParse(undefined).success).toBe(true)
    expect(field!.safeParse('Seed Racing').success).toBe(false)
    expect(definition.live).not.toBeNull()
  })

  it.each(SEVERAL)('%s declares an optional list partyIds (ids only)', (type) => {
    const field = definitionOf(type).payload.shape.partyIds
    expect(field, `${type} names the customers it serves`).toBeDefined()
    expect(field!.safeParse([P1, P2]).success).toBe(true)
    expect(field!.safeParse([]).success).toBe(true)
    expect(field!.safeParse(undefined).success).toBe(true)
    expect(field!.safeParse(['Seed Racing']).success).toBe(false)
  })

  it.each(ONE)("%s: a person limited to brand B never receives brand A's; B's own reaches them; the production unit gets both", (type) => {
    const ofA = messageOf(type, { partyId: P1 })
    const ofB = messageOf(type, { partyId: P2 })
    const ofNone = messageOf(type, { partyId: null })
    expect(ofA.partyIds).toEqual([P1])
    expect(liveViewFor(ofA, viewerOf(type, [P2]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(ofB, viewerOf(type, [P2]), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(ofA, viewerOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
    // A work order of no customer (one mixed before the rule): every-customer viewers only.
    expect(liveViewFor(ofNone, viewerOf(type, [P1]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(ofNone, viewerOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
    // The view never carries the parties.
    expect(liveViewFor(ofB, viewerOf(type, [P2]), EVENT_CATALOGUE)).not.toHaveProperty('partyIds')
  })

  it.each(SEVERAL)('%s: a message of two brands reaches only who reaches both; one part of no customer: every-customer viewers only', (type) => {
    const both = messageOf(type, { partyIds: [P1, P2] })
    expect(liveViewFor(both, viewerOf(type, [P2]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(both, viewerOf(type, [P1]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(both, viewerOf(type, [P1, P2]), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(both, viewerOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(messageOf(type, { partyIds: [P2] }), viewerOf(type, [P2]), EVENT_CATALOGUE)).not.toBeNull()
    const unnamed = messageOf(type, { partyIds: partyIdsOf([P2, null]) })
    expect(liveViewFor(unnamed, viewerOf(type, [P2]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(unnamed, viewerOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
  })
})
// ── end B-PR-09 ──

// ── B-SA-001 ──
/**
 * B-SA-001 (Sales page plan P17'; 13-backend B13a): every sales_order.* event, and the order's customer materials, name the
 * order's customer (`partyId`, set by the emitter from the order row), so an office person limited to some customers gets the
 * live messages of their customers' orders (it failed closed before: they got none). The rule is the B-PR-09 one: a person
 * limited to Brand Beta never receives Brand Alpha's message; an event that names no customer (an older worker's) reaches only
 * people of every customer; the party ids never reach the browser.
 */
describe('order events name their customer (B-SA-001)', () => {
  const ALPHA = '0190a000-0000-7000-8000-0000000000b1'
  const BETA = '0190a000-0000-7000-8000-0000000000b2'
  /** Every sales_order.* type the catalogue declares (a new one is held to the rule by itself), and the materials event. */
  const ORDER_EVENTS = [...EVENT_CATALOGUE.types().filter((type) => type.startsWith('sales_order.')), 'customer_material.changed']
  const definitionOf = (type: string) => EVENT_CATALOGUE.get(type, 1)
  const viewerOf = (type: string, parties: Grant['parties']): Actor => office([{ permissions: [definitionOf(type).live!.permission], companies: 'all', sites: 'all', parties }])
  const messageOf = (type: string, payload: Record<string, unknown>) => {
    const definition = definitionOf(type)
    return { ...liveMessageFor(envelope(definition, payload), definition)!, subject: 'an-order-of-a-brand' }
  }

  it('covers the order events of every module (status, promise, amended, lines, schedule, priced, decided, depth, options)', () => {
    expect(ORDER_EVENTS).toEqual(expect.arrayContaining(['sales_order.status_changed', 'sales_order.promise_changed', 'sales_order.amended', 'sales_order.lines_closed', 'sales_order.schedule_changed', 'sales_order.change_priced', 'sales_order.change_decided', 'sales_order.priority_changed', 'sales_order.season_changed', 'sales_order.split', 'sales_order.confirmation_made', 'sales_order.confirmation_sent', 'sales_order.options_changed']))
  })

  it.each(ORDER_EVENTS)('%s declares partyId (an id only, optional for an older event) and never copies it to the browser', (type) => {
    const definition = definitionOf(type)
    const field = definition.payload.shape.partyId
    expect(field, `${type} names its order's customer`).toBeDefined()
    expect(field!.safeParse(ALPHA).success).toBe(true)
    expect(field!.safeParse('Brand Alpha').success).toBe(false)
    // sales_order.created always named it; the others take it from B-SA-001 on, so an event written before still parses.
    if (type !== 'sales_order.created') expect(field!.safeParse(undefined).success).toBe(true)
    expect(definition.live?.permission).toBe('orders.view')
    expect(definition.live!.fields ?? []).not.toContain('partyId')
  })

  it.each(ORDER_EVENTS)("%s: a person limited to Brand Beta never receives Brand Alpha's; Beta's reaches them; every customer gets both", (type) => {
    const ofAlpha = messageOf(type, { orderId: 'SO-A', partyId: ALPHA })
    const ofBeta = messageOf(type, { orderId: 'SO-B', partyId: BETA })
    expect(ofAlpha.partyIds).toEqual([ALPHA])
    expect(liveViewFor(ofAlpha, viewerOf(type, [BETA]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(ofBeta, viewerOf(type, [BETA]), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(ofAlpha, viewerOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(ofBeta, viewerOf(type, [BETA]), EVENT_CATALOGUE)).not.toHaveProperty('partyIds')
    expect(liveViewFor(ofBeta, viewerOf(type, [BETA]), EVENT_CATALOGUE)!.fields).not.toHaveProperty('partyId')
  })

  it.each(ORDER_EVENTS)('%s without a party (an event of an older worker): every-customer viewers only (fails closed)', (type) => {
    const older = messageOf(type, { orderId: 'SO-OLD' })
    expect(older.partyIds).toEqual([])
    expect(liveViewFor(older, viewerOf(type, [ALPHA]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(older, viewerOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
  })
})
// ── end B-SA-001 ──

// ── B-SA-002 ──
/**
 * B-SA-002 (Sales page plan P17'; 13-backend B13a): a message, a follow and a file of a record name its customer (`partyId`: the
 * thread's party, or a work order's, hold's or NCR's wall party; none for several customers or none), so an office person
 * limited to some customers gets the live hint of their own customers' threads and files, and never another customer's.
 */
describe('thread, follower and file events name their record’s customer (B-SA-002)', () => {
  const ALPHA = '0190a000-0000-7000-8000-0000000000b1'
  const BETA = '0190a000-0000-7000-8000-0000000000b2'
  const TYPES = ['thread.message_posted', 'thread.followers_changed', 'file.available']
  const definitionOf = (type: string) => EVENT_CATALOGUE.get(type, 1)
  const viewerOf = (type: string, parties: Grant['parties']): Actor => office([{ permissions: [definitionOf(type).live!.permission], companies: 'all', sites: 'all', parties }])
  const messageOf = (type: string, payload: Record<string, unknown>) => {
    const definition = definitionOf(type)
    return { ...liveMessageFor(envelope(definition, payload), definition)!, subject: 'a-record-of-a-brand' }
  }

  it.each(TYPES)('%s declares an optional, nullable partyId (an id only), never in the live fields', (type) => {
    const definition = definitionOf(type)
    const field = definition.payload.shape.partyId
    expect(field, `${type} names its record's customer`).toBeDefined()
    expect(field!.safeParse(ALPHA).success).toBe(true)
    expect(field!.safeParse(null).success).toBe(true)
    expect(field!.safeParse(undefined).success).toBe(true)
    expect(field!.safeParse('Brand Alpha').success).toBe(false)
    expect(definition.live!.fields ?? []).not.toContain('partyId')
  })

  it.each(TYPES)("%s with a party: a person limited to Brand Beta never receives Brand Alpha's; Beta's reaches them; every customer gets both", (type) => {
    const ofAlpha = messageOf(type, { recordType: 'SalesOrder', recordId: 'SO-A', partyId: ALPHA })
    const ofBeta = messageOf(type, { recordType: 'SalesOrder', recordId: 'SO-B', partyId: BETA })
    expect(liveViewFor(ofAlpha, viewerOf(type, [BETA]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(ofBeta, viewerOf(type, [BETA]), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(ofAlpha, viewerOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(ofBeta, viewerOf(type, [BETA]), EVENT_CATALOGUE)).not.toHaveProperty('partyIds')
  })

  it.each(TYPES)('%s without a party (a record of several customers or none, or an older event): every-customer viewers only', (type) => {
    for (const payload of [{ recordType: 'WorkOrder', recordId: 'WO-MIX', partyId: null }, { recordType: 'WorkOrder', recordId: 'WO-OLD' }]) {
      const none = messageOf(type, payload)
      expect(none.partyIds).toEqual([])
      expect(liveViewFor(none, viewerOf(type, [ALPHA]), EVENT_CATALOGUE)).toBeNull()
      expect(liveViewFor(none, viewerOf(type, [ALPHA, BETA]), EVENT_CATALOGUE)).toBeNull()
      expect(liveViewFor(none, viewerOf(type, 'all'), EVENT_CATALOGUE)).not.toBeNull()
    }
  })
})
// ── end B-SA-002 ──

// ── B-SA-003 ──
/** B-SA-003 (Sales page plan P17'; review BW-7): a scan names its work order's customer for the office's live wall only. */
describe('a scan names its work order’s customer (B-SA-003)', () => {
  const ALPHA = '0190a000-0000-7000-8000-0000000000b1'
  const BETA = '0190a000-0000-7000-8000-0000000000b2'
  const definition = EVENT_CATALOGUE.get('production.scan_recorded', 1)
  const viewer = (parties: Grant['parties']): Actor => office([{ permissions: [definition.live!.permission], companies: 'all', sites: 'all', parties }])
  const scan = (partyId?: string | null) => liveMessageFor(envelope(definition, { workOrderId: 'WO-1', number: 'WO-1', bundleId: 'B-1', ...(partyId === undefined ? {} : { partyId }) }), definition)!

  it('declares an optional, nullable partyId, never in the live fields', () => {
    const field = definition.payload.shape.partyId
    expect(field).toBeDefined()
    for (const value of [ALPHA, null, undefined]) expect(field!.safeParse(value).success).toBe(true)
    expect(field!.safeParse('Brand Alpha').success).toBe(false)
    expect(definition.live!.fields ?? []).not.toContain('partyId')
  })

  it("a person limited to Brand Beta gets no scan of Alpha's work order and does get Beta's; a work order of no customer reaches every customer only", () => {
    expect(liveViewFor(scan(ALPHA), viewer([BETA]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(scan(BETA), viewer([BETA]), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(scan(ALPHA), viewer('all'), EVENT_CATALOGUE)).not.toBeNull()
    for (const none of [scan(null), scan()]) {
      expect(liveViewFor(none, viewer([ALPHA]), EVENT_CATALOGUE)).toBeNull()
      expect(liveViewFor(none, viewer('all'), EVENT_CATALOGUE)).not.toBeNull()
    }
    expect(liveViewFor(scan(BETA), viewer([BETA]), EVENT_CATALOGUE)!.fields).toEqual({ workOrderId: 'WO-1', number: 'WO-1', bundleId: 'B-1' })
  })
})
// ── end B-SA-003 ──
