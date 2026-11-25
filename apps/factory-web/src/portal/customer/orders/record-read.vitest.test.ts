import { describe, expect, it } from 'vitest'
import { forbiddenKeysIn } from '@nexus/factory-domain/production-brand/portal-read'
import { changeRequestSchema, impactReadSchema, orderRecordSchema, requestsSchema, rulesSchema } from './api'
import { orderRecord, requestsOf, rulesOf } from './design-data'
import { shipToLines } from './model'

/**
 * pp-t — wall PW-O02 part 2 (lane pp-, the customer's order page on shared parts, round 1; plan § 5, § 8; O3-W1, O3-W2, O3-W4): what
 * the customer's order page READS can carry nothing of the office, even if an answer did. The server leaves these out (pp-s, PG-O1 /
 * PG-O2); the web's schemas are the second wall: each one drops every key it does not name, so a view model built from a read never
 * holds the office's series (`number`, `orderNumber`), an inside note (`internalNote`), a line's floor note (`note`), a close-short
 * reason, a priority, a cost or an office person's id. The one free part of the record — the delivery address the order keeps as
 * agreed (`shipTo`, a JSON snapshot no schema can narrow) — reaches the page as address lines only (`shipToLines`). Made-up data only.
 */

/** The office's keys a partner answer must never bring to the page (what a leak on the server would look like). */
const OFFICE_KEYS = ['number', 'orderNumber', 'internalNote', 'closeShortReason', 'priority', 'costAmount', 'createdById', 'answeredById', 'askedBy', 'answeredBy', 'companyId', 'party', 'mayAnswer', 'amendment', 'siteId'] as const
const LEAK = {
  number: 'SO-2026-0142',
  orderNumber: 'SO-2026-0142',
  internalNote: 'Office only: chase the tannery, ask Lia Modello',
  closeShortReason: 'The leather lot came short',
  priority: 'HIGH',
  costAmount: 123_45,
  createdById: 'office-person-1',
  answeredById: 'office-person-2',
  siteId: 'site-1',
}
/** A line's floor note ("For the floor — no prices"): the key `note` on an order line, never the customer's. */
const FLOOR_NOTE = { note: 'For the floor: stitch the cuffs twice' }

/** Every key of an answer, at any depth (the free ship-to left out: it is read through shipToLines only). */
function keysIn(value: unknown, skip: readonly string[] = ['shipTo']): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => keysIn(entry, skip))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => (skip.includes(key) ? [key] : [key, ...keysIn(entry, skip)]))
}
const officeKeysIn = (value: unknown): string[] => keysIn(value).filter((key) => (OFFICE_KEYS as readonly string[]).includes(key))

describe('PW-O02 part 2 — the order read: the schema drops every office key an answer could bring', () => {
  it('the record names none of them, at the order, on a line, a size, a deposit, a promise move or a milestone', () => {
    const order = Object.keys(orderRecordSchema.shape.order.shape)
    for (const key of [...OFFICE_KEYS, 'note']) expect(order, key).not.toContain(key)
    expect(order).toContain('yourNumber') // the customer's own number names the order
    const line = Object.keys(orderRecordSchema.shape.lines.element.shape)
    for (const key of [...OFFICE_KEYS, 'note']) expect(line, key).not.toContain(key)
    expect(line).toContain('description') // the customer's own line text ("On the order — the customer sees it")
  })

  it('an answer that carried them anyway parses into a record with none (zod strips what the schema does not name)', () => {
    const base = orderRecord()
    // Not vacuous: the made-up order has lines with sizes, a deposit, promise moves and milestones to carry a leak.
    expect(base.lines.length).toBeGreaterThan(0)
    expect(base.deposits.length).toBeGreaterThan(0)
    expect(base.promiseHistory.length).toBeGreaterThan(0)
    const leaked = {
      ...base,
      ...LEAK,
      order: { ...base.order, ...LEAK },
      lines: base.lines.map((line) => ({ ...line, ...LEAK, ...FLOOR_NOTE, sizes: line.sizes.map((size) => ({ ...size, costAmount: LEAK.costAmount })) })),
      deposits: base.deposits.map((deposit) => ({ ...deposit, internalNote: LEAK.internalNote, createdById: LEAK.createdById })),
      promiseHistory: base.promiseHistory.map((move) => ({ ...move, ...FLOOR_NOTE, createdById: LEAK.createdById })),
      milestones: base.milestones.map((step) => ({ ...step, priority: LEAK.priority })),
    }
    const read = orderRecordSchema.parse(leaked)
    expect(officeKeysIn(read)).toEqual([])
    // The domain's own list of what a customer's production answer never holds (`note`, `priority`, an office person's id, …).
    expect(forbiddenKeysIn({ ...read, order: { ...read.order, shipTo: {} } })).toEqual([])
    const text = JSON.stringify({ ...read, order: { ...read.order, shipTo: {} } })
    for (const word of [LEAK.number, LEAK.internalNote, LEAK.closeShortReason, FLOOR_NOTE.note, 'Lia Modello']) expect(text, word).not.toContain(word)
    // What the customer reads stays: its own number, its PO, its lines.
    expect(read.order.yourNumber).toEqual(base.order.yourNumber)
    expect(read.order.customerRef).toBe(base.order.customerRef)
    expect(read.lines.map((line) => line.id)).toEqual(base.lines.map((line) => line.id))
  })
})

