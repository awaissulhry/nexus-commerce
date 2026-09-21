/**
 * P4.4c — the operator's pricing floor and ceiling, honoured at the send.
 *
 * Three propositions:
 *   A. the VERDICT, for every shape of bound and price;
 *   B. the loader reads only what it needs and never blocks a send by failing;
 *   C. every send lane asks — a derived census, so a fourth lane is covered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { priceBoundsRefusal } from './price-bounds.service.js'

const at = (price: number | null | undefined, minPrice: number | null, maxPrice: number | null) =>
  priceBoundsRefusal({ price, bounds: { minPrice, maxPrice }, channel: 'Amazon', sku: 'SKU-1' })

// ── A. the verdict ──────────────────────────────────────────────────────────
describe('P4.4c priceBoundsRefusal', () => {
  it.each([
    ['inside both bounds', 90, 85, 100],
    ['exactly ON the floor', 85, 85, 100],
    ['exactly ON the ceiling', 100, 85, 100],
    ['no bounds set at all', 5, null, null],
    ['below a ceiling with no floor', 5, null, 100],
    ['above a floor with no ceiling', 5000, 85, null],
  ])('%s → sent', (_n, price, min, max) => {
    expect(at(price as number, min as number | null, max as number | null)).toBeNull()
  })

  it('below the floor is refused, and the sentence carries both numbers', () => {
    const refusal = at(79.99, 85, 100)
    expect(refusal).toContain('79.99')
    expect(refusal).toContain('85')
    expect(refusal).toContain('below the pricing floor')
    expect(refusal).toContain('Amazon')
    expect(refusal).toContain('SKU-1')
  })

  it('above the ceiling is refused, and says ceiling — not floor', () => {
    const refusal = at(120, 85, 100)
    expect(refusal).toContain('above the pricing ceiling')
    expect(refusal).not.toContain('floor')
  })

  it('🔴 a floor ABOVE the ceiling is refused on its own terms', () => {
    // And it is checked FIRST: with min 100 / max 85, a price of 90 satisfies
    // neither reading, and reporting "below the floor" would send the operator
    // to fix the wrong number.
    const refusal = at(90, 100, 85)
    expect(refusal).toContain('floor (100) is above the pricing ceiling (85)')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['NaN', Number.NaN],
  ])('a %s price is not this guard\'s business', (_n, price) => {
    // A row with no price is a content or quantity push, and a nonsense price is
    // the channel validation's defect. Neither may be blocked here.
    expect(at(price as number, 85, 100)).toBeNull()
  })

  it('a price of ZERO is checked like any other', () => {
    expect(at(0, 85, 100)).toContain('below the pricing floor')
    expect(at(0, null, null)).toBeNull()
  })

  it('the sku is optional and the sentence still reads', () => {
    const refusal = priceBoundsRefusal({ price: 1, bounds: { minPrice: 5, maxPrice: null }, channel: 'eBay' })
    expect(refusal).toContain('Nothing was sent to eBay:')
    expect(refusal).not.toContain('for ')
  })
})

// ── B. the loader ───────────────────────────────────────────────────────────
const m = vi.hoisted(() => {
  const findUnique = vi.fn()
  // A GETTER, so a test can take the whole `product` model away and reach the
  // synchronous-throw path. A plain `{ product: { findUnique: m.findUnique } }`
  // copies the function by value at module-eval time and cannot be changed after.
  return { findUnique, model: { findUnique } as unknown }
})
vi.mock('../db.js', () => ({ default: { get product() { return m.model } } }))
const { loadPriceBounds, priceRefusalFor } = await import('./price-bounds.service.js')

describe('P4.4c loadPriceBounds / priceRefusalFor', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads only the two columns, for the named product', async () => {
    m.findUnique.mockResolvedValue({ minPrice: '85.00', maxPrice: '100.00' })
    expect(await loadPriceBounds('p-1')).toEqual({ minPrice: 85, maxPrice: 100 })
    expect(m.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: 'p-1' }, select: { minPrice: true, maxPrice: true } })
  })

  it('a Decimal string becomes a number; a null stays null', async () => {
    m.findUnique.mockResolvedValue({ minPrice: null, maxPrice: '100.50' })
    expect(await loadPriceBounds('p-1')).toEqual({ minPrice: null, maxPrice: 100.5 })
  })

  it('🔴 a row with NO price never touches the database', async () => {
    // A content or quantity push must not pay for this guard, and must not fail
    // because of it.
    expect(await priceRefusalFor({ price: undefined, productId: 'p-1', channel: 'Amazon' })).toBeNull()
    expect(m.findUnique).not.toHaveBeenCalled()
  })

  it('🔴 a client with no product model at all is "no bounds" — a SYNCHRONOUS throw', async () => {
    // `.catch()` on the promise never sees this one. Narrow test doubles are how
    // it shows up, but the promise ("never blocks a send by failing") has to
    // hold for both shapes.
    const original = m.model
    m.model = undefined
    try { expect(await loadPriceBounds('p-1')).toEqual({ minPrice: null, maxPrice: null }) }
    finally { m.model = original }
  })

  it('🔴 an unreadable product is "no bounds", not a refusal', async () => {
    // A deliberate fail-OPEN, unlike the EU quantity guard: most products have
    // no bound at all, so "could not read" and "none set" are the same
    // population, and refusing every price push on a hiccup would take pricing
    // down for everyone who set no floor.
    m.findUnique.mockRejectedValue(new Error('connection reset'))
    expect(await loadPriceBounds('p-1')).toEqual({ minPrice: null, maxPrice: null })
    m.findUnique.mockRejectedValue(new Error('connection reset'))
    expect(await priceRefusalFor({ price: 1, productId: 'p-1', channel: 'Amazon' })).toBeNull()
  })

  it('a missing product id is "no bounds", and asks nothing', async () => {
    expect(await loadPriceBounds(null)).toEqual({ minPrice: null, maxPrice: null })
    expect(m.findUnique).not.toHaveBeenCalled()
  })

  it('end to end: a price under the floor is refused', async () => {
    m.findUnique.mockResolvedValue({ minPrice: '85.00', maxPrice: null })
    expect(await priceRefusalFor({ price: 79.99, productId: 'p-1', channel: 'Amazon', sku: 'S' }))
      .toContain('below the pricing floor of 85')
  })
})

// ── C. every lane asks ──────────────────────────────────────────────────────
describe('P4.4c: every send lane consults the bounds', () => {
  it('each price-carrying lane calls priceRefusalFor and returns on a refusal', () => {
    const source = readFileSync(new URL('./outbound-sync.service.ts', import.meta.url), 'utf8')
    // Strip comments: the guard's explanation is repeated at each call site.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, (mm) => mm.replace(/[^\n]/g, ' '))
      .split('\n').map((l) => l.replace(/\/\/.*$/, ''))
    const calls = code.map((l, i) => ({ l, i })).filter(({ l }) => /priceRefusalFor\(\{/.test(l))
    // Positive control: three lanes today (Amazon, eBay, Shopify).
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const { i } of calls) {
      // 🔴 Match the whole trimmed condition, not the substring: `if (false)`
      // keeps `refusal` in the returned body and turns the rule off.
      const window = code.slice(i, i + 4)
      const guards = window.filter((l) => /^if \(refusal\)/.test(l.trim()))
      expect(guards.length, `the priceRefusalFor call at line ${i + 1} does not act on its refusal`).toBe(1)
    }
    // And each lane names the same terminal error code.
    expect((source.match(/PRICE_OUT_OF_BOUNDS/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
