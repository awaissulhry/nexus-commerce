/**
 * 2.4 — what the Variants page's two writes ANSWER, on an eBay · IT draft family.
 *
 *  - Include / exclude and Save mapping answer the version THEY wrote. The read after the commit may already carry
 *    someone else's next write; the page used to receive that version and count the other write as its own, so its
 *    next save passed over it without a conflict.
 *  - A Save mapping whose eBay order token moved (a variant's eBay row changed: a tick, a pin, a cascade) answers
 *    409 `version_conflict` with the current page — never the 500 `studio_request_failed` a code-less
 *    `MappingConflict` used to become.
 *
 * The other write is made between the commit and the read after it: the readiness producer (the last step inside the
 * transaction) marks the commit, and the read's first step makes the other write once. On an in-process PostgreSQL
 * (PGlite) with the generated schema and the production row policies. Every id is invented.
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/family-projection-write-version.vitest.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
const race = vi.hoisted(() => ({ armed: false, committed: false, other: null as null | (() => Promise<unknown>) }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
/* The last step inside each write's transaction: it marks the commit as next. */
vi.mock('./readiness-index.service.js', async original => ({
  ...await original<typeof import('./readiness-index.service.js')>(),
  produceReadinessForProducts: vi.fn(async () => { race.committed = true }),
}))
/* The first step of every projection read: once armed, the read right after the commit lets the other write land first. */
vi.mock('./workspace-destination.js', async original => {
  const real = await original<typeof import('./workspace-destination.js')>()
  return {
    ...real,
    resolveWorkspaceDestination: vi.fn(async (...args: Parameters<typeof real.resolveWorkspaceDestination>) => {
      if (race.armed && race.committed && race.other) { race.armed = false; await race.other() }
      return real.resolveWorkspaceDestination(...args)
    }),
  }
})

import Fastify from 'fastify'
import studioRoutes from '../../routes/product-studio.routes.js'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getProjectionRead, writeProjectionInclusion, writeProjectionMapping } from './family-projection.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ebay = { productId: 'wv-demo', channel: 'EBAY', market: 'IT', accountId: 'ebay-wv', includeOrder: false }
const PARENT_ROW = 'ebay-wv-wv-demo'
const VARIANTS = [{ id: 'wv-a', colore: 'Nero' }, { id: 'wv-b', colore: 'Rosso' }]
const version = async () => (await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: PARENT_ROW } }))).version
/** Someone else's write to the parent listing, landing between this write's commit and the read after it. */
const armOtherWrite = () => {
  Object.assign(race, { armed: true, committed: false, other: () => prisma.channelListing.update({ where: { id: PARENT_ROW }, data: { version: { increment: 1 } } }) })
}

beforeAll(() => scoped(async () => {
  await prisma.product.create({ data: { id: 'wv-demo', sku: 'WV-JACKET', name: 'Write version jacket', isParent: true, basePrice: 50, productType: 'OUTERWEAR', variationAxes: ['Colore'] } as never })
  for (const v of VARIANTS) {
    await prisma.product.create({ data: { id: v.id, sku: `WV-JACKET-${v.id.slice(-1).toUpperCase()}`, name: v.id, parentId: 'wv-demo', basePrice: 50, productType: 'OUTERWEAR',
      categoryAttributes: { variations: { Colore: v.colore } } } as never })
  }
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'EBAY IT', region: 'EU', currency: 'EUR', language: 'it' } as never })
  await prisma.channelConnection.create({ data: { id: 'ebay-wv', externalAccountId: 'ebay-wv', channelType: 'EBAY', isPrimary: true, isActive: true } })
  for (const id of ['wv-demo', ...VARIANTS.map(v => v.id)]) {
    const variant = VARIANTS.find(v => v.id === id)
    await prisma.channelListing.create({ data: { id: `ebay-wv-${id}`, productId: id, channel: 'EBAY', marketplace: 'IT', region: 'EU', channelMarket: 'EBAY_IT', channelConnectionId: 'ebay-wv', aliasKey: '', listingStatus: 'DRAFT',
      platformAttributes: { categoryId: '100', conditionId: '1000', itemSpecifics: variant ? { Colore: variant.colore } : {} } } as never })
  }
  await prisma.categorySchema.create({ data: { channel: 'EBAY', marketplace: 'IT', productType: '100', schemaVersion: 'fixture', expiresAt: new Date('2099-01-01'), schemaDefinition: { aspects: [
    { id: 'Colore', label: 'Colore', localizedName: 'Colore', englishName: 'Color', kind: 'select', options: ['Nero', 'Rosso'], enumMode: 'open', required: false, variantEligible: true },
  ], conditions: [{ id: '1000', label: 'Nuovo' }] } } })
}), 60_000)

afterAll(async () => { await state.db?.close?.() })

describe('2.4 — a write answers the version it wrote', () => {
  it('include / exclude: the next write someone made after the commit is not reported as this one', async () => {
    const before = await version()
    armOtherWrite()
    const out = await scoped(() => writeProjectionInclusion({ ...ebay, expectedVersion: before, changes: [{ id: 'wv-b', included: false }] }))
    expect(await version()).toBe(before + 2) // the other write landed after this one
    expect(out.version).toBe(before + 1)
    expect(out.results).toEqual([expect.objectContaining({ id: 'wv-b', included: false })])
  })

  it('Save mapping: the same', async () => {
    const before = await version()
    armOtherWrite()
    const read = await scoped(() => writeProjectionMapping({ ...ebay, expectedVersion: before, mapping: [{ axisKey: 'Colore', target: 'Colore', order: 0 }] }))
    expect(await version()).toBe(before + 2)
    expect(read.version).toBe(before + 1)
    expect(read.mapping.filter(m => m.target).map(m => [m.axisKey, m.target])).toEqual([['Colore', 'Colore']])
  })
})

describe('2.4 — a Save mapping whose eBay order token moved', () => {
  const patch = async (payload: Record<string, unknown>) => {
    const app = Fastify()
    app.addHook('onRequest', (_request, _reply, done) => { withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done) })
    await app.register(studioRoutes, { prefix: '/api' })
    await app.ready()
    try {
      return await app.inject({ method: 'PATCH', url: '/api/products/wv-demo/studio/projection?channel=EBAY&market=IT&accountId=ebay-wv', payload })
    } finally { await app.close() }
  }

  it('answers 409 version_conflict with the current page, not a 500; read again at the same version, it saves', async () => {
    const read = await scoped(() => getProjectionRead({ ...ebay, includeOrder: true }))
    const token = read.order?.token
    expect(token, read.order?.reason).toEqual(expect.any(String))
    // a variant's eBay row moves (a tick on another tab, a pin, a cascade): the order token moves, the parent version does not
    await scoped(() => prisma.channelListing.update({ where: { id: 'ebay-wv-wv-a' }, data: { version: { increment: 1 } } }))
    expect(await version()).toBe(read.version)
    const body = (t: string) => ({ expectedVersion: read.version, mapping: [{ axisKey: 'Colore', target: 'Colore', order: 0 }], presentationOrder: { expectedToken: t, change: { axes: ['Colore'] } } })

    const stale = await patch(body(token!))
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json()).toMatchObject({ error: 'version_conflict', current: { version: read.version } })
    expect(await version()).toBe(read.version)

    const fresh = await scoped(() => getProjectionRead({ ...ebay, includeOrder: true }))
    expect(fresh.order?.token).not.toBe(token)
    const saved = await patch(body(fresh.order!.token!))
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().version).toBe(read.version + 1)
  })
})
