/**
 * P2 (2026-09-30) — `GET /readiness?…&only=coordinate`: the answer holds only the named channel coordinate, read from
 * the index on a real PostgreSQL (PGlite). Measured on GALE-JACKET · eBay · IT: the family-wide answer was 13.1 MB —
 * every coordinate of the family, each with its optional-field list per product — for a refresh that needs one.
 * The default answer is unchanged (the scope menu and the chips need the family-wide rows).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, indexReads: [] as Array<{ where?: Record<string, unknown> }> }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  // Every `readinessIndex.findMany` the service asks, for the query-shape test below (review WP4 #8).
  const client = state.db.client
  const index = new Proxy(client.readinessIndex, { get: (target, key) => key === 'findMany'
    ? (args: { where?: Record<string, unknown> }) => { state.indexReads.push(args); return target.findMany(args) }
    : Reflect.get(target, key) })
  return { default: new Proxy(client, { get: (target, key) => key === 'readinessIndex' ? index : Reflect.get(target, key) }) }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('./family-account.js', () => ({ readFamilyAccountId: async (_id: string, channel: string) => `account-${channel}` }))
// A listing is resolved for real (review WP4 #1): the primary listing's `aliasKey` is '' in the table.
vi.mock('./workspace-destination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace-destination.js')>()
  return { ...actual, resolveWorkspaceDestination: async (input: Parameters<typeof actual.resolveWorkspaceDestination>[0]) =>
    input.listingId ? actual.resolveWorkspaceDestination(input) : { accountId: input.accountId, aliasKey: null } }
})
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getProductReadiness as readiness, ReadinessCoordinateRequiredError } from './scope-readiness.service.js'

/** Production runs with business profiles on: every call here runs inside a business, as real callers do. */
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const getProductReadiness = (input: Parameters<typeof readiness>[0]) => scoped(() => readiness(input))

const PRODUCTS = ['ready-parent', 'ready-a', 'ready-b', 'ready-c']
const FIELDS = Array.from({ length: 60 }, (_, i) => ({ field: `optional_field_${i}`, label: `Optional field ${i}` }))

beforeAll(() => scoped(async () => {
  for (const [channel, code, languages] of [['AMAZON', 'IT', ['it']], ['EBAY', 'IT', ['it']], ['EBAY', 'DE', ['de']], ['AMAZON', 'BE', ['nl', 'fr']]] as const) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: languages[0], languages: [...languages] } })
  }
  await prisma.product.create({ data: { id: PRODUCTS[0], sku: 'READY-PARENT', name: 'Parent', basePrice: 10, isParent: true } })
  for (const id of PRODUCTS.slice(1)) await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, parentId: PRODUCTS[0] } })
  const coordinates: Array<[string | null, string | null, string | null, string]> = [
    [null, null, null, 'it'], [null, null, null, 'de'],
    ['EBAY', 'IT', 'store-a', 'it'], ['EBAY', 'IT', 'store-b', 'it'], ['EBAY', 'DE', 'store-a', 'de'], ['AMAZON', 'IT', 'account-AMAZON', 'it'], ['AMAZON', 'IT', 'account-AMAZON', 'de'],
  ]
  for (const [channel, market, accountId, language] of coordinates) {
    for (const productId of PRODUCTS) {
      await prisma.readinessIndex.create({ data: {
        productId, coordinateKey: channel ? JSON.stringify([channel, market, accountId, null]) : '[]', channel, market, accountId, language,
        label: channel ? `${channel} · ${market}` : 'Shared product', pct: 50, state: 'warn', requiredFilled: 1, requiredTotal: 2,
        missing: [{ productId, field: 'brand', label: 'Brand', reason: 'empty' }], optionalFilled: 2, optionalTotal: 62, optionalMissing: FIELDS,
        mappingRules: channel ? 3 : null, computedAt: new Date('2026-09-30T06:00:00Z'),
      } })
    }
  }
}), 120_000)
afterAll(async () => { await state.db?.close() })

