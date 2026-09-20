/**
 * P5.1 — the version census. "Set the version on every library call so it never
 * falls back to the oldest one" is the plan's instruction; this is the guard
 * that makes a fallback impossible to miss.
 *
 * WHY A GUARD AND NOT A CONFIG LINE. `amazon-sp-api@1.2.1` defaults
 * `version_fallback: true`. So the obvious fix —
 * `endpoints_versions: { orders: '2026-01-01' }` on the SellingPartner
 * constructor — moves exactly ONE operation (`getOrder`) and silently sends the
 * other nine back to v0. No warning, no log line, no thrown error. The first
 * block below proves that against the library's own resolver, so the claim is
 * measured and not asserted.
 *
 * WHAT THIS GUARDS. The set of Amazon Orders operations our source calls is
 * DERIVED from the source, not typed out here: a hardcoded list of members goes
 * stale in hours. Every derived member must be either
 *   - available on 2026-01-01 and called with the version named, or
 *   - on `STAYS_ON_V0` with a written reason and a dated consequence.
 *
 * Orders v0 is removed **2027-03-27**. Anything on `STAYS_ON_V0` stops working
 * on that date. That is the point of writing it down.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AMAZON_ORDERS_2026_VERSION } from './amazon-orders-2026.js'

/* eslint-disable @typescript-eslint/no-var-requires */
const SellingPartner = require('amazon-sp-api/lib/SellingPartner.js')

const SRC = join(import.meta.dirname, '..', '..')

/** Every operation the Orders endpoint declares, in the library's own order. */
const ORDERS_OPERATIONS: string[] = new SellingPartner({
  region: 'eu',
  refresh_token: 'probe',
  access_token: 'probe',
  credentials: { SELLING_PARTNER_APP_CLIENT_ID: 'a', SELLING_PARTNER_APP_CLIENT_SECRET: 'b' },
  options: { auto_request_tokens: false },
}).endpoints.orders.__operations

function client(endpointsVersions?: Record<string, string>) {
  return new SellingPartner({
    region: 'eu',
    refresh_token: 'probe',
    access_token: 'probe',
    credentials: { SELLING_PARTNER_APP_CLIENT_ID: 'a', SELLING_PARTNER_APP_CLIENT_SECRET: 'b' },
    options: { auto_request_tokens: false },
    ...(endpointsVersions ? { endpoints_versions: endpointsVersions } : {}),
  })
}

/** The version the library would use for `operation`, given a constructor config. */
function resolves(operation: string, endpointsVersions?: Record<string, string>): string {
  return client(endpointsVersions)._validateAndGetVersion(operation, 'orders', undefined)
}

/* ────────────────────────────────────────────────────────────────────────── */

describe('the library’s version_fallback is silent', () => {
  it('pinning the endpoint to 2026-01-01 moves only getOrder', () => {
    const pinned = { orders: AMAZON_ORDERS_2026_VERSION }
    const moved = ORDERS_OPERATIONS.filter((op) => resolves(op, pinned) === AMAZON_ORDERS_2026_VERSION)
    // `searchOrders` does not exist in v0, so it was already on the new version.
    // `getOrder` is the only operation the pin actually changes.
    expect(moved.sort()).toEqual(['getOrder', 'searchOrders'])
  })

  it('the rest fall back to v0 without an error', () => {
    const pinned = { orders: AMAZON_ORDERS_2026_VERSION }
    const fellBack = ORDERS_OPERATIONS.filter((op) => resolves(op, pinned) === 'v0')
    expect(fellBack.length).toBeGreaterThan(0)
    expect(fellBack).toContain('getOrders')
    expect(fellBack).toContain('getOrderItems')
    // No throw: the fallback is the library's normal, quiet behaviour.
    expect(() => resolves('getOrders', pinned)).not.toThrow()
  })

  it('with no pin at all, every operation that has a v0 form takes it', () => {
    // The state of the code before P5.1. The control is `searchOrders`, which
    // has no v0 form and so resolves to the new version either way — a probe
    // that returned v0 for everything would be measuring nothing.
    for (const op of ORDERS_OPERATIONS) {
      expect(resolves(op)).toBe(op === 'searchOrders' ? AMAZON_ORDERS_2026_VERSION : 'v0')
    }
  })

  it('naming the version on the call is what actually decides it', () => {
    const c = client()
    expect(c._validateAndGetVersion('getOrder', 'orders', AMAZON_ORDERS_2026_VERSION)).toBe(AMAZON_ORDERS_2026_VERSION)
    // And an operation the new version does not have still falls back, named or
    // not — which is why the census below exists instead of a version pin.
    expect(c._validateAndGetVersion('getOrderItems', 'orders', AMAZON_ORDERS_2026_VERSION)).toBe('v0')
  })
})

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Operations we call that have no 2026-01-01 form, each with the reason and the
 * consequence. Every entry here STOPS WORKING on 2027-03-27.
 */
const STAYS_ON_V0: Readonly<Record<string, string>> = Object.freeze({
  getOrders:
    'Replaced by searchOrders, not renamed. The v0 arm is kept behind NEXUS_ENABLE_AMAZON_ORDERS_2026 until a live 2026-01-01 call is made; it is dead code once the switch is on.',
  getOrderItems:
    'Orders 2026-01-01 has no getOrderItems at all — items come attached to the order. The v0 arm is kept behind the same switch for the same reason.',
})

