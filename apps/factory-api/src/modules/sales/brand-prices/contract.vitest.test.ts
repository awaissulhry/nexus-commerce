import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { grainPermission, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import type { Actor, Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor, liveViewFor } from '@nexus/factory-domain/events/live'
import { filterForGrains, unheldMoneyInput } from '@nexus/factory-domain/money/filter'
import { grainOfSchema } from '@nexus/factory-domain/money/marked'
import { listOrdersContract } from '../orders/contract' // B-CP-018
import { priceCheckContract, priceCheckView, saveBrandPricesContract, summaryContract, takeOverContract } from './contract'

/**
 * The customer's price contracts (customer page lane B-CP-017; review B4: every key money-marked, the note included) and the
 * event's live wall (the money wall: a Sales worker or a Production manager is never sent it; the brand wall: a person limited
 * to Brand Beta is never sent Brand Alpha's). Pure: no database. Every id and figure is made up.
 */

type Def = { readonly type: string } & Record<string, unknown>
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch', 'nonoptional'])

/** Every key, at any depth, whose field is not marked with the price grain (an object's keys, an array's items' keys). */
function unmarkedKeys(schema: z.ZodType, path = ''): string[] {
  const def = defOf(schema)
  if (WRAPPERS.has(def.type)) return unmarkedKeys(def.innerType as z.ZodType, path)
  if (def.type === 'pipe') return [...unmarkedKeys(def.in as z.ZodType, path), ...unmarkedKeys(def.out as z.ZodType, path)]
  if (def.type === 'array') return unmarkedKeys(def.element as z.ZodType, `${path}/*`)
  if (def.type === 'object') {
    return Object.entries(def.shape as Record<string, z.ZodType>).flatMap(([key, field]) => [...(grainOfSchema(field) === 'price' ? [] : [`${path}/${key}`]), ...unmarkedKeys(field, `${path}/${key}`)])
  }
  return []
}

/** Every key path of an object schema (to show the walk reaches each one). */
function keyCount(schema: z.ZodType): number {
  const def = defOf(schema)
  if (WRAPPERS.has(def.type)) return keyCount(def.innerType as z.ZodType)
  if (def.type === 'array') return keyCount(def.element as z.ZodType)
  if (def.type === 'object') return Object.values(def.shape as Record<string, z.ZodType>).reduce((sum, field) => sum + 1 + keyCount(field), 0)
  return 0
}

const ORDER = '0190a000-0000-7000-8000-00000000a001'
const LINE = '0190a000-0000-7000-8000-00000000a011'
const ROW = '0190a000-0000-7000-8000-00000000a021'
const row = { id: ROW, unitPrice: '100', netAmount: null, currency: 'EUR', source: 'CUSTOMER_PO', sourceFile: { id: ORDER, name: 'Brand Alpha PO 4471.pdf' }, note: 'Price as agreed: 100.00', enteredBy: { name: 'Ada Demo' }, enteredAt: '2026-11-19T08:00:00.000Z', version: 1 }
const answer = {
  orderId: ORDER,
  number: 'SO-CP017-1',
  currency: 'EUR',
  status: 'CONFIRMED',
  lines: [{ lineId: LINE, seq: 10, label: 'JKT-01 BLK', pieces: 6, ourUnitPrice: '110', ourAmount: 66_000, brandAmount: 60_000, priceMatch: 'NOT_EQUAL', priceDiff: 6_000, row }],
  total: { ourPrice: 66_000, brandPrice: 60_000, priceMatch: 'NOT_EQUAL', priceDiff: 6_000, priceNotEqualLines: 1, priceMissingLines: 0, priceOtherCurrency: 0, row: null },
  fromRequest: null,
  mayWrite: { allowed: true, why: null },
}

describe('every key of the customer price contracts is the price grain (review B4)', () => {
  it('the price check answer: every key at every depth, the note, the ids and the counts included', () => {
    expect(keyCount(priceCheckView)).toBeGreaterThan(40)
    expect(unmarkedKeys(priceCheckView)).toEqual([])
    expect(priceCheckContract.response[200]).toBe(priceCheckView)
  })

  it('the bodies: PUT brand-prices and the take-over', () => {
    expect(unmarkedKeys(saveBrandPricesContract.body)).toEqual([])
    expect(unmarkedKeys(takeOverContract.body)).toEqual([])
    expect(saveBrandPricesContract.response[200]).toBe(priceCheckView)
    expect(takeOverContract.response[200]).toBe(priceCheckView)
  })

  // B-CP-018: one customer's counts.
  it('the summary of one customer: its id and both counts', () => {
    expect(unmarkedKeys(summaryContract.response[200])).toEqual([])
    expect(filterForGrains(summaryContract.response[200], { partyId: ORDER, priceNotEqualCount: 2, priceMissingCount: 5 }, new Set())).toEqual({})
  })

  it('the Orders list: the four price check keys of a row are the price grain; the term is a plain query term', () => {
    const rows = (listOrdersContract.response[200] as unknown as z.ZodObject).shape.orders as unknown as z.ZodArray<z.ZodObject>
    for (const key of ['brandPrice', 'priceMatch', 'priceDiff', 'priceNotEqualLines']) expect(grainOfSchema(rows.element.shape[key] as z.ZodType), key).toBe('price')
    expect(Object.keys((listOrdersContract.querystring as unknown as z.ZodObject).shape)).toContain('priceMatch')
  })

  it('a reader without the price grain is sent nothing of the answer; a price holder all of it', () => {
    const none = new Set<Grain>()
    expect(filterForGrains(priceCheckView, answer, none)).toEqual({})
    expect(filterForGrains(priceCheckView, answer, new Set<Grain>(['cost', 'margin']))).toEqual({})
    expect(filterForGrains(priceCheckView, answer, new Set<Grain>(['price']))).toEqual(answer)
  })

  it('a body from a person without the price grain is refused key by key', () => {
    const body = { currency: 'EUR', rows: [{ lineId: LINE, unitPrice: '100', source: 'OFFICE', version: 1 }], remove: [] }
    const paths = unheldMoneyInput(saveBrandPricesContract.body, body, new Set()).map((issue) => issue.path)
    expect(paths).toEqual(expect.arrayContaining(['currency', 'rows', 'rows/0/lineId', 'rows/0/unitPrice', 'rows/0/source', 'rows/0/version', 'remove']))
    expect(paths.every((path) => /^(currency|rows|remove)(\/|$)/.test(path))).toBe(true)
    expect(unheldMoneyInput(saveBrandPricesContract.body, body, new Set<Grain>(['price']))).toEqual([])
    expect(unheldMoneyInput(takeOverContract.body, { requestId: ROW }, new Set()).map((issue) => issue.path)).toEqual(['requestId'])
  })
})

describe("sales_order.brand_price_changed: ids only, live only to price holders of the order's customer", () => {
  const TENANT = '0190a000-0000-7000-8000-000000000001'
  const COMPANY = '0190a000-0000-7000-8000-0000000000c1'
  const ALPHA = '0190a000-0000-7000-8000-0000000000b1'
  const BETA = '0190a000-0000-7000-8000-0000000000b2'
  const definition = EVENT_CATALOGUE.get('sales_order.brand_price_changed', 1)
  const envelope: EventEnvelope = {
    eventId: '0190a000-0000-7000-8000-0000000000e1',
    type: 'sales_order.brand_price_changed',
    version: 1,
    context: 'brand-prices',
    tenantId: TENANT,
    companyId: COMPANY,
    siteId: null,
    subject: ORDER,
    correlationId: 'req-1',
    causationId: null,
    source: 'brandPrices.save',
    occurredAt: '2026-11-19T08:00:00.000Z',
    payload: { orderId: ORDER, partyId: ALPHA },
  }
  /** An office person with a template's permissions and grains, over every customer or the ones named. */
  const as = (template: string, parties: Grant['parties'] = 'all'): Actor => {
    const found = templateOf(template)!
    return { audience: 'office', tenantId: TENANT, grants: [{ permissions: [...found.permissions, ...found.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties }] }
  }

  it('names the order and its customer only: no amount, no state, no count; the live message copies the order id only', () => {
    expect(Object.keys(definition.payload.shape).sort()).toEqual(['orderId', 'partyId'])
    expect(definition.live).toEqual({ permission: 'money.price', floor: null, fields: ['orderId'] })
    expect(definition.payload.safeParse({ orderId: ORDER, partyId: ALPHA }).success).toBe(true)
    expect(definition.payload.safeParse({ orderId: ORDER, partyId: ALPHA, priceMatch: 'NOT_EQUAL' }).success).toBe(false)
  })

  it('as Sales worker / as Production manager / as Administrator: nothing; the Owner: the order id', () => {
    const message = liveMessageFor(envelope, definition)!
    expect(message.partyIds).toEqual([ALPHA])
    expect(liveViewFor(message, as('sales'), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(message, as('production_manager'), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(message, as('admin'), EVENT_CATALOGUE)).toBeNull()
    const seen = liveViewFor(message, as('owner'), EVENT_CATALOGUE)
    expect(seen?.fields).toEqual({ orderId: ORDER })
    expect(JSON.stringify(seen)).not.toContain(ALPHA)
  })

  it('the brand wall: an Owner limited to Brand Beta is not sent Brand Alpha’s; one limited to Alpha is', () => {
    const message = liveMessageFor(envelope, definition)!
    expect(liveViewFor(message, as('owner', [BETA]), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(message, as('owner', [ALPHA]), EVENT_CATALOGUE)?.fields).toEqual({ orderId: ORDER })
  })
})
