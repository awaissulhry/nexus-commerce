/**
 * 2026-10-25 — an old eBay listing shell (`productType` EBAY_LISTING_SHELL: `AIREON-ALT1`, …) is checked only on Shared
 * and where it holds its own listing (`readinessDestinationAllowed`, docs/listings/READINESS-LISTING-SHELLS-2026-10-25.md).
 * Live, the shells showed on the Amazon Italy Listings page ("No variation theme on Amazon · IT").
 *
 * On the scope fixtures (PostgreSQL with the generated row-level-security policies), business F1 (eBay) plus an Amazon
 * account:
 *   · a rebuild writes a shell's rows only on Shared and its own eBay listing; an ordinary product keeps every destination;
 *   · the Amazon Italy page lists no shell; the eBay Italy page does;
 *   · a real listing alias stays on its own channel, market and account;
 *   · rows written before the rule are deleted by the minute check, which then settles (no rebuild loop).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
import { LISTING_SHELL_TYPE } from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { createScopeFixtures, type ScopeFixture, type ScopeFixtureKey } from '../../test-support/attribute-scope-fixtures.js'
import { readinessFamilies } from './listing-readiness-families.service.js'
import { reconcileFamilyReadiness, reconcileReadinessFootprint } from './readiness-index.service.js'
import { readinessCoordinateKey } from './readiness-model.js'

let fixtures: Record<ScopeFixtureKey, ScopeFixture>
const ids = { shell: '', ebay: '', amazon: '', alias: '' }
const inF1 = <T>(work: () => Promise<T>) => withWorkspace(fixtures.F1.context, work)
const coordinatesOf = (productId: string) => inF1(async () => [...new Set((await prisma.readinessIndex.findMany({ where: { productId },
  select: { channel: true, market: true, accountId: true, aliasId: true } })).map(r => JSON.stringify([r.channel, r.market, r.accountId, r.aliasId])))].sort())
const shellCoordinates = () => [JSON.stringify([null, null, null, null]), JSON.stringify(['EBAY', 'IT', ids.ebay, null])].sort()

beforeAll(async () => {
  fixtures = await createScopeFixtures(state.db.client)
  await inF1(async () => {
    ids.ebay = (await prisma.channelConnection.findFirstOrThrow({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })).id
    ids.amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', managedBy: 'oauth', isActive: true, accountLabel: 'F1 AMAZON',
      externalAccountId: 'scope-F1-AMAZON-shells' } as never })).id
    // The shell: a placeholder parent that holds one eBay IT listing, as the old eBay flat-file import made it.
    ids.shell = (await prisma.product.create({ data: { sku: 'SCOPE-F1-ALT1', name: 'Scope F1 shell', basePrice: 10, isParent: true, productType: LISTING_SHELL_TYPE } })).id
    await prisma.channelListing.create({ data: { productId: ids.shell, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT',
      channelConnectionId: ids.ebay, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'scope-item-alt1' } })
    // A real listing alias (PES.5) of the ordinary product on eBay IT, next to its main listing.
    const alias = await prisma.productListingAlias.create({ data: { productId: fixtures.F1.productId, channel: 'EBAY', marketplace: 'IT',
      channelConnectionId: ids.ebay, label: 'Listing 2' } })
    ids.alias = alias.id
    for (const aliasKey of ['', alias.id]) {
      await prisma.channelListing.create({ data: { productId: fixtures.F1.productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT',
        channelConnectionId: ids.ebay, aliasKey, aliasId: aliasKey || null, listingStatus: 'DRAFT', isPublished: false } })
    }
    for (const id of [fixtures.F1.productId, ids.shell]) await reconcileFamilyReadiness(id)
  })
}, 300_000)
afterAll(async () => { await state.db?.close() }, 30_000)

describe('an old eBay listing shell is checked only on its own listing', () => {
  it('a rebuild writes its rows on Shared and its own eBay listing only; an ordinary product keeps every destination', async () => {
    expect(await coordinatesOf(ids.shell)).toEqual(shellCoordinates())
    const ordinary = (await coordinatesOf(fixtures.F1.productId)).map(c => JSON.parse(c) as [string | null, string | null, string | null, string | null])
    expect(ordinary.some(([channel, market, accountId]) => channel === 'AMAZON' && market === 'IT' && accountId === ids.amazon)).toBe(true)
    expect(ordinary.some(([channel, market]) => channel === 'EBAY' && market !== 'IT')).toBe(true)
  })

  it('the Amazon Italy page lists no shell; the eBay Italy page does', async () => {
    expect((await inF1(() => readinessFamilies({ channel: 'AMAZON', marketplace: 'IT' }, null))).rows.map(r => r.sku)).toEqual(['SCOPE-F1'])
    expect((await inF1(() => readinessFamilies({ channel: 'EBAY', marketplace: 'IT' }, null))).rows.map(r => r.sku).sort()).toEqual(['SCOPE-F1', 'SCOPE-F1-ALT1'])
  })

  it('a real listing alias stays on its own channel, market and account', async () => {
    const rows = await inF1(() => prisma.readinessIndex.findMany({ where: { aliasId: ids.alias }, select: { channel: true, market: true, accountId: true } }))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.channel === 'EBAY' && r.market === 'IT' && r.accountId === ids.ebay)).toBe(true)
  })

  it('rows written before the rule are deleted by the minute check, which then settles', async () => {
    const coordinate = { channel: 'AMAZON', market: 'IT', accountId: ids.amazon, aliasId: null }
    await inF1(() => prisma.readinessIndex.create({ data: { productId: ids.shell, ...coordinate, coordinateKey: readinessCoordinateKey(coordinate),
      language: 'it', label: 'Amazon · IT', pct: 0, state: 'blocked', requiredFilled: 0, requiredTotal: 1, missing: [], note: null, computedAt: new Date() } }))
    expect(await inF1(reconcileReadinessFootprint)).toEqual({ removed: [], missing: [], markedFamilies: 0, shellRows: 1 })
    expect(await coordinatesOf(ids.shell)).toEqual(shellCoordinates())
    // The ordinary product's Amazon rows are untouched, and the next check finds nothing to do.
    expect(await inF1(() => prisma.readinessIndex.count({ where: { productId: fixtures.F1.productId, channel: 'AMAZON' } }))).toBeGreaterThan(0)
    expect(await inF1(reconcileReadinessFootprint)).toEqual({ removed: [], missing: [], markedFamilies: 0, shellRows: 0 })
  })
})
