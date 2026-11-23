import { describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import { NOTE_SIBLINGS, notePlanOf, ORDER_NOTE_EVENTS, ORDER_NOTES_HANDLER, shipmentOrderLineOf, shipmentOrderNotesHandler } from './order-notes'

/**
 * B-CW-040 (customer Work tab plan §4; lead settle S10) — the office line of an order that went on a shipment, came off it or
 * whose shipment was cancelled: its exact words in both languages and what each event asks, pure (the PG suite
 * order-notes.pg.vitest.test.ts proves the writes, the retry and the wall). Every number is made up.
 */

describe('B-CW-040 the line\'s words (lead settle S10), English and Italian', () => {
  it('on a draft shipment with its sibling orders; alone: no "with …"', () => {
    const input = { kind: 'ON' as const, shipment: 'SEED-SH-0012', draft: true, siblings: ['SEED-SO-0003', 'SEED-SO-0004'] }
    expect(shipmentOrderLineOf(input, 'en')).toBe('On draft shipment SEED-SH-0012 with SEED-SO-0003, SEED-SO-0004.')
    expect(shipmentOrderLineOf(input, 'it')).toBe('In spedizione in bozza SEED-SH-0012 con SEED-SO-0003, SEED-SO-0004.')
    expect(shipmentOrderLineOf({ kind: 'ON', shipment: 'SEED-SH-0010', draft: true, siblings: [] }, 'en')).toBe('On draft shipment SEED-SH-0010.')
    expect(shipmentOrderLineOf({ kind: 'ON', shipment: 'SEED-SH-0010', draft: true }, 'it')).toBe('In spedizione in bozza SEED-SH-0010.')
  })

  it('no longer on it; the shipment was cancelled', () => {
    expect(shipmentOrderLineOf({ kind: 'OFF', shipment: 'SEED-SH-0012', draft: true }, 'en')).toBe('No longer on draft shipment SEED-SH-0012.')
    expect(shipmentOrderLineOf({ kind: 'OFF', shipment: 'SEED-SH-0012', draft: true }, 'it')).toBe('Non più nella spedizione in bozza SEED-SH-0012.')
    expect(shipmentOrderLineOf({ kind: 'CANCELLED', shipment: 'SEED-SH-0012', draft: false }, 'en')).toBe('Shipment SEED-SH-0012 was cancelled.')
    expect(shipmentOrderLineOf({ kind: 'CANCELLED', shipment: 'SEED-SH-0012', draft: false }, 'it')).toBe('La spedizione SEED-SH-0012 è stata annullata.')
    // The siblings of a line that is not "on" are never named.
    expect(shipmentOrderLineOf({ kind: 'OFF', shipment: 'SEED-SH-0012', draft: true, siblings: ['SEED-SO-0003'] }, 'en')).toBe('No longer on draft shipment SEED-SH-0012.')
  })

  it('"draft" is said only while the shipment is a draft', () => {
    expect(shipmentOrderLineOf({ kind: 'ON', shipment: 'SEED-SH-0012', draft: false, siblings: ['SEED-SO-0003'] }, 'en')).toBe('On shipment SEED-SH-0012 with SEED-SO-0003.')
    expect(shipmentOrderLineOf({ kind: 'ON', shipment: 'SEED-SH-0012', draft: false, siblings: ['SEED-SO-0003'] }, 'it')).toBe('In spedizione SEED-SH-0012 con SEED-SO-0003.')
    expect(shipmentOrderLineOf({ kind: 'OFF', shipment: 'SEED-SH-0012', draft: false }, 'en')).toBe('No longer on shipment SEED-SH-0012.')
    expect(shipmentOrderLineOf({ kind: 'OFF', shipment: 'SEED-SH-0012', draft: false }, 'it')).toBe('Non più nella spedizione SEED-SH-0012.')
  })

  it('at most 20 sibling orders are named, then how many more', () => {
    const siblings = Array.from({ length: NOTE_SIBLINGS + 3 }, (_, index) => `SEED-SO-${String(index + 1).padStart(4, '0')}`)
    const named = siblings.slice(0, NOTE_SIBLINGS).join(', ')
    expect(NOTE_SIBLINGS).toBe(20)
    expect(shipmentOrderLineOf({ kind: 'ON', shipment: 'SEED-SH-0012', draft: true, siblings }, 'en')).toBe(`On draft shipment SEED-SH-0012 with ${named} and 3 more.`)
    expect(shipmentOrderLineOf({ kind: 'ON', shipment: 'SEED-SH-0012', draft: true, siblings }, 'it')).toBe(`In spedizione in bozza SEED-SH-0012 con ${named} e altri 3.`)
    expect(shipmentOrderLineOf({ kind: 'ON', shipment: 'SEED-SH-0012', draft: true, siblings: siblings.slice(0, NOTE_SIBLINGS + 1) }, 'it')).toBe(`In spedizione in bozza SEED-SH-0012 con ${named} e un altro.`)
    // Exactly twenty: every one named, no "more".
    expect(shipmentOrderLineOf({ kind: 'ON', shipment: 'SEED-SH-0012', draft: true, siblings: siblings.slice(0, NOTE_SIBLINGS) }, 'en')).toBe(`On draft shipment SEED-SH-0012 with ${named}.`)
  })

  it('a line holds a shipment number and order numbers only: no amount, no currency', () => {
    for (const locale of ['en', 'it'] as const) {
      for (const kind of ['ON', 'OFF', 'CANCELLED'] as const) expect(shipmentOrderLineOf({ kind, shipment: 'SEED-SH-0012', draft: true, siblings: ['SEED-SO-0003'] }, locale)).not.toMatch(/€|EUR|\d[.,]\d{2}\b/)
    }
  })
})

describe('B-CW-040 what each event asks', () => {
  const shipmentId = newId()
  const [a, b, c] = [newId(), newId(), newId()]

  it('shipment.created: every order the shipment carries when the line is written', () => {
    expect(notePlanOf({ type: 'shipment.created', payload: { shipmentId, number: 'SEED-SH-0012', salesOrderId: a } })).toEqual({ shipmentId, kind: 'ON', orderIds: null })
  })

  it('shipment.orders_changed: the orders that came on (not at creation), the orders that came off', () => {
    expect(notePlanOf({ type: 'shipment.orders_changed', payload: { shipmentId, change: 'ADDED', salesOrderIds: [a, b, c], added: [b, c] } })).toEqual({ shipmentId, kind: 'ON', orderIds: [b, c] })
    expect(notePlanOf({ type: 'shipment.orders_changed', payload: { shipmentId, change: 'REMOVED', salesOrderIds: [a], removed: [b] } })).toEqual({ shipmentId, kind: 'OFF', orderIds: [b] })
    // With the shipment's creation: shipment.created already tells every order.
    expect(notePlanOf({ type: 'shipment.orders_changed', payload: { shipmentId, change: 'ADDED', salesOrderIds: [a, b], added: [b], atCreation: true } })).toBeNull()
    // An event written before the payload named who came on or off cannot say it: no line.
    expect(notePlanOf({ type: 'shipment.orders_changed', payload: { shipmentId, change: 'ADDED', salesOrderIds: [a, b] } })).toBeNull()
    expect(notePlanOf({ type: 'shipment.orders_changed', payload: { shipmentId, change: 'REMOVED', salesOrderIds: [a] } })).toBeNull()
    // The orders of the other change are never read (ADDED reads `added` only).
    expect(notePlanOf({ type: 'shipment.orders_changed', payload: { shipmentId, change: 'ADDED', salesOrderIds: [a], removed: [b] } })).toBeNull()
    expect(notePlanOf({ type: 'shipment.orders_changed', payload: { shipmentId, change: 'ADDED', salesOrderIds: [a, b], added: ['not-an-id', b] } })).toEqual({ shipmentId, kind: 'ON', orderIds: [b] })
  })

  it('shipment.status_changed: only a cancel', () => {
    expect(notePlanOf({ type: 'shipment.status_changed', payload: { shipmentId, number: 'SEED-SH-0012', from: 'DRAFT', to: 'CANCELLED' } })).toEqual({ shipmentId, kind: 'CANCELLED', orderIds: null })
    for (const to of ['DRAFT', 'PACKED', 'SHIPPED']) expect(notePlanOf({ type: 'shipment.status_changed', payload: { shipmentId, number: 'SEED-SH-0012', from: 'DRAFT', to } }), to).toBeNull()
  })

  it('any other event, or a payload without its shipment: nothing', () => {
    expect(notePlanOf({ type: 'shipment.packing_changed', payload: { shipmentId } })).toBeNull()
    expect(notePlanOf({ type: 'shipment.created', payload: { shipmentId: 'not-an-id' } })).toBeNull()
    expect(notePlanOf({ type: 'shipment.created', payload: {} })).toBeNull()
  })
})

describe('B-CW-040 the handler and the event\'s payload', () => {
  it('shipping.orderNotes handles the three shipment events', () => {
    const handler = shipmentOrderNotesHandler()
    expect(handler.name).toBe(ORDER_NOTES_HANDLER)
    expect(handler.name).toBe('shipping.orderNotes')
    expect([...handler.events]).toEqual([...ORDER_NOTE_EVENTS])
    expect([...ORDER_NOTE_EVENTS]).toEqual(['shipment.created', 'shipment.orders_changed', 'shipment.status_changed'])
    for (const type of ORDER_NOTE_EVENTS) expect(EVENT_CATALOGUE.definitions.some((entry) => entry.type === type), type).toBe(true)
  })

  it('shipment.orders_changed takes who came on, who came off and "at creation" — optional, and never live fields', () => {
    const definition = EVENT_CATALOGUE.definitions.find((entry) => entry.type === 'shipment.orders_changed')!
    const base = { shipmentId: newId(), number: 'SEED-SH-0012', salesOrderIds: [newId()], change: 'ADDED', partyId: newId() }
    // As before (an emitter that names none of the three still passes).
    expect(definition.payload.safeParse(base).success).toBe(true)
    expect(definition.payload.safeParse({ ...base, added: [newId()], atCreation: true }).success).toBe(true)
    expect(definition.payload.safeParse({ ...base, change: 'REMOVED', removed: [newId()] }).success).toBe(true)
    expect(definition.payload.safeParse({ ...base, added: ['not-an-id'] }).success).toBe(false)
    // The schema stays strict: an unknown field is still refused.
    expect(definition.payload.safeParse({ ...base, left: [newId()] }).success).toBe(false)
    expect(definition.live?.fields).toEqual(['shipmentId', 'number', 'salesOrderIds', 'change'])
    for (const field of ['added', 'removed', 'atCreation', 'partyId']) expect(definition.live?.fields).not.toContain(field)
  })
})