describe('readiness for the open coordinate', () => {
  it('answers only the named coordinate: its chip and its matrix entries', async () => {
    const full = await getProductReadiness({ productId: 'ready-b', market: 'IT', channel: 'EBAY', accountId: 'store-a', locale: 'it' })
    const one = await getProductReadiness({ productId: 'ready-b', market: 'IT', channel: 'EBAY', accountId: 'store-a', locale: 'it', onlyCoordinate: true })
    expect(one.scopes.map(scope => scope.id)).toEqual(['EBAY'])
    expect(one.matrix.map(entry => entry.coordinateKey)).toEqual(['["EBAY","IT","store-a",null]'])
    // The same entry and the same chip as the family-wide answer; the chip without the lists its entry carries.
    expect(one.matrix).toEqual(full.matrix.filter(entry => entry.coordinateKey === '["EBAY","IT","store-a",null]'))
    const { missing: _missing, optionalMissing: _optional, ...chip } = full.scopes.find(scope => scope.id === 'EBAY')!
    expect(one.scopes[0]).toEqual(chip)
    expect(one.matrix[0].optionalMissing).toHaveLength(FIELDS.length * PRODUCTS.length)
    // 6 coordinates × 4 products × 60 optional fields in the family answer; one coordinate here.
    expect(JSON.stringify(one).length * 5).toBeLessThan(JSON.stringify(full).length)
  })

  it('keeps every language of the coordinate, and refuses to guess a coordinate it was not given', async () => {
    const amazon = await getProductReadiness({ productId: 'ready-a', market: 'IT', channel: 'AMAZON', accountId: 'account-AMAZON', onlyCoordinate: true })
    expect(amazon.scopes.map(scope => scope.id)).toEqual(['AMAZON'])
    expect(amazon.scopes[0].languages?.map(entry => entry.language).sort()).toEqual(['de', 'it'])
    expect(amazon.matrix.map(entry => [entry.coordinateKey, entry.language]).sort()).toEqual([['["AMAZON","IT","account-AMAZON",null]', 'de'], ['["AMAZON","IT","account-AMAZON",null]', 'it']])
    await expect(getProductReadiness({ productId: 'ready-a', market: 'IT', channel: 'EBAY', onlyCoordinate: true })).rejects.toBeInstanceOf(ReadinessCoordinateRequiredError)
    await expect(getProductReadiness({ productId: 'ready-a', market: 'IT', onlyCoordinate: true })).rejects.toBeInstanceOf(ReadinessCoordinateRequiredError)
  })

  it('leaves the default answer family-wide', async () => {
    const full = await getProductReadiness({ productId: 'ready-a', market: 'IT', channel: 'EBAY', accountId: 'store-a', locale: 'it' })
    expect(full.scopes.map(scope => scope.id)).toEqual(['master', 'AMAZON', 'EBAY'])
    expect(new Set(full.matrix.map(entry => entry.coordinateKey)).size).toBe(5)
  })
})

