/**
 * P2 (2026-09-30) — `GET /readiness?…&only=coordinate`: the answer holds only the named channel coordinate, read from
 * the index on a real PostgreSQL (PGlite). Measured on GALE-JACKET · eBay · IT: the family-wide answer was 13.1 MB —
 * every coordinate of the family, each with its optional-field list per product — for a refresh that needs one.
 * The default answer is unchanged (the scope menu and the chips need the family-wide rows).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('./family-account.js', () => ({ readFamilyAccountId: async (_id: string, channel: string) => `account-${channel}` }))
vi.mock('./workspace-destination.js', () => ({ resolveWorkspaceDestination: async (input: { accountId?: string }) => ({ accountId: input.accountId, aliasKey: null }) }))
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
