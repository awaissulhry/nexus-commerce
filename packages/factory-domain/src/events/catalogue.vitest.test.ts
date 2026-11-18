import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue' // B-SA-004c
import { ROLE_TEMPLATES } from '../auth/roles/templates'
import { createCatalogue, EVENT_CATALOGUE, EVENT_DEFINITIONS, EventPayloadError, UndeclaredEventError } from './catalogue'
import { defineEvent, /* B-SA-004c */ isFloorPermission, /* S7 end check: the helpers below take a catalogue's get() too */ type EventDefinition } from './define'
import { LIVE_PARTY_KEYS } from './live' // B-SA-004

const v1 = defineEvent({ type: 'lot.released', context: 'quality', description: 'A lot was released.', payload: z.strictObject({ lotId: z.string() }) })
const v2 = defineEvent({
  type: 'lot.released',
  version: 2,
  context: 'quality',
  description: 'A lot was released, with who signed.',
  payload: z.strictObject({ lotId: z.string(), signedBy: z.string() }),
})
const other = defineEvent({ type: 'ddt.issued', context: 'shipping', description: 'A DDT was issued.', payload: z.strictObject({ ddtId: z.string() }) })

describe('createCatalogue', () => {
  const catalogue = createCatalogue([v2, other, v1])

  it('finds each version of each type, sorted', () => {
    expect(catalogue.definitions.map((definition) => `${definition.type}@${definition.version}`)).toEqual(['ddt.issued@1', 'lot.released@1', 'lot.released@2'])
    expect(catalogue.types()).toEqual(['ddt.issued', 'lot.released'])
    expect(catalogue.get('lot.released', 2)).toBe(v2)
    expect(catalogue.find('lot.released', 3)).toBeUndefined()
  })

  it('refuses an undeclared type or version', () => {
    expect(() => catalogue.get('lot.scrapped', 1)).toThrow(UndeclaredEventError)
    expect(() => catalogue.get('lot.released', 3)).toThrow(/"lot.released" version 3 is not declared/)
    expect(() => catalogue.parse('lot.scrapped', 1, {})).toThrow(UndeclaredEventError)
  })

  it('parses a payload strictly: a missing or unknown key is refused', () => {
    expect(catalogue.parse('lot.released', 1, { lotId: 'L1' })).toEqual({ lotId: 'L1' })
    expect(() => catalogue.parse('lot.released', 1, { lotId: 'L1', extra: true })).toThrow(EventPayloadError)
    expect(() => catalogue.parse('lot.released', 2, { lotId: 'L1' })).toThrow(/signedBy/)
  })

  it('refuses a type and version declared twice, or one type in two modules', () => {
    expect(() => createCatalogue([v1, v1])).toThrow(/declared twice/)
    const elsewhere = defineEvent({ type: 'lot.released', version: 3, context: 'inventory', description: 'x', payload: z.strictObject({}) })
    expect(() => createCatalogue([v1, elsewhere])).toThrow(/declared by two modules/)
  })
})

describe('EVENT_CATALOGUE', () => {
  const src = fileURLToPath(new URL('..', import.meta.url))

  it('is built from EVENT_DEFINITIONS', () => {
    expect(EVENT_CATALOGUE.definitions).toHaveLength(EVENT_DEFINITIONS.length)
  })

  it('assembles every module events file (src/<module>/events.ts)', () => {
    const catalogueSource = readFileSync(join(src, 'events', 'catalogue.ts'), 'utf8')
    const modules = readdirSync(src, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(src, entry.name, 'events.ts')))
      .map((entry) => entry.name)
    for (const module of modules) expect(catalogueSource, `src/${module}/events.ts`).toContain(`from '../${module}/events'`)
  })

  // B-W2a-F5: a live rule's floor permission is one a floor role really holds, so the floor events reach a tablet.
  it('names, on every rule that reaches the floor, a permission a floor role template holds', () => {
    const heldOnTheFloor = new Set(ROLE_TEMPLATES.filter((template) => template.audience === 'floor').flatMap((template) => template.permissions))
    const floorRules = EVENT_CATALOGUE.definitions.filter((definition) => definition.live?.floor)
    expect(floorRules.length).toBeGreaterThan(0)
    for (const definition of floorRules) expect(heldOnTheFloor.has(definition.live!.floor!), `${definition.type}: ${definition.live!.floor}`).toBe(true)
  })

  it('sends My work and the station screens what they listen to (floor.work; the machine card plant.report)', () => {
    const floorOf = (type: string) => EVENT_CATALOGUE.find(type, 1)?.live?.floor
    for (const type of ['planning.schedule_published', 'production.scan_recorded', 'quality.hold_placed', 'quality.hold_released', 'workorder.status_changed']) {
      expect(floorOf(type), type).toBe('floor.work')
    }
    expect(floorOf('machine.status_changed')).toBe('plant.report')
    expect(floorOf('quality.inspection_decided')).toBe('quality.inspections.view')
  })
})