describe('PW-O02 part 2 — the requests, the rules and the impact read: no office key either', () => {
  it('a request names its order by id and its PO; the office request\'s fields (who asked or answered, the customer, the amendment) drop', () => {
    const shape = Object.keys(changeRequestSchema.shape)
    for (const key of OFFICE_KEYS) expect(shape, key).not.toContain(key)
    expect(shape).toEqual(expect.arrayContaining(['orderId', 'customerRef']))
    const base = requestsOf()
    expect(base.length).toBeGreaterThan(0)
    const read = requestsSchema.parse({
      asOf: '2026-11-25T09:00:00Z',
      items: base.map((request) => ({ ...request, ...LEAK, party: { id: 'p1', code: 'BRAND-B', name: 'Brand Beta' }, askedBy: 'Bea Esempio', answeredBy: 'Marco Prova', mayAnswer: true, amendment: { id: 'a1', revision: 2 }, companyId: 'c1' })),
      live: { events: [] },
    })
    expect(officeKeysIn(read)).toEqual([])
    expect(JSON.stringify(read)).not.toContain(LEAK.number)
    expect(JSON.stringify(read)).not.toContain('Marco Prova')
    // The customer's own words on its ask stay (a request's `note` is theirs, never the floor's).
    expect(read.items.map((item) => item.note)).toEqual(base.map((request) => request.note))
  })

  it('the rules name the order by id and its PO; a rule line carries no floor note, reason or cost', () => {
    expect(Object.keys(rulesSchema.shape.order.shape)).not.toContain('number')
    const base = rulesOf()
    expect(base.lines.length).toBeGreaterThan(0)
    const read = rulesSchema.parse({ ...base, order: { ...base.order, ...LEAK }, lines: base.lines.map((line) => ({ ...line, ...LEAK, ...FLOOR_NOTE })) })
    expect(officeKeysIn(read)).toEqual([])
    expect(keysIn(read.lines)).not.toContain('note')
    expect(JSON.stringify(read)).not.toContain(LEAK.number)
  })

  it('the impact before Send reads no order at all (so no series)', () => {
    expect(Object.keys(impactReadSchema.shape)).not.toContain('order')
    const read = impactReadSchema.parse({ asOf: '2026-11-25T09:00:00Z', order: { id: 'o1', number: LEAK.number, customerRef: 'PO-1' }, impact: { kind: 'CHANGE', frozen: [], blocked: false, priced: false, earliest: null, notes: [] } })
    expect(read).not.toHaveProperty('order')
    expect(JSON.stringify(read)).not.toContain(LEAK.number)
  })
})

describe('O3-W4 — the delivery address reaches the page as address lines only', () => {
  it('the record keeps the order\'s ship-to as agreed (a free snapshot: no schema can narrow it), so the page reads it through shipToLines', () => {
    const base = orderRecord()
    const read = orderRecordSchema.parse({ ...base, order: { ...base.order, shipTo: { ...base.order.shipTo, internalNote: LEAK.internalNote } } })
    // The schema passes the snapshot on as it is: the second wall is the one reader of it.
    expect(read.order.shipTo).toHaveProperty('internalNote')
    expect(shipToLines(read.order.shipTo).join(' | ')).not.toContain(LEAK.internalNote)
  })

  it('shipToLines: name, street lines, postal code + city (province), country, the contact — nothing else of the snapshot', () => {
    const lines = shipToLines({
      name: 'Brand Beta — Magazzino',
      line1: 'Via Esempio 10',
      line2: 'Scala B',
      postalCode: '20100',
      city: 'Milano',
      province: 'MI',
      country: 'IT',
      contactName: 'Bea Esempio',
      // what a snapshot may also hold, never drawn: an id, an office note, who wrote it, a phone, a flag
      id: 'addr-1',
      addressId: 'addr-1',
      internalNote: LEAK.internalNote,
      createdById: LEAK.createdById,
      phone: '+39 02 0000 0000',
      approvalStatus: 'WAITING',
      nested: { internalNote: LEAK.internalNote },
    })
    expect(lines).toEqual(['Brand Beta — Magazzino', 'Via Esempio 10', 'Scala B', '20100 Milano (MI)', 'IT', 'Bea Esempio'])
    expect(lines.every((line) => typeof line === 'string')).toBe(true)
    // A blank or non-text value is left out, never drawn as "undefined" or "[object Object]".
    expect(shipToLines({ name: '  ', line1: 7, city: { x: 1 }, country: 'IT' })).toEqual(['IT'])
  })
})
