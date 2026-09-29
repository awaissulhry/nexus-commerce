import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * One sheet operation = one request, one transaction (`bulk-save.service.ts`), on a REAL multi-connection server.
 *
 * The defect this guards (measured 2026-09-29, 250-variation family, eBay · IT "Description theme"): a fill saved one
 * request per row, all at once, and each request rebuilt the whole family's readiness in its own Serializable
 * transaction — deadlocks, aborted transactions and pool timeouts; 26 of 250 rows confirmed. PGlite is one connection and
 * cannot show a race, so this runs only on a real server (`scripts/run-real-postgres-tests.mjs`).
 *
 * Proven here:
 *   - 250 rows are ONE operation: every row stored, every unit answered, and the family readiness rebuilt ONCE;
 *   - a refused row (a stale version) is refused ALONE — both of its cells — and every other row stays saved;
 *   - a savepoint undoes its own writes and its own after-commit work, and nothing of the rows before it;
 *   - a row of another business profile is refused and nothing of it changes (row-level security);
 *   - two operations on the same family at the same moment both save everything — no deadlock reaches the caller.
 */
const state = vi.hoisted(() => ({ db: null as any, producerRuns: [] as string[] }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`bulk-save-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
// Count the before-commit producers that actually RUN (the family readiness rebuild is one), not the ones registered.
vi.mock('../../lib/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/database-context.js')>()
  return { ...actual, beforeDatabaseCommit: (key: string, producer: () => Promise<unknown>) =>
    actual.beforeDatabaseCommit(key, async () => { state.producerRuns.push(key); return producer() }) }
})

import prisma from '../../db.js'
import { afterDatabaseCommit, inDatabaseTransaction, inSavepoint } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkSave, type BulkSaveUnit } from './bulk-save.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'

const OTHER_BUSINESS = 'bulk-save-other-business'
const scopedTo = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = scopedTo(LEGACY_WORKSPACE_ID)
const logger = { warn: vi.fn(), error: vi.fn() }
const THEMES = ['theme-clean', 'theme-gallery']

/** A parent with `children` variations, each with an eBay DE listing at version 1. */
async function seedFamily(root: string, children: number, run = scoped) {
  const kids = Array.from({ length: children }, (_, i) => `${root}-${String(i + 1).padStart(3, '0')}`)
  await run(async () => {
    await prisma.product.create({ data: { id: root, sku: root.toUpperCase(), name: root, basePrice: 10, isParent: true } })
    await prisma.product.createMany({ data: kids.map(id => ({ id, sku: id.toUpperCase(), name: id, basePrice: 10, parentId: root })) })
    await prisma.channelListing.createMany({ data: [root, ...kids].map(productId => ({ id: `l-${productId}`, productId, channel: 'EBAY', channelMarket: 'EBAY_DE', marketplace: 'DE', region: 'EU' })) })
  })
  return kids
}

/** Exactly the unit the sheet builds for one row's "Description theme" cell (`useChannelSheet.ts`). */
const unit = (productId: string, value: string, expectedVersion: number): BulkSaveUnit => ({
  key: `EBAY:DE::${productId}`,
  changes: [{ id: productId, field: 'attr_descriptionThemeId', value, target: 'channel', intent: 'set' } as never],
  marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE', locale: 'de', aliasKey: '' }],
  expectedVersion,
})

const themeOf = (productIds: string[], run = scoped) => run(async () => {
  const rows = await prisma.channelListing.findMany({ where: { productId: { in: productIds }, channel: 'EBAY', marketplace: 'DE' }, select: { productId: true, platformAttributes: true, version: true } })
  return new Map(rows.map(row => [row.productId, { theme: (row.platformAttributes as { descriptionThemeId?: string } | null)?.descriptionThemeId ?? null, version: row.version }]))
})

describe.skipIf(!concurrentDatabaseUrl())(`one sheet operation, one transaction (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    state.db = await concurrentDatabase()
    await state.db.pool.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [OTHER_BUSINESS])
    await scoped(async () => {
      await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
      for (const id of THEMES) await prisma.ebayDescriptionTheme.create({ data: { id, name: id, html: '<div>{{description}}</div>' } })
    })
  }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  it('saves 250 rows as ONE operation and rebuilds the family readiness once', async () => {
    const kids = await seedFamily('bs-fill', 250)
    state.producerRuns.length = 0
    const result = await scoped(() => applyProductBulkSave({ operationId: 'fill-250', units: kids.map(id => unit(id, THEMES[0], 1)) }, { formulaCascade: false, logger }))

    expect(result.units).toHaveLength(250)
    expect(result.failed, JSON.stringify(result.units.find(u => u.status !== 200))).toBe(0)
    expect(result.saved).toBe(250)
    expect(result.units.every(u => u.body.versionOf === 'channelListing' && typeof u.body.currentVersion === 'number')).toBe(true)
    const stored = await themeOf(kids)
    expect([...stored.values()].filter(row => row.theme === THEMES[0])).toHaveLength(250)
    // Each unit's answer carries the version its row holds now, so the sheet's next edit chains without a reload.
    for (const u of result.units) expect(u.body.currentVersion).toBe(stored.get(u.key.split('::')[1])!.version)
    // The family readiness rebuild is keyed by family: 250 rows, one rebuild (before: one per row, all at once).
    const readinessRuns = state.producerRuns.filter(key => key.includes('bs-fill'))
    expect(readinessRuns, state.producerRuns.join('\n')).toHaveLength(1)
  }, 240_000)

  it('refuses a stale row alone — both of its cells — and keeps every other row', async () => {
    const kids = await seedFamily('bs-partial', 6)
    const stale = kids[2]
    const units = kids.map(id => unit(id, THEMES[1], 1))
    // A version this row never had (it is at 1): the listing moved since the sheet read it.
    units[2] = { ...unit(stale, THEMES[1], 7), changes: [...units[2].changes, { id: stale, field: 'attr_descriptionThemeId', value: THEMES[0], target: 'channel', intent: 'set' } as never] }
    const result = await scoped(() => applyProductBulkSave({ units }, { formulaCascade: false, logger }))

    expect(result.saved).toBe(5)
    expect(result.failed).toBe(1)
    const refused = result.units.find(u => u.key.endsWith(stale))!
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: 'VERSION_CONFLICT', versionOf: 'channelListing', currentVersion: 1 })
    const stored = await themeOf(kids)
    expect(stored.get(stale)).toEqual({ theme: null, version: 1 })
    for (const id of kids.filter(id => id !== stale)) expect(stored.get(id)!.theme).toBe(THEMES[1])
  }, 120_000)

  it('a savepoint undoes its own writes and its own after-commit work, and nothing else', async () => {
    const [a, b] = await seedFamily('bs-savepoint', 2)
    const ran: string[] = []
    const outcome = await scoped(() => inDatabaseTransaction(prisma as never, async () => {
      const first = await inSavepoint(async () => {
        await prisma.product.update({ where: { id: a }, data: { name: 'kept' } })
        await afterDatabaseCommit('first', async () => { ran.push('first') })
      })
      const second = await inSavepoint(async () => {
        await prisma.product.update({ where: { id: b }, data: { name: 'undone' } })
        await afterDatabaseCommit('second', async () => { ran.push('second') })
        throw new Error('refused after writing')
      })
      return [first.ok, second.ok]
    }))
    expect(outcome).toEqual([true, false])
    const names = await scoped(() => prisma.product.findMany({ where: { id: { in: [a, b] } }, select: { id: true, name: true } }))
    expect(Object.fromEntries(names.map(row => [row.id, row.name]))).toEqual({ [a]: 'kept', [b]: b })
    expect(ran).toEqual(['first'])
  }, 120_000)

  it('refuses a row of another business profile and changes nothing of it', async () => {
    const mine = await seedFamily('bs-mine', 3)
    const theirs = await seedFamily('bs-theirs', 1, scopedTo(OTHER_BUSINESS))
    const result = await scoped(() => applyProductBulkSave({ units: [...mine.map(id => unit(id, THEMES[0], 1)), unit(theirs[0], THEMES[0], 1)] }, { formulaCascade: false, logger }))

    const foreign = result.units.find(u => u.key.endsWith(theirs[0]))!
    const refusedCells = Array.isArray(foreign.body.errors) ? foreign.body.errors.length : 0
    expect(foreign.status >= 400 || refusedCells > 0 || foreign.body.updated === 0, JSON.stringify(foreign)).toBe(true)
    expect((await themeOf(theirs, scopedTo(OTHER_BUSINESS))).get(theirs[0])).toEqual({ theme: null, version: 1 })
    const stored = await themeOf(mine)
    for (const id of mine) expect(stored.get(id)!.theme).toBe(THEMES[0])
  }, 120_000)

  it('saves two operations on the same family at the same moment — no deadlock reaches the caller', async () => {
    const kids = await seedFamily('bs-race', 40)
    const halves = [kids.slice(0, 20), kids.slice(20)]
    const results = await Promise.all(halves.map((half, i) => scoped(() => applyProductBulkSave({ units: half.map(id => unit(id, THEMES[i], 1)) }, { formulaCascade: false, logger }))))

    expect(results.map(r => [r.saved, r.failed])).toEqual([[20, 0], [20, 0]])
    const stored = await themeOf(kids)
    halves.forEach((half, i) => { for (const id of half) expect(stored.get(id)!.theme).toBe(THEMES[i]) })
  }, 180_000)
})
