import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { Prisma } from '@prisma/client'
import type { formulaDatabase } from '../test-support/formula-database.js'
import type { concurrentDatabase } from '../test-support/concurrent-database.js'

const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof formulaDatabase>> | Awaited<ReturnType<typeof concurrentDatabase>> | null,
  jobs: [] as string[], statements: null as number | null,
}))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../test-support/concurrent-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase({ timeZone: 'Europe/Rome' }) : await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, readCacheQueue: null, readinessQueue: null,
  searchIndexQueue: {}, addJobSafely: vi.fn(async (_queue, _name, data: { productId: string }) => { state.jobs.push(data.productId); return { enqueued: true } }),
}))
import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { ProductReadCacheService, productReadCacheService } from './product-read-cache.service.js'
import { concurrentDatabaseUrl } from '../test-support/concurrent-database.js'

const scope = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = scope(LEGACY_WORKSPACE_ID)
const rowMode = new ProductReadCacheService()
// Both modes retain refreshMany's transaction, retry and post-commit code. Only persistence differs.
const rowRefresh = ProductReadCacheService.prototype.refreshInTransaction
rowMode.refreshInTransaction = (tx, ids) => rowRefresh.call(rowMode, tx, ids, false)
let sequence = 0
const restoreCounters: Array<() => void> = []
beforeAll(() => {
  for (const pg of new Set([import.meta.url, new URL('../../../../packages/database/package.json', import.meta.url).href].map(path => createRequire(path)('pg')))) {
    const original = pg.Client.prototype.query
    pg.Client.prototype.query = function (...args: unknown[]) {
      if (state.statements !== null) state.statements += (args[0] as { constructor?: { name?: string } })?.constructor?.name === 'ScopedQuery' ? 2 : 1
      return original.apply(this, args)
    }
    restoreCounters.push(() => { pg.Client.prototype.query = original })
  }
})
afterAll(async () => { for (const restore of restoreCounters) restore(); await state.db?.close() })

