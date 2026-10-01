import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ContentAddress } from '@nexus/shared/content-language'

/**
 * Qualified content receipts on a REAL multi-connection PostgreSQL (`scripts/run-real-postgres-tests.mjs`), as the
 * restricted runtime login under row-level security: the sheet's operation (`applyProductBulkSave`), the real row
 * writer, content writers, formulas, shared-text cascade and readiness producer.
 *
 * Proven here:
 *   - the receipts' final pairs are what commits, after the real readiness producer ran (it moves no owner or content);
 *   - a producer that fails rolls the whole operation back: nothing stored, nothing answered; the next operation's
 *     receipts start from the original pairs;
 *   - an attempt that must restart answers only the new attempt's receipts;
 *   - another writer's Name B committed between this operation's snapshot and its cascade makes the attempt restart, and
 *     the retry's receipt starts from Name B's pair, never from the older read;
 *   - a unit that rolls back to its savepoint contributes nothing, and the units around it keep exact receipts.
 */
const state = vi.hoisted(() => ({
  db: null as any, producerRuns: [] as string[], failProducer: null as null | 'plain' | 'restart',
  pauseRecalculation: null as null | { reached: () => void; resume: Promise<void> }, recalculations: 0, failRecalculationFor: null as string | null,
}))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`content-version-receipts-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/database-context.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/database-context.js')>()
  return { ...actual, beforeDatabaseCommit: (key: string, producer: () => Promise<unknown>) => actual.beforeDatabaseCommit(key, async () => {
    state.producerRuns.push(key)
    const failure = state.failProducer
    state.failProducer = null
    if (failure === 'plain') throw new Error('synthetic readiness producer failure')
    // The shape Prisma gives a lost serialization race: the whole transaction must run again.
    if (failure === 'restart') throw Object.assign(new Error('synthetic serialization failure'), { code: 'P2034' })
    return producer()
  }) }
})
vi.mock('./mapping/cell-formula.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./mapping/cell-formula.service.js')>()
  return { ...actual, reevaluateDependents: async (...args: Parameters<typeof actual.reevaluateDependents>) => {
    state.recalculations++
    const pause = state.pauseRecalculation
    state.pauseRecalculation = null
    if (pause) { pause.reached(); await pause.resume }
    if (state.failRecalculationFor && args[0].productId === state.failRecalculationFor) throw new Error('synthetic failure after the content write')
    return actual.reevaluateDependents(...args)
  } }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkSave, type BulkSaveUnit } from '../products/bulk-save.service.js'
import { writeContent } from './content-write.js'
import { setCellFormula } from './mapping/cell-formula.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
const german: ContentAddress = { tier: 'language', language: 'de' }
const shared = [{ marketplace: 'DE', locale: 'de' }]
let app: FastifyInstance
let account: string
let serial = 0

const productRow = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const listingRow = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const deOf = (row: { translations: Array<{ language: string; version: number; name?: string | null; description?: string | null }> }) => row.translations.find(text => text.language === 'de')!
const brandUnit = (productId: string, value: string, expectedVersion?: number): BulkSaveUnit => ({ key: `brand:${productId}:${value}`, marketplaceContexts: shared as never,
  changes: [{ id: productId, field: 'brand', value } as never], ...(expectedVersion === undefined ? {} : { expectedVersion }) })
const operation = (units: BulkSaveUnit[]) => scoped(() => applyProductBulkSave({ units }, { formulaCascade: false, logger: logger as never }))

/** A product whose German description a formula derives from the brand, and an eBay DE listing that follows it with its own pinned Name. */
async function followerFamily(prefix: string) {
  const product = await scoped(() => prisma.product.create({ data: { sku: `${prefix}-${++serial}`, name: 'source', brand: 'before', basePrice: 10 } }))
  await scoped(() => writeContent({ productId: product.id, address: german, values: { title: 'German name' }, label: 'Title' }))
  const listing = await scoped(() => prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', marketplace: 'DE', channelMarket: 'EBAY_DE', region: 'EU',
    channelConnectionId: account, followMasterDescription: true } }))
  const pin: ContentAddress = { tier: 'pin', language: 'de', coordinate: { channel: 'EBAY', market: 'DE', accountId: account } }
  await scoped(() => writeContent({ productId: product.id, address: pin, values: { title: 'Name A' }, label: 'Title' }))
  const formula = await scoped(() => setCellFormula({ productId: product.id, scope: 'master', market: 'DE', locale: 'de', fieldKey: 'description', expr: 'upper($brand)', contentAddress: german }))
  expect(formula.error).toBeNull()
  return { product, listing, pin }
}
const pairOf = (owner: { version: number }, text: { version: number } | undefined) => ({ ownerVersion: owner.version, contentVersion: text?.version ?? 0 })
/** Receipts in a stable order (the server lists them in the order of first writes: a cascade's pin can precede its source). */
const sorted = (receipts: unknown) => [...(receipts as Array<{ tier: string; listingId?: string }>)].sort((x, y) => `${x.tier}:${x.listingId ?? ''}`.localeCompare(`${y.tier}:${y.listingId ?? ''}`))

describe.skipIf(!concurrentDatabaseUrl())(`qualified content receipts on a real server (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    state.db = await concurrentDatabase()
    await scoped(async () => {
      await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
      account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-receipts-postgres', isActive: true } })).id
    })
    const { default: Fastify } = await import('fastify')
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done) })
    // A formula's own write reaches the row writer through these routes (`cell-formula.routes.ts`).
    await app.register((await import('../../routes/products.routes.js')).default, { prefix: '/api' })
    await app.register((await import('../../routes/cell-formula.routes.js')).default, { prefix: '/api' })
    await app.ready()
  }, 180_000)
  afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

  it('answers final pairs that are what committed, after the real readiness producer ran', async () => {
    const { product, listing } = await followerFamily('pg-final')
    const before = await productRow(product.id), listingBefore = await listingRow(listing.id)
    state.producerRuns.length = 0
    const result = await operation([brandUnit(product.id, 'committed', before.version)])
    expect(result.units[0].status, JSON.stringify(result.units[0].body)).toBe(200)
    expect(state.producerRuns.some(key => key.includes(product.id)), state.producerRuns.join('\n')).toBe(true)
    const after = await productRow(product.id), listingAfter = await listingRow(listing.id)
    expect(deOf(after).description).toBe('COMMITTED')
    expect(sorted(result.units[0].body.contentVersionReceipts)).toEqual([
      { tier: 'language', productId: product.id, language: 'de', before: pairOf(before, deOf(before)), after: pairOf(after, deOf(after)) },
      { tier: 'pin', productId: product.id, listingId: listing.id, language: 'de', before: pairOf(listingBefore, deOf(listingBefore)), after: pairOf(listingAfter, deOf(listingAfter)) },
    ])
  }, 120_000)

  it('a failing producer rolls the operation back whole; the next operation starts from the original pairs', async () => {
    const { product, listing } = await followerFamily('pg-producer')
    const before = await productRow(product.id), listingBefore = await listingRow(listing.id)
    state.failProducer = 'plain'
    await expect(operation([brandUnit(product.id, 'never stored', before.version)])).rejects.toThrow(/synthetic readiness producer failure/)
    expect(await productRow(product.id)).toEqual(before)
    expect(await listingRow(listing.id)).toEqual(listingBefore)
    const retried = await operation([brandUnit(product.id, 'stored', before.version)])
    const after = await productRow(product.id)
    expect(sorted(retried.units[0].body.contentVersionReceipts)[0]).toEqual({ tier: 'language', productId: product.id, language: 'de',
      before: pairOf(before, deOf(before)), after: pairOf(after, deOf(after)) })
  }, 120_000)

  it('an attempt that must restart answers only the new attempt\'s receipts', async () => {
    const { product, listing } = await followerFamily('pg-restart')
    const before = await productRow(product.id), listingBefore = await listingRow(listing.id)
    state.recalculations = 0
    state.failProducer = 'restart'
    const result = await operation([brandUnit(product.id, 'second attempt', before.version)])
    // One recalculation per attempt: the first attempt ran, was rolled back, and the second ran from the start.
    expect(state.recalculations).toBe(2)
    const after = await productRow(product.id), listingAfter = await listingRow(listing.id)
    expect(after.version).toBe(before.version + 2)
    expect(sorted(result.units[0].body.contentVersionReceipts)).toEqual([
      { tier: 'language', productId: product.id, language: 'de', before: pairOf(before, deOf(before)), after: pairOf(after, deOf(after)) },
      { tier: 'pin', productId: product.id, listingId: listing.id, language: 'de', before: pairOf(listingBefore, deOf(listingBefore)), after: pairOf(listingAfter, deOf(listingAfter)) },
    ])
  }, 120_000)

  it('another writer\'s Name B, committed after this operation\'s snapshot, restarts it; the retry starts from Name B', async () => {
    const { product, listing, pin } = await followerFamily('pg-race')
    const before = await productRow(product.id), displayed = await listingRow(listing.id)
    state.recalculations = 0
    let reached!: () => void
    const atRecalculation = new Promise<void>(resolve => { reached = resolve })
    let resume!: () => void
    state.pauseRecalculation = { reached: () => reached(), resume: new Promise<void>(resolve => { resume = resolve }) }
    // The operation writes the brand, then pauses before its formula and the cascade to the following listing.
    const running = operation([brandUnit(product.id, 'raced', before.version)])
    await atRecalculation
    // Meanwhile, on another connection: Name B on the same pinned row, committed.
    await scoped(() => writeContent({ productId: product.id, address: pin, values: { title: 'Name B' }, label: 'Title', expectedVersion: displayed.version, expectedContentVersion: deOf(displayed).version }))
    const nameB = await listingRow(listing.id)
    resume()
    const result = await running
    expect(result.units[0].status, JSON.stringify(result.units[0].body)).toBe(200)
    // The first attempt's cascade met Name B's committed row and lost: the whole operation ran again.
    expect(state.recalculations).toBe(2)
    const after = await productRow(product.id), listingAfter = await listingRow(listing.id)
    expect(deOf(listingAfter).name).toBe('Name B')
    expect(deOf(after).description).toBe('RACED')
    const receipts = sorted(result.units[0].body.contentVersionReceipts) as Array<Record<string, unknown>>
    expect(receipts).toEqual([
      { tier: 'language', productId: product.id, language: 'de', before: pairOf(before, deOf(before)), after: pairOf(after, deOf(after)) },
      { tier: 'pin', productId: product.id, listingId: listing.id, language: 'de', before: pairOf(nameB, deOf(nameB)), after: pairOf(listingAfter, deOf(listingAfter)) },
    ])
    expect(receipts[1].before).not.toEqual(pairOf(displayed, deOf(displayed)))
  }, 120_000)

  it('a unit that rolls back to its savepoint contributes nothing; the units around it keep exact receipts', async () => {
    const [first, failed, last] = [await followerFamily('pg-unit-a'), await followerFamily('pg-unit-b'), await followerFamily('pg-unit-c')]
    const [a, b, c] = await Promise.all([first, failed, last].map(({ product }) => productRow(product.id)))
    const [aListing, bListing, cListing] = await Promise.all([first, failed, last].map(({ listing }) => listingRow(listing.id)))
    // The middle unit edits its German Name; its own recalculation then fails after the write, so its savepoint takes
    // everything of it back. The units before and after feed the German formula through a fact.
    state.failRecalculationFor = failed.product.id
    const result = await operation([brandUnit(first.product.id, 'first', a.version),
      { key: 'rolled', expectedVersion: b.version, marketplaceContexts: shared as never,
        changes: [{ id: failed.product.id, field: 'name', value: 'rolled back', contentAddress: german, contentVersion: deOf(b).version } as never] },
      brandUnit(last.product.id, 'last', c.version)]).finally(() => { state.failRecalculationFor = null })
    expect(result.units.map(unit => unit.status)).toEqual([200, 500, 200])
    expect(result.units[1].body).toMatchObject({ nothingSaved: true })
    expect(result.units[1].body).not.toHaveProperty('contentVersionReceipts')
    expect(await productRow(failed.product.id)).toEqual(b)
    expect(await listingRow(failed.listing.id)).toEqual(bListing)
    for (const [index, { product, listing }, row, listingBefore] of [[0, first, a, aListing], [2, last, c, cListing]] as const) {
      const after = await productRow(product.id), listingAfter = await listingRow(listing.id)
      expect(sorted(result.units[index].body.contentVersionReceipts)).toEqual([
        { tier: 'language', productId: product.id, language: 'de', before: pairOf(row, deOf(row)), after: pairOf(after, deOf(after)) },
        { tier: 'pin', productId: product.id, listingId: listing.id, language: 'de', before: pairOf(listingBefore, deOf(listingBefore)), after: pairOf(listingAfter, deOf(listingAfter)) },
      ])
    }
  }, 180_000)
})
