import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Actor, Grant } from '../core/permissions'
import { createCatalogue } from './catalogue'
import { defineEvent } from './define'
import type { EventEnvelope } from './envelope'
import { liveMessageFor, liveViewFor } from './live'

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
const catalogue = createCatalogue([scanAccepted, planPublished, holdPlaced, quoteSent, silent])

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
    const { tenantId: _tenant, ...rest } = quote
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
      const { tenantId: _plan, ...planView } = plan
      const { tenantId: _hold, ...holdView } = hold
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

  it('sends nothing for an undeclared or silent type, or to other audiences', () => {
    expect(liveViewFor({ ...quote, type: 'quote.unknown' }, office(), catalogue)).toBeNull()
    expect(liveViewFor({ ...quote, version: 2 }, office(), catalogue)).toBeNull()
    expect(liveViewFor({ ...quote, type: 'ledger.reconciled' }, office(), catalogue)).toBeNull()
    expect(liveViewFor(quote, { audience: 'partner', tenantId: TENANT, partyId: COMPANY, grants: [all] }, catalogue)).toBeNull()
    expect(liveViewFor(quote, { audience: 'system', tenantId: TENANT, grants: [all] }, catalogue)).toBeNull()
  })
})
