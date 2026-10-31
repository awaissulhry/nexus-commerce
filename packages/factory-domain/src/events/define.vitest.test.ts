import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { defineEvent, EventDefinitionError, eventFor, isFloorPermission, isMoneyField, isStrictObject, type EventPayload } from './define'

const quoteSent = defineEvent({
  type: 'quote.sent',
  context: 'sales',
  description: 'A quote was sent to the customer.',
  payload: z.strictObject({ quoteId: z.string(), number: z.string(), totalMinor: z.number().int() }),
  live: { permission: 'quotes.read', fields: ['number'] },
})

describe('defineEvent', () => {
  it('declares a frozen definition, version 1 by default, with its live rule', () => {
    expect(quoteSent).toMatchObject({ type: 'quote.sent', version: 1, context: 'sales', live: { permission: 'quotes.read', floor: null, fields: ['number'] } })
    expect(Object.isFrozen(quoteSent)).toBe(true)
    expect(Object.isFrozen(quoteSent.live)).toBe(true)
    expect(defineEvent({ type: 'quote.sent', version: 2, context: 'sales', description: 'v2', payload: z.strictObject({}) })).toMatchObject({ version: 2, live: null })
    expectTypeOf<EventPayload<typeof quoteSent>>().toEqualTypeOf<{ quoteId: string; number: string; totalMinor: number }>()
  })

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['a type that is not <module>.<event>', { type: 'QuoteSent' }, /type is not <module>.<event>/],
    ['a version below 1', { version: 0 }, /version is not a whole number from 1/],
    ['a fractional version', { version: 1.5 }, /version is not a whole number/],
    ['a context that is not a module name', { context: 'Sales Module' }, /context is not a module name/],
    ['an empty description', { description: ' ' }, /description is empty/],
    ['a payload that is not strict', { payload: z.object({ a: z.string() }) }, /payload is not a strict object/],
    ['a payload that is not an object', { payload: z.string() }, /payload is not a strict object/],
    ['a live permission that is not <module>.<action>', { live: { permission: 'read' } }, /live.permission is not/],
    ['a live field that is not a payload key', { live: { permission: 'quotes.read', fields: ['missing'] } }, /live field "missing" is not a payload key/],
    ['a live field that names money', { live: { permission: 'quotes.read', fields: ['totalMinor'] } }, /live field "totalMinor" names money/],
    ['a live field listed twice', { live: { permission: 'quotes.read', fields: ['number', 'number'] } }, /listed twice/],
    // B-W2a-F5: a floor rule names the floor permission a floor viewer needs.
    ['floor: true (no floor permission)', { live: { permission: 'quotes.read', floor: true } }, /live.floor true is not a floor permission/],
    ['floor: false', { live: { permission: 'quotes.read', floor: false } }, /live.floor false is not a floor permission/],
    ['an office read no floor role holds as the floor permission', { live: { permission: 'planning.view', floor: 'planning.view' } }, /live.floor "planning.view" is not a floor permission/],
    ['an undeclared floor permission', { live: { permission: 'quotes.read', floor: 'floor.dance' } }, /live.floor "floor.dance" is not a floor permission/],
  ])('refuses %s', (_name, change, message) => {
    const spec = {
      type: 'quote.sent',
      context: 'sales',
      description: 'A quote was sent.',
      payload: z.strictObject({ number: z.string(), totalMinor: z.number() }),
      ...change,
    }
    expect(() => defineEvent(spec as never)).toThrow(EventDefinitionError)
    expect(() => defineEvent(spec as never)).toThrow(message)
  })

  it('keeps the floor permission of a floor rule (B-W2a-F5)', () => {
    const spec = { type: 'plan.published', context: 'planning', description: 'x', payload: z.strictObject({ number: z.number() }) }
    expect(defineEvent({ ...spec, live: { permission: 'planning.view', floor: 'floor.work', fields: ['number'] } }).live).toEqual({ permission: 'planning.view', floor: 'floor.work', fields: ['number'] })
    expect(defineEvent({ ...spec, live: { permission: 'production.cut', floor: 'production.cut' } }).live?.floor).toBe('production.cut')
    // @ts-expect-error: floor names a permission, not true
    expect(() => defineEvent({ ...spec, live: { permission: 'planning.view', floor: true } })).toThrow(EventDefinitionError)
  })

  it('knows a floor permission: the floor area and what the floor shares with the office, never an office read', () => {
    for (const name of ['floor.work', 'floor.lead', 'production.scan', 'production.cut', 'plant.report', 'plant.jobs.work', 'quality.inspections.view', 'sales.returns.receive', 'shipping.pack', 'print.view', 'inventory.issue']) {
      expect(isFloorPermission(name), name).toBe(true)
    }
    for (const name of ['planning.view', 'quality.holds.view', 'workorders.view', 'plant.view', 'floorsync.view', 'sales.returns.view', 'floor.dance', 'floor', true, null, undefined]) {
      expect(isFloorPermission(name), String(name)).toBe(false)
    }
  })

  it('knows a strict object and a money key', () => {
    expect(isStrictObject(z.strictObject({}))).toBe(true)
    expect(isStrictObject(z.object({}))).toBe(false)
    expect(isStrictObject(z.looseObject({}))).toBe(false)
    expect(isStrictObject({})).toBe(false)
    for (const key of ['unitPrice', 'totalMinor', 'costPerM2', 'marginPct', 'amountMinor', 'wages', 'salary']) expect(isMoneyField(key), key).toBe(true)
    for (const key of ['number', 'quoteId', 'status', 'siteId']) expect(isMoneyField(key), key).toBe(false)
  })

  it('builds the event to emit from a definition, typed by its payload', () => {
    const event = eventFor(quoteSent, { subject: 'q-1', payload: { quoteId: 'q-1', number: 'Q-26-0001', totalMinor: 1250 } })
    expect(event).toEqual({ type: 'quote.sent', version: 1, subject: 'q-1', payload: { quoteId: 'q-1', number: 'Q-26-0001', totalMinor: 1250 } })
    // @ts-expect-error: the payload is typed by the definition
    eventFor(quoteSent, { subject: 'q-1', payload: { quoteId: 1 } })
  })
})