// ── B-SA-004 ──
/**
 * B-SA-004 (Sales page plan P17'; 13-backend B13a): the office's live wall (events/live.ts reachesParties) sends a person limited
 * to some customers only a message that names their customer; a message that names none reaches people of every customer only.
 * So every event an order's readers get live — its live rule is orders.view, or it names an order (orderId, salesOrderId) — and
 * every live event of the families the order page re-reads on (shipments, re-promises, deposit requests, payments, invoices)
 * declares a party key (LIVE_PARTY_KEYS), set by its emitter from the record read on the server. A new event of these is held
 * to the rule by itself.
 */
describe('order events declare their customer (B-SA-004)', () => {
  /** Records of the company that no customer owns: their live message reaches people of every customer only, by design. */
  const NO_CUSTOMER: Readonly<Record<string, string>> = { 'season.changed': "a season is the company's own, of no customer" }
  const keysOf = (definition: EventDefinition): string[] => Object.keys(definition.payload.shape)
  const namesAnOrder = (definition: EventDefinition): boolean => keysOf(definition).some((key) => key === 'orderId' || key === 'salesOrderId')
  const namesAParty = (definition: EventDefinition): boolean => keysOf(definition).some((key) => (LIVE_PARTY_KEYS as readonly string[]).includes(key))
  const FAMILIES = /^(shipment|order_promise|deposit_request|payment|invoice)\./

  it('every event shown to orders.view, or that names an order, declares a party key', () => {
    const missing = EVENT_DEFINITIONS.filter((definition) => (definition.live?.permission === 'orders.view' || namesAnOrder(definition)) && !Object.hasOwn(NO_CUSTOMER, definition.type) && !namesAParty(definition)).map((definition) => definition.type)
    expect(missing).toEqual([])
  })

  it('every live event of the shipments, re-promises, deposit requests, payments and invoices declares a party key', () => {
    const missing = EVENT_DEFINITIONS.filter((definition) => FAMILIES.test(definition.type) && definition.live && !namesAParty(definition)).map((definition) => definition.type)
    expect(missing).toEqual([])
  })

  it('an exemption is real: it names no order and no party, and still is a declared event', () => {
    for (const type of Object.keys(NO_CUSTOMER)) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      expect(namesAnOrder(definition), type).toBe(false)
      expect(namesAParty(definition), type).toBe(false)
    }
  })

  it('the keys this step added are ids only (optional, nullable) and never copied to the browser', () => {
    const ADDED = [
      'order_promise.proposed', 'order_promise.decided', 'order_promise.recorded',
      ...EVENT_DEFINITIONS.filter((definition) => definition.type.startsWith('shipment.') && definition.live).map((definition) => definition.type),
      'invoice.draft_saved', 'invoice.draft_deleted', 'invoice.files_attached', 'invoice.sdi_status_changed', 'invoice.sdi_notification_received', 'invoice.sdi_corrected', 'invoice.sdi_archived', 'invoice.courtesy_copy_queued', 'invoice.courtesy_copy_missing',
      'payment.allocated', 'payment.allocation_reversed', 'payment.voided',
      'deposit_cancellation.decided', 'fee_credit.changed', 'remake_order.made', 'return.replacement_ordered',
    ]
    for (const type of ADDED) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      const field = definition.payload.shape.partyId
      expect(field, type).toBeDefined()
      expect(field!.safeParse('0190a000-0000-7000-8000-0000000000b1').success, type).toBe(true)
      expect(field!.safeParse(null).success, type).toBe(true)
      expect(field!.safeParse(undefined).success, type).toBe(true)
      expect(field!.safeParse('Brand Alpha').success, type).toBe(false)
      expect(definition.live!.fields ?? [], type).not.toContain('partyId')
    }
  })
})
// ── end B-SA-004 ──