/** Files under apps/api/src that are not tests. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'test-support') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, found)
    else if (entry.endsWith('.ts') && !/\.(test|vitest\.test)\.ts$/.test(entry) && !entry.includes('.vitest.')) {
      found.push(full)
    }
  }
  return found
}

/** Amazon Orders operations named in our source, derived — never typed out. */
function calledOperations(): Set<string> {
  const called = new Set<string>()
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    // Only count a call that also names the Orders endpoint, so eBay's own
    // `getOrders` in ebay-orders.service.ts is not mistaken for Amazon's.
    for (const match of text.matchAll(/operation:\s*'([A-Za-z]+)'/g)) {
      const op = match[1]
      if (!ORDERS_OPERATIONS.includes(op)) continue
      const near = text.slice(Math.max(0, match.index - 400), match.index + 400)
      if (/endpoint:\s*'orders'/.test(near)) called.add(op)
    }
  }
  return called
}

describe('the census of Amazon Orders operations we call', () => {
  it('finds the call sites at all', () => {
    // Positive control. An empty set would make every claim below vacuously
    // true — "could not measure" reading as "measured clean".
    const called = calledOperations()
    expect(called.size).toBeGreaterThan(0)
    expect(called).toContain('getOrder')
  })

  it('does not count eBay’s getOrders as Amazon’s', () => {
    // Negative control on the same matcher: ebay-orders.service.ts names
    // `operation: 'getOrders'` twice and must never reach this census.
    const ebay = readFileSync(join(SRC, 'services', 'ebay-orders.service.ts'), 'utf8')
    expect(ebay).toContain("operation: 'getOrders'")
    expect(ebay).not.toContain("endpoint: 'orders'")
  })

  it('every operation we call is on 2026-01-01, or written down as staying on v0', () => {
    const unexplained: string[] = []
    for (const op of calledOperations()) {
      const availableOn2026 = resolves(op, { orders: AMAZON_ORDERS_2026_VERSION }) === AMAZON_ORDERS_2026_VERSION
      if (!availableOn2026 && !(op in STAYS_ON_V0)) unexplained.push(op)
    }
    // A new Orders call added without a 2026-01-01 form, and without a written
    // reason, fails here rather than dying quietly on 2027-03-27.
    expect(unexplained).toEqual([])
  })

  it('has no stale entry: everything written down is still called', () => {
    // The other direction. A reason kept for an operation nobody calls any more
    // is a claim that has gone false — the guard that never releases.
    const called = calledOperations()
    const stale = Object.keys(STAYS_ON_V0).filter((op) => !called.has(op))
    expect(stale).toEqual([])
  })

  it('every reason says WHY, not just THAT', () => {
    for (const [op, reason] of Object.entries(STAYS_ON_V0)) {
      expect(reason.length, `${op} needs a real reason`).toBeGreaterThan(40)
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Where the version has to GO.
 *
 * `callAPI` reads `options.version`, not a top-level `version`. A top-level key
 * is accepted by the object and dropped on the floor: no error, no warning, and
 * 2026-01-01 query parameters go to the v0 path. This is "an API can accept a
 * flag it IGNORES" in its purest form, and TypeScript caught it here only
 * because the library's `ReqParams` happens to be a closed type.
 */
describe('the version must sit where callAPI reads it', () => {
  /** The two lines callAPI itself runs, in its own order. */
  function pathBuiltBy(params: Record<string, unknown>): string {
    const c = client()
    const options = Object.assign({}, params.options as Record<string, unknown> | undefined)
    const version = c._validateAndGetVersion('getOrder', 'orders', options.version)
    return c.endpoints.orders[version].getOrder({ ...params, path: { orderId: '123-4567890-1234567' } }).api_path
  }

  it('options.version reaches the 2026-01-01 path', () => {
    expect(pathBuiltBy({ options: { version: AMAZON_ORDERS_2026_VERSION } }))
      .toBe('/orders/2026-01-01/orders/123-4567890-1234567')
  })

  it('a TOP-LEVEL version is ignored and the call goes to v0', () => {
    // The mistake this guards. It is silent: same operation, same answer shape
    // at a glance, different API version on the wire.
    expect(pathBuiltBy({ version: AMAZON_ORDERS_2026_VERSION })).toBe('/orders/v0/orders/123-4567890-1234567')
    expect(pathBuiltBy({})).toBe('/orders/v0/orders/123-4567890-1234567')
  })

  it('every 2026 call in amazon.service.ts puts the version inside options', () => {
    const source = readFileSync(join(SRC, 'services', 'marketplaces', 'amazon.service.ts'), 'utf8')
    const inOptions = source.match(/options:\s*\{\s*version:\s*AMAZON_ORDERS_2026_VERSION\s*\}/g) ?? []
    const topLevel = source.match(/^\s*version:\s*AMAZON_ORDERS_2026_VERSION\s*,/gm) ?? []
    expect(inOptions.length).toBeGreaterThan(0) // positive control
    expect(topLevel).toEqual([])
  })
})