async function fixture(count: number) {
  const root = `cache-batch-${++sequence}`, other = `${root}-other`
  const ids = Array.from({ length: count }, (_, i) => `${root}-${String(i).padStart(3, '0')}`)
  await scoped(async () => {
    const family = await prisma.productFamily.create({ data: { code: root, label: 'Family "quotes" · à' } })
    const workflow = await prisma.productWorkflow.create({ data: { code: root, label: 'Workflow' } })
    const stage = await prisma.workflowStage.create({ data: { workflowId: workflow.id, code: 'ready', label: 'Ready', isPublishable: true } })
    const category = await prisma.category.create({ data: { slug: root, name: { en: 'Category', it: 'Categoria' } } })
    await prisma.categoryClosure.create({ data: { ancestorId: category.id, descendantId: category.id, depth: 0 } })
    await prisma.product.createMany({ data: [root, other].map(id => ({ id, sku: id, name: id, basePrice: 1, isParent: true })) })
    await prisma.product.createMany({ data: ids.map((id, i) => ({ id, sku: id, name: `Value "${i}" · à`, parentId: root,
      basePrice: i === 0 ? '12345678.90' : '0.01', brand: i === 0 ? 'Brand' : null, description: i === 0 ? 'Description' : null,
      gtin: i === 0 ? '0000000000000' : null, syncChannels: i === 0 ? ['AMAZON', 'EBAY'] : [], fulfillmentMethod: 'FBM',
      familyId: i === 0 ? family.id : null, workflowStageId: i === 0 ? stage.id : null,
      version: i + 2, totalStock: i, createdAt: new Date('2025-01-02T03:04:05.678Z'), updatedAt: new Date('2025-02-03T04:05:06.789Z'),
      deletedAt: i === 2 ? new Date('2025-03-04T05:06:07.890Z') : null,
    })) })
    await prisma.productCategory.create({ data: { productId: ids[0], categoryId: category.id, isPrimary: true } })
    await prisma.productImage.create({ data: { productId: ids[0], url: 'https://fixture.invalid/cache.jpg', type: 'MAIN' } })
    await prisma.channelListing.create({ data: { productId: ids[0], channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU', listingStatus: 'ACTIVE', isPublished: true, followMasterPrice: false } })
  })
  return { root, other, ids, all: [root, ...ids] }
}

const snapshot = (ids: string[], includeClock = false) => scoped(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
  SELECT id, CASE WHEN ${includeClock} THEN to_jsonb(cache) ELSE to_jsonb(cache) - 'cacheRefreshedAt' END AS value,
    "basePrice"::text AS decimal, "familyJson" IS NULL AS family_null, "workflowStageJson" IS NULL AS workflow_null,
    "coverageJson" IS NULL AS coverage_null, "categoryPathJson" IS NULL AS category_null
  FROM "ProductReadCache" AS cache WHERE id = ANY(${ids}::text[]) ORDER BY id
`)
const refresh = (service: ProductReadCacheService, ids: string[]) => scoped(() => service.refreshMany(ids))
async function withSearch(work: () => Promise<void>) {
  const previous = process.env.SEARCH_ENGINE_ENABLED
  process.env.SEARCH_ENGINE_ENABLED = '1'; state.jobs.length = 0
  try { await work() } finally { if (previous === undefined) delete process.env.SEARCH_ENGINE_ENABLED; else process.env.SEARCH_ENGINE_ENABLED = previous }
}
async function ddl(sql: string) {
  if ('pool' in state.db!) await state.db.pool.query(sql)
  else await state.db!.db.exec(sql)
}

it('matches retained row persistence for SQL/JSON null, decimals, dates, arrays and nested JSON on insert and update', async () => {
  const f = await fixture(3)
  await refresh(rowMode, f.ids)
  const inserted = await snapshot(f.all)
  expect(inserted).toHaveLength(4)
  expect(inserted.find(row => row.id === f.ids[0])?.decimal).toBe('12345678.90')
  expect(inserted.some(row => row.family_null === false && row.workflow_null === false && row.category_null === false)).toBe(true)
  await scoped(() => prisma.productReadCache.deleteMany({ where: { id: { in: f.all } } }))
  const started = new Date()
  await refresh(productReadCacheService, f.ids)
  expect(await snapshot(f.all)).toEqual(inserted)
  const refreshed = await scoped(() => prisma.productReadCache.findMany({ where: { id: { in: f.all } }, select: { cacheRefreshedAt: true } }))
  expect(refreshed.every(row => row.cacheRefreshedAt >= started)).toBe(true)

  await scoped(() => prisma.product.update({ where: { id: f.ids[0] }, data: { name: 'Next', basePrice: '0.02', familyId: null, workflowStageId: null, syncChannels: [] } }))
  await refresh(rowMode, f.ids)
  const updated = await snapshot(f.all)
  await scoped(() => prisma.productReadCache.updateMany({ where: { id: { in: f.all } }, data: {
    name: 'stale', basePrice: '99.99', familyJson: Prisma.JsonNull, workflowStageJson: Prisma.DbNull,
  } }))
  await refresh(productReadCacheService, f.ids)
  expect(await snapshot(f.all)).toEqual(updated)
})

it('keeps cache query cost bounded as a family grows from 5 to 21 requested children', async () => {
  const f = await fixture(21)
  const measure = async (ids: string[]) => {
    state.statements = 0
    try { await refresh(productReadCacheService, ids); return state.statements }
    finally { state.statements = null }
  }
  const small = await measure(f.ids.slice(0, 5)), large = await measure(f.ids)
  console.log('CACHE_REFRESH_SQL', JSON.stringify({ fiveChildren: small, twentyOneChildren: large }))
  expect(small).toBeGreaterThan(0)
  expect(await scoped(() => prisma.productReadCache.count({ where: { id: { in: f.all } } }))).toBe(22)
  expect(large, `5 children: ${small} SQL; 21 children: ${large} SQL`).toBeLessThanOrEqual(small + 2)
})

it('refreshes former/current parents, removes deleted cache rows, and invalidates parents only after success', async () => {
  const f = await fixture(2)
  await refresh(productReadCacheService, [...f.ids, f.other])
  await withSearch(async () => {
    await scoped(() => prisma.product.update({ where: { id: f.ids[0] }, data: { parentId: f.other } }))
    await refresh(productReadCacheService, [f.ids[0]])
    const rows = await scoped(() => prisma.productReadCache.findMany({ where: { id: { in: [f.root, f.other, f.ids[0]] } } }))
    expect(rows.find(row => row.id === f.root)).toMatchObject({ childCount: 1, rollupChannelKeys: [], imageUrl: null })
    expect(rows.find(row => row.id === f.other)).toMatchObject({ childCount: 1, rollupChannelKeys: ['EBAY_IT'], imageUrl: 'https://fixture.invalid/cache.jpg' })
    expect(rows.find(row => row.id === f.ids[0])?.parentId).toBe(f.other)
    expect(state.jobs).toHaveLength(2)
    expect(new Set(state.jobs)).toEqual(new Set([f.root, f.other]))
    state.jobs.length = 0
    await scoped(async () => {
      await prisma.productImage.deleteMany({ where: { productId: f.ids[0] } })
      await prisma.channelListing.deleteMany({ where: { productId: f.ids[0] } })
      await prisma.productCategory.deleteMany({ where: { productId: f.ids[0] } })
      await prisma.product.delete({ where: { id: f.ids[0] } })
    })
    await refresh(productReadCacheService, [f.ids[0]])
    expect(await scoped(() => prisma.productReadCache.findUnique({ where: { id: f.ids[0] } }))).toBeNull()
    expect(await scoped(() => prisma.productReadCache.findUniqueOrThrow({ where: { id: f.other } }))).toMatchObject({ childCount: 0, imageUrl: null, rollupChannelKeys: [] })
    expect(state.jobs).toEqual([f.other])
  })
})

it('rolls back completed upserts and parent notifications when the later orphan cleanup fails', async () => {
  const f = await fixture(2)
  await refresh(rowMode, f.ids)
  const orphan = `${f.root}-orphan`
  const { workspaceId: _workspaceId, ...copy } = await scoped(() => prisma.productReadCache.findUniqueOrThrow({ where: { id: f.ids[0] } }))
  await scoped(() => prisma.productReadCache.create({ data: { ...copy, id: orphan, name: 'cleanup refusal' } as never }))
  const before = await snapshot([...f.all, orphan], true)
  await scoped(async () => {
    await prisma.product.update({ where: { id: f.ids[0] }, data: { name: 'changed source' } })
    await prisma.product.update({ where: { id: f.ids[1] }, data: { name: 'other changed source' } })
  })
  // This statement runs AFTER every upsert, so one atomic INSERT alone cannot make this rollback test pass.
  await ddl(`CREATE FUNCTION reject_batch_cache() RETURNS trigger AS $$ BEGIN IF OLD.name = 'cleanup refusal' THEN RAISE EXCEPTION 'cache fixture refusal'; END IF; RETURN OLD; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_batch_cache BEFORE DELETE ON "ProductReadCache" FOR EACH ROW EXECUTE FUNCTION reject_batch_cache();`)
  try {
    await withSearch(async () => {
      for (const service of [rowMode, productReadCacheService]) {
        await expect(refresh(service, [...f.ids, orphan])).rejects.toThrow('cache fixture refusal')
        expect(await snapshot([...f.all, orphan], true)).toEqual(before)
        expect(state.jobs).toEqual([])
      }
    })
  } finally { await ddl('DROP TRIGGER reject_batch_cache ON "ProductReadCache"; DROP FUNCTION reject_batch_cache();') }
  await refresh(productReadCacheService, [...f.ids, orphan])
  expect((await scoped(() => prisma.productReadCache.findUniqueOrThrow({ where: { id: f.ids[0] } }))).name).toBe('changed source')
  expect((await scoped(() => prisma.productReadCache.findUniqueOrThrow({ where: { id: f.ids[1] } }))).name).toBe('other changed source')
  expect(await scoped(() => prisma.productReadCache.findUnique({ where: { id: orphan } }))).toBeNull()
})

it.skipIf(!concurrentDatabaseUrl())('refuses a foreign cache conflict with the actual runtime role, leaving its own neighbor and notifications unchanged', async () => {
  const db = state.db as Awaited<ReturnType<typeof concurrentDatabase>>
  const previous = process.env.NEXUS_WORKSPACES_ENABLED
  process.env.NEXUS_WORKSPACES_ENABLED = '1'
  try {
    expect(await scoped(() => prisma.$queryRaw`SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`))
      .toEqual([{ role: 'nexus_workspace_runtime', superuser: false, bypass: false }])
    const f = await fixture(2)
    await refresh(rowMode, f.ids)
    const foreign = 'cache-batch-foreign'
    await db.pool.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [foreign])
    const outside = scope(foreign)
    const original = await scoped(() => prisma.productReadCache.findUniqueOrThrow({ where: { id: f.ids[1] } }))
    const { workspaceId: _workspaceId, ...copy } = original
    await scoped(() => prisma.productReadCache.delete({ where: { id: f.ids[1] } }))
    await outside(() => prisma.productReadCache.create({ data: { ...copy, name: 'foreign cached row' } as never }))
    const otherBefore = await outside(() => prisma.productReadCache.findUniqueOrThrow({ where: { id: f.ids[1] } }))
    const ownBefore = await snapshot(f.all, true)
    await scoped(() => prisma.product.update({ where: { id: f.ids[0] }, data: { name: 'new own source' } }))
    await withSearch(async () => {
      for (const service of [rowMode, productReadCacheService]) {
        await expect(refresh(service, f.ids)).rejects.toThrow()
        expect(await snapshot(f.all, true)).toEqual(ownBefore)
        expect(await outside(() => prisma.productReadCache.findUniqueOrThrow({ where: { id: f.ids[1] } }))).toEqual(otherBefore)
        expect(state.jobs).toEqual([])
      }
    })
    await outside(() => prisma.productReadCache.delete({ where: { id: f.ids[1] } }))
    await refresh(productReadCacheService, f.ids)
    expect(await scoped(() => prisma.productReadCache.findUniqueOrThrow({ where: { id: f.ids[1] } }))).toMatchObject({ workspaceId: LEGACY_WORKSPACE_ID, name: original.name })
  } finally { if (previous === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED; else process.env.NEXUS_WORKSPACES_ENABLED = previous }
}, 120_000)

it.skipIf(!concurrentDatabaseUrl()).each(['row', 'set'] as const)('retries a forced %s-mode cache race and publishes only the two committed refreshes', async mode => {
  const db = state.db as Awaited<ReturnType<typeof concurrentDatabase>>
  const f = await fixture(2)
  const service = mode === 'row' ? rowMode : productReadCacheService
  await refresh(service, f.ids)
  const attempts = vi.spyOn(service, 'refreshInTransaction')
  const locker = await db.pool.connect()
  let running: Array<Promise<{ ok: boolean; error?: unknown }>> = []
  let released = false
  try {
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE "ProductReadCache" IN SHARE MODE')
    await withSearch(async () => {
      running = [0, 1].map(() => refresh(service, f.ids).then(() => ({ ok: true }), error => ({ ok: false, error })))
      let waiting = 0
      const deadline = Date.now() + 30_000
      while (waiting < 2 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
        waiting = (await db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [db.name])).rows[0].n
      }
      await locker.query(waiting === 2 ? 'COMMIT' : 'ROLLBACK'); released = true
      const results = await Promise.all(running)
      expect(waiting, 'Both calls must be blocked before releasing the cache lock').toBe(2)
      expect(results.map(result => result.ok), results.map(result => String(result.error)).join('\n')).toEqual([true, true])
      expect(attempts.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(state.jobs).toEqual([f.root, f.root])
      expect(await scoped(() => prisma.productReadCache.count({ where: { id: { in: f.all } } }))).toBe(3)
    })
  } finally {
    if (!released) { await locker.query('ROLLBACK'); await Promise.all(running) }
    locker.release(); attempts.mockRestore()
  }
}, 120_000)
