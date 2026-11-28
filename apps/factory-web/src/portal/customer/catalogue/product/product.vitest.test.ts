import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../../lib/api/client'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import { PREFIX, styleDetail } from '../../neworder/design-data'
import { fetchOrdersWith, type PortalOrderRow, type PortalProductSizes } from './api'
import { measuresOf, pictureOf, portalProductOf, productHref, productTabOf, readStateOf } from './product-model'

/**
 * owb-pd4 step 4.5 (gap G9; design § 5q "Customer": "its own designs + the range priced for it. A price only for a person who sees
 * prices. Never a cost, a code, a revision, or a design of another customer") — the customer's product page, its walls (written, not
 * run: Owner rule, checks at the end).
 */

/** Customer B's own order with the product (made up: Brand Beta). */
const betaOrder: PortalOrderRow = {
  kind: 'ORDER',
  id: BRAND_BETA.ids.order,
  customerRef: BRAND_BETA.customerRef,
  subject: null,
  yourNumber: { seq: 12, words: { it: 'Il vostro ordine 12', en: 'Your order 12' } },
  orderedOn: '2026-11-02',
  words: { it: 'In produzione', en: 'In production' },
  pieces: { ordered: 24, shipped: 0, open: 24 },
}

const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(keysOf)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
  return []
}

describe('the wall: customer B\'s page never holds customer A\'s product', () => {
  it('the page is built from B\'s own reads only: nothing of Brand Alpha reaches it', () => {
    const page = portalProductOf(styleDetail(), [betaOrder], PREFIX, 'en')
    const text = JSON.stringify(page)
    for (const alpha of [BRAND_ALPHA.tradeName, BRAND_ALPHA.legalName, BRAND_ALPHA.code, BRAND_ALPHA.customerRef, BRAND_ALPHA.ids.order, BRAND_ALPHA.numbers.order]) expect(text, alpha).not.toContain(alpha)
    expect(page.orders?.[0]).toEqual({ id: BRAND_BETA.ids.order, href: `${PREFIX}/orders/${BRAND_BETA.ids.order}`, label: 'Your order 12', state: 'In production', pieces: 24, on: '2026-11-02' })
  })
  it('A\'s product read by B answers 404 (or 403): the page says "not in your catalogue" and holds no data of it', () => {
    expect(readStateOf({ kind: 'not_found' })).toBe('missing')
    expect(readStateOf({ kind: 'forbidden' })).toBe('missing')
    expect(readStateOf({ kind: 'unavailable' })).toBe('error')
    expect(readStateOf(null)).toBe('error')
  })
})

describe('no cost, no route, no revision, no product code; a price only with the grain', () => {
  it('the page model has no cost, margin, route or revision key, nor the factory\'s code', () => {
    const detail = styleDetail()
    const page = portalProductOf(detail, [betaOrder], PREFIX, 'en')
    expect(keysOf(page).filter((key) => /cost|margin|route|revision|^code$|amount|total/i.test(key))).toEqual([])
    expect(JSON.stringify(page)).not.toContain(`"${detail.style.code}"`)
  })
  it('without the price grain the page holds no price at all (never a 0)', () => {
    const page = portalProductOf(styleDetail(false), null, PREFIX, 'en')
    expect(page.price).toBeNull()
    expect(page.orders).toBeNull()
  })
  it('with the price grain: the price per colour as the read sends it', () => {
    const detail = styleDetail(true)
    const page = portalProductOf(detail, [], PREFIX, 'en')
    expect(page.price?.byColour.length).toBe(detail.style.colourways.length)
    expect(page.orders).toEqual([])
  })
  it('the orders read keeps no amount, even when the API sends one to a person with the price grain', async () => {
    const raw = { items: [{ ...betaOrder, netAmount: 123400, currency: 'EUR', status: 'IN_PRODUCTION', promiseDate: null }], count: 1, asOf: '2026-11-28T08:00:00.000Z' }
    const api = { get: (_path: string, options: { schema: { parse: (value: unknown) => unknown } }) => Promise.resolve(options.schema.parse(raw)) } as unknown as ApiClient
    const answer = await fetchOrdersWith(api, 'DEMO-JKT-01')
    expect(keysOf(answer).filter((key) => /amount|price|currency/i.test(key))).toEqual([])
  })
})

describe('the two tabs and the address', () => {
  it('Overview by default, Sizes by `?tab=sizes`; the address keeps the product id', () => {
    expect(productTabOf(null)).toBe('overview')
    expect(productTabOf('sizes')).toBe('sizes')
    expect(productTabOf('cost')).toBe('overview')
    expect(productHref('/p/BETA', 's 1')).toBe('/p/BETA/catalogue/s%201')
    expect(productHref('/p/BETA', 's1', 'sizes')).toBe('/p/BETA/catalogue/s1?tab=sizes')
  })
})

// ---- owb-pd5 step 5.0 (pd4s s.3): the portal Sizes tab from GET /portal/catalogue/:styleId/sizes ----
describe('step 5.0 — the portal Sizes model comes from the product\'s own Sizes read', () => {
  const read: PortalProductSizes = {
    picture: { fileId: 'f1', url: '/files/f1/look' },
    mode: 'SIZES',
    sizes: ['S', 'M', 'L'],
    baseSize: 'M',
    points: [
      { code: 'CHEST', name: 'Chest', howTo: 'Around the widest part, under the arms.', values: { S: 1040, M: 1080, L: null } },
      { code: 'SLEEVE', name: 'Sleeve length', howTo: null, values: { S: 640, M: 650 } },
    ],
    protectors: [{ zone: 'SHOULDER', level: 'LEVEL_2' }],
  }
  it('the size table in the sizes\' order (a missing value stays null, never 0); how to measure only where words exist', () => {
    const measures = measuresOf(read)
    expect(measures.rows).toEqual([
      { code: 'CHEST', name: 'Chest', values: [1040, 1080, null] },
      { code: 'SLEEVE', name: 'Sleeve length', values: [640, 650, null] },
    ])
    expect(measures.howTo).toEqual([{ code: 'CHEST', name: 'Chest', text: 'Around the widest part, under the arms.' }])
    expect(measures.protectors).toEqual([{ zone: 'SHOULDER', level: 'LEVEL_2' }])
    expect(pictureOf(read)).toBe('/api/files/f1/look')
    expect(pictureOf(null)).toBeNull()
  })
  it('the page with its Sizes holds no cost, route or revision key; without the read it says plainly it is not there', () => {
    const page = portalProductOf(styleDetail(), [betaOrder], PREFIX, 'en', read)
    expect(keysOf(page).filter((key) => /cost|margin|route|revision|amount|total/i.test(key))).toEqual([])
    expect(page.measures?.base).toBe('M')
    expect(portalProductOf(styleDetail(), null, PREFIX, 'en', null).measures).toBeNull()
  })
})
