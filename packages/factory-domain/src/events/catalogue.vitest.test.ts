import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ROLE_TEMPLATES } from '../auth/roles/templates'
import { createCatalogue, EVENT_CATALOGUE, EVENT_DEFINITIONS, EventPayloadError, UndeclaredEventError } from './catalogue'
import { defineEvent } from './define'
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
  const keysOf = (definition: (typeof EVENT_DEFINITIONS)[number]): string[] => Object.keys(definition.payload.shape)
  const namesAnOrder = (definition: (typeof EVENT_DEFINITIONS)[number]): boolean => keysOf(definition).some((key) => key === 'orderId' || key === 'salesOrderId')
  const namesAParty = (definition: (typeof EVENT_DEFINITIONS)[number]): boolean => keysOf(definition).some((key) => (LIVE_PARTY_KEYS as readonly string[]).includes(key))
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