// ── B-SA-004b ──
/**
 * B-SA-004b (Sales page plan P17'; the rest of B-SA-004): the same rule for quotes, returns and repairs, and for the events that
 * name several orders. Every event shown to quotes.view, sales.returns.view, sales.repairs.view or orders.view, and every event
 * that names a quote, a customer return, a repair, an order or several orders (quoteId, returnId, repairId, orderId,
 * salesOrderId, orderIds) declares a party key (LIVE_PARTY_KEYS), set by its emitter from the record read on the server — so an
 * office person limited to some customers is sent their own customers' quote, return and repair changes live, and never another
 * customer's. A record of the company that no customer owns
 * is named below with its reason; a new event of these is held to the rule by itself.
 */
describe('quote, return, repair and order events declare their customer (B-SA-004b)', () => {
  const NO_CUSTOMER: Readonly<Record<string, string>> = {
    'season.changed': "a season is the company's own, of no customer",
    'sales_settings.changed': "the company's (or the tenant's) quote rules, of no customer",
    'quote_template.changed': "a quote template is the company's start of quotes, of no customer",
    'size_curve.changed': "a size curve is the company's own, of no customer",
    'return_policy.changed': "the company's (or the tenant's) return policy, of no customer",
    'return_policy.saved': "the company's return policy for a channel, of no customer",
    'return_fee_rule.changed': "the company's restocking or handling fee rule, of no customer",
    'inventory.returned': "its returnId is stock that came back from a work order to a store location, not a customer's return",
  }
  const RULES = new Set(['quotes.view', 'sales.returns.view', 'sales.repairs.view', 'orders.view'])
  const NAMES = ['quoteId', 'returnId', 'repairId', 'orderId', 'salesOrderId', 'orderIds']
  const FAMILY = /^(quote|return|repair|repair_estimate)\./
  const keysOf = (definition: EventDefinition): string[] => Object.keys(definition.payload.shape)
  const namesARecord = (definition: EventDefinition): boolean => keysOf(definition).some((key) => NAMES.includes(key))
  const namesAParty = (definition: EventDefinition): boolean => keysOf(definition).some((key) => (LIVE_PARTY_KEYS as readonly string[]).includes(key))
  const ruled = (definition: EventDefinition): boolean => RULES.has(definition.live?.permission ?? '') || namesARecord(definition)

  it('every event shown to quotes.view, sales.returns.view, sales.repairs.view or orders.view, or that names a quote, a return, a repair or orders, declares a party key', () => {
    const missing = EVENT_DEFINITIONS.filter((definition) => ruled(definition) && !Object.hasOwn(NO_CUSTOMER, definition.type) && !namesAParty(definition)).map((definition) => definition.type)
    expect(missing).toEqual([])
  })

  it('every quote.*, return.*, repair.* and repair_estimate.* event declares a party key (no exemption in these families)', () => {
    const missing = EVENT_DEFINITIONS.filter((definition) => FAMILY.test(definition.type) && !namesAParty(definition)).map((definition) => definition.type)
    expect(missing).toEqual([])
  })

  it('an exemption is real: a declared event that names no party, and none is of these families', () => {
    for (const type of Object.keys(NO_CUSTOMER)) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      expect(namesAParty(definition), type).toBe(false)
      expect(type, type).not.toMatch(FAMILY)
    }
  })

  it('the keys this step added are ids only (optional, nullable) and never copied to the browser', () => {
    const ADDED = [
      'quote.updated', 'quote.lines_changed', 'quote.approval_requested', 'quote.approval_decided', 'quote.reopened', 'quote.cancelled', 'quote.sent', 'quote.link_sent', 'quote.revised', 'quote.declined', 'quote.link_requested', 'quote.proofs_changed', 'quote.expired', 'quote.reminder_sent', 'quote.season_changed',
      'return.lines_changed', 'return.changed', 'return.received', 'return.graded', 'return.decided', 'return.status_changed', 'return.remake_asked', 'return.line_split', 'return.sent_back', 'return.finished', 'return.policy_checked', 'return.garment_named', 'return.scan_code_set', 'return_label.changed',
      'repair.changed', 'repair.stage_changed', 'repair.safety_checked', 'repair_estimate.withdrawn',
    ]
    for (const type of ADDED) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      const field = definition.payload.shape.partyId
      expect(field, type).toBeDefined()
      expect(field!.safeParse('0190a000-0000-7000-8000-0000000000b1').success, type).toBe(true)
      expect(field!.safeParse(null).success, type).toBe(true)
      expect(field!.safeParse(undefined).success, type).toBe(true)
      expect(field!.safeParse('Brand Alpha').success, type).toBe(false)
      expect(definition.live!.fields ?? [], type).not.toContain('partyId')
    }
  })

  it('backlog.ranked names its orders’ customers as a list of ids (optional for an older event), never copied to the browser', () => {
    const definition = EVENT_CATALOGUE.get('backlog.ranked', 1)
    const field = definition.payload.shape.partyIds
    expect(field).toBeDefined()
    expect(field!.safeParse(['0190a000-0000-7000-8000-0000000000b1', '0190a000-0000-7000-8000-0000000000b2']).success).toBe(true)
    expect(field!.safeParse([]).success).toBe(true)
    expect(field!.safeParse(undefined).success).toBe(true)
    expect(field!.safeParse(['Brand Alpha']).success).toBe(false)
    expect(definition.live!.fields ?? []).not.toContain('partyIds')
  })
})
// ── end B-SA-004b ──