describe('readiness for the open channel scope (audit B02)', () => {
  const coordinate = '["EBAY","IT","store-a",null]'

  it('answers every chip of the market and the open coordinate\'s matrix only', async () => {
    const full = await getProductReadiness({ productId: 'ready-b', market: 'IT', channel: 'EBAY', accountId: 'store-a', locale: 'it' })
    const open = await getProductReadiness({ productId: 'ready-b', market: 'IT', channel: 'EBAY', accountId: 'store-a', locale: 'it', onlyScope: true })
    // The chips the scope menu shows, each the family-wide answer's without the lists its matrix entry carries.
    expect(open.scopes.map(scope => scope.id)).toEqual(['master', 'AMAZON', 'EBAY'])
    expect(open.scopes).toEqual(full.scopes.map(({ missing: _missing, optionalMissing: _optional, ...chip }) => chip))
    // The Errors tab and the Variants projection read the open coordinate's entries, in the server's order.
    expect(open.matrix).toEqual(full.matrix.filter(entry => entry.coordinateKey === coordinate))
    expect(open.computedAt).toBe(full.computedAt)
    // 6 coordinates × 4 products × 60 optional fields in the family answer; one coordinate and five small chips here.
    expect(JSON.stringify(open).length * 5).toBeLessThan(JSON.stringify(full).length)
  })

  it('keeps every language of the open coordinate, and refuses to guess a coordinate it was not given', async () => {
    const amazon = await getProductReadiness({ productId: 'ready-a', market: 'IT', channel: 'AMAZON', accountId: 'account-AMAZON', locale: 'it', onlyScope: true })
    expect(amazon.scopes.map(scope => scope.id)).toEqual(['master', 'AMAZON', 'EBAY'])
    expect(amazon.matrix.map(entry => [entry.coordinateKey, entry.language])).toEqual([['["AMAZON","IT","account-AMAZON",null]', 'it'], ['["AMAZON","IT","account-AMAZON",null]', 'de']])
    await expect(getProductReadiness({ productId: 'ready-a', market: 'IT', channel: 'EBAY', onlyScope: true })).rejects.toBeInstanceOf(ReadinessCoordinateRequiredError)
    await expect(getProductReadiness({ productId: 'ready-a', market: 'IT', onlyScope: true })).rejects.toBeInstanceOf(ReadinessCoordinateRequiredError)
  })

  // Review WP4 #8 — the open coordinate's rows are read for this market (or GLOBAL), never every market of the account.
  it('reads the open coordinate\'s rows of this market only', async () => {
    state.indexReads.length = 0
    const open = await getProductReadiness({ productId: 'ready-b', market: 'IT', channel: 'EBAY', accountId: 'store-a', locale: 'it', onlyScope: true })
    expect(open.matrix.map(entry => entry.coordinateKey)).toEqual([coordinate])
    const narrowed = state.indexReads.filter(args => args.where?.channel === 'EBAY')
    expect(narrowed).toHaveLength(1)
    expect(narrowed[0].where!.market).toEqual({ in: ['IT', 'GLOBAL'] })
  })

  /**
   * Review WP4 #1 — every "Open listing" link names the PRIMARY listing, whose `aliasKey` is '' in the table, while the
   * index keeps the primary band's `aliasId` NULL. Before: the read filtered `aliasId: ''` and the page showed
   * "Readiness has not been computed" on the Errors tab, unknown Variants progress and a "Not computed" chip.
   */
  it('opened on the primary listing, answers the listing\'s coordinate', async () => {
    const store = await scoped(() => prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'primary-listing', isActive: true, isPrimary: true, externalAccountId: 'FAKE-EBAY' } }))
    const listing = await scoped(async () => {
      for (const productId of PRODUCTS) await prisma.readinessIndex.create({ data: {
        productId, coordinateKey: JSON.stringify(['EBAY', 'IT', store.id, null]), channel: 'EBAY', market: 'IT', accountId: store.id, language: 'it',
        label: 'EBAY · IT', pct: 50, state: 'warn', requiredFilled: 1, requiredTotal: 2, missing: [{ productId, field: 'brand', label: 'Brand', reason: 'empty' }],
        optionalFilled: 2, optionalTotal: 62, optionalMissing: FIELDS, mappingRules: 3, computedAt: new Date('2026-09-30T06:00:00Z'),
      } })
      return prisma.channelListing.create({ data: { productId: PRODUCTS[0], channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU', channelConnectionId: store.id } })
    })
    expect(listing.aliasKey).toBe('')
    const byAccount = await getProductReadiness({ productId: 'ready-b', market: 'IT', channel: 'EBAY', accountId: store.id, locale: 'it', onlyScope: true })
    const byListing = await getProductReadiness({ productId: 'ready-b', market: 'IT', channel: 'EBAY', listingId: listing.id, locale: 'it', onlyScope: true })
    expect(byListing.matrix.map(entry => entry.coordinateKey)).toEqual([JSON.stringify(['EBAY', 'IT', store.id, null])])
    expect(byListing.matrix).toEqual(byAccount.matrix)
    // The open channel's chip too (broken before `only=scope`, by the same '').
    const chip = byListing.scopes.find(scope => scope.id === 'EBAY')!
    expect(chip.state).toBe('warn')
    expect(chip).toEqual(byAccount.scopes.find(scope => scope.id === 'EBAY'))
  })
})