// ── B-SA-004c ──
/**
 * B-SA-004c: a live rule's second office permission (`also`, events/define.ts) is a declared permission other than its first,
 * never a floor one; the work order changes name it (their read: orders.view OR workorders.view, production
 * work-order-changes/read.ts), and still name their customer, so the second permission widens no customer wall.
 */
describe('a second office permission on a live rule (B-SA-004c)', () => {
  const withAlso = EVENT_DEFINITIONS.filter((definition) => definition.live?.also !== undefined)

  it('the work order changes name orders.view and also workorders.view, with their customer', () => {
    const changes = EVENT_DEFINITIONS.filter((definition) => definition.type.startsWith('work_order_change.'))
    expect(changes.map((definition) => definition.type).sort()).toEqual(['work_order_change.applied', 'work_order_change.declined', 'work_order_change.proposed', 'work_order_change.stale'])
    for (const definition of changes) {
      expect(definition.live, definition.type).toMatchObject({ permission: 'orders.view', also: 'workorders.view', floor: null })
      expect(Object.keys(definition.payload.shape), definition.type).toContain('partyId')
      expect(definition.live!.fields, definition.type).not.toContain('partyId')
    }
  })

  it('every `also` is a declared office permission, other than the rule’s first, and its event names a party key', () => {
    expect(withAlso.length).toBeGreaterThan(0)
    for (const definition of withAlso) {
      const also = definition.live!.also!
      expect(FACTORY_PERMISSIONS.isDeclared(also), `${definition.type}: ${also}`).toBe(true)
      expect(also, definition.type).not.toBe(definition.live!.permission)
      expect(isFloorPermission(also), `${definition.type}: ${also} is the floor's`).toBe(false)
      expect(Object.keys(definition.payload.shape).some((key) => (LIVE_PARTY_KEYS as readonly string[]).includes(key)), definition.type).toBe(true)
    }
  })
})
// ── end B-SA-004c ──
