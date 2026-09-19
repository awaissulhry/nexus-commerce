/**
 * Shared stock step 6 (AE.4) — the live sync under a bulk edit (research §9: "a bulk edit … lag p50 and
 * p95, with the load stated"). Opt-in: AE4_LOAD=<products> (e.g. 200) and NEXUS_TEST_CONCURRENT_PG_URL.
 * Not part of the push check: it measures, it does not guard.
 *
 * One follower business holds N linked variations of one parent (a first copy through the real transfer
 * engine). One UPDATE in the owner changes all N descriptions at once; the real worker (LISTEN/NOTIFY and
 * its poll) syncs them. Reported: the time from the owner's commit until each follower product shows the
 * new value (p50, p95, max) and until the last one does. Mocks as in sync.vitest.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
const column = (key: string, storage: string, kind = 'text') => ({ key, writeField: key, label: key, group: 'Shared', kind, storage, scope: 'global', shape: 'scalar', requiredBy: [], editable: true, defaultVisible: true })
vi.mock('../pim/sheet-columns.service.js', () => ({
  getSheetColumns: async () => ({ columns: [column('name', 'column'), column('description', 'column'), column('gtin', 'column')] }),
  clearSheetColumnCache: () => {},
  coordinatesFor: () => [],
}))
vi.mock('../pim/mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [], schema: { present: true } }), clearFieldCatalogueCache: () => {} }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: async () => {}, refresh: async () => {} } }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: async () => ({}), addBulk: async () => [], getJobCounts: async () => ({}), close: async () => {} }
  return {
    resolveRedisTarget: () => ({ kind: 'disabled' }), getRedisRuntimeStatus: () => ({ status: 'disabled' }), redis: { connection: null },
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: () => {} }, channelSyncQueueEvents: { on: () => {} },
    addJobSafely: async () => undefined, resetEnqueueCircuitForTests: () => {}, initializeQueue: async () => {}, closeQueue: async () => {}, getQueueStats: async () => ({}),
  }
})

const COUNT = Number(process.env.AE4_LOAD ?? 0)
/** How many parents the variations are spread over (a bulk edit across families can run in parallel). */
const FAMILIES = Math.max(1, Number(process.env.AE4_FAMILIES ?? 1))
const A = 'ws_a_ae4_load'
const B = 'ws_b_ae4_load'

describe.skipIf(!concurrentDatabaseUrl() || !COUNT)('AE.4 — the live sync under a bulk edit (opt-in: AE4_LOAD)', () => {
  let worker: typeof import('./sync-worker.js')
  const user = { ownerA: randomUUID(), ownerB: randomUUID() }
  const parents: string[] = []
  const as = <T>(workspaceId: string, actorUserId: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId, membershipId: null, roleKeys: [] }, work)
  const sql = async (text: string, params: unknown[] = []) => (await database.pool.query(text, params)).rows as Array<Record<string, unknown>>

  beforeAll(async () => {
    database = await concurrentDatabase({ maxConnections: 16 })
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    const assortments = await import('./assortment.service.js')
    const shares = await import('./assortment-share.service.js')
    const preview = await import('./copy-preview.service.js')
    const runs = await import('./copy-run.service.js')
    const jobs = await import('../pim/catalog-transfer-jobs.js')
    worker = await import('./sync-worker.js')

    const role = randomUUID()
    await sql(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [role])
    for (const id of Object.values(user)) await sql(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [id, `${id}@example.test`])
    for (const id of [A, B]) await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$1,'active','ae4-load',$1,CURRENT_TIMESTAMP)`, [id])
    for (const [workspaceId, userId] of [[A, user.ownerA], [B, user.ownerA], [B, user.ownerB]]) {
      const membership = randomUUID()
      await sql(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [membership, workspaceId, userId])
      await sql(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [membership, role])
    }
    const family = randomUUID()
    await sql(`INSERT INTO "ProductFamily" (id, "workspaceId", code, label, "updatedAt") VALUES ($1,$2,'load','Load',CURRENT_TIMESTAMP)`, [family, A])
    for (let f = 0; f < FAMILIES; f++) {
      const parent = randomUUID()
      parents.push(parent)
      await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", status, "isParent", "familyId", "updatedAt") VALUES ($1,$2,$3,'Load parent',10,'ACTIVE',true,$4,CURRENT_TIMESTAMP)`, [parent, A, `LOAD${f}`, family])
      await sql(`INSERT INTO "Product" (id, "workspaceId", sku, name, description, "basePrice", status, "parentId", "familyId", "updatedAt")
        SELECT md5(random()::text || g::text), $1, 'LOAD' || $5 || '-' || lpad(g::text, 5, '0'), 'Variation ' || g, 'Start', 10, 'ACTIVE', $2, $4, CURRENT_TIMESTAMP
        FROM generate_series(1, $3::int) AS g`, [A, parent, Math.floor(COUNT / FAMILIES) + (f < COUNT % FAMILIES ? 1 : 0), family, String(f)])
    }
    const assortment = await as(A, user.ownerA, () => assortments.createAssortment({ name: 'Load' }))
    await as(A, user.ownerA, () => assortments.addMembers(assortment.id, { productIds: parents, expectedVersion: 1 }))
    const share = await as(A, user.ownerA, () => shares.offerShare({ assortmentId: assortment.id, destinationWorkspaceId: B, fieldGroups: ['identity', 'content', 'structure'] }))
    await as(B, user.ownerB, () => shares.followerDecision(share.id, 'accept', { expectedVersion: 1 }))
    const { preview: review } = await as(B, user.ownerB, () => preview.previewCopy({ shareId: share.id, market: 'IT' }))
    const run = await as(B, user.ownerB, () => runs.confirmCopy({ shareId: share.id, market: 'IT', fingerprint: review.fingerprint }))
    const wait = async (states: string[]) => {
      let last = ''
      for (let i = 0; i < 12000; i++) {
        const loaded = await as(B, user.ownerB, () => jobs.readTransferJob(run.transferJobId!, user.ownerB))
        last = `${loaded?.job.status} ${loaded?.job.processed}/${loaded?.job.total} ${JSON.stringify(loaded?.job.errors ?? '').slice(0, 300)}`
        if (states.includes(loaded?.job.status ?? '')) return loaded!
        if (['INVALID', 'FAILED', 'PARTIAL'].includes(loaded?.job.status ?? '')) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const rows = await sql(`SELECT "targetId", status, "parsedValues"->'issues' AS issues FROM "ImportJobRow" WHERE "jobId" = $1 ORDER BY "rowIndex" LIMIT 3`, [run.transferJobId])
      throw new Error(`the copy did not finish: ${last} ${JSON.stringify(rows)}`)
    }
    const reviewed = await wait(['QUEUED'])
    await as(B, user.ownerB, () => jobs.applyTransferJob(run.transferJobId!, user.ownerB, reviewed.payload.reviewToken!))
    await wait(['COMPLETED'])
    expect((await as(B, user.ownerB, () => runs.advanceCopyRun(run.id))).state).toBe('done')
    await as(B, null, () => worker.processAssortmentChanges()) // the finish's catch-up notes
    while ((await sql(`SELECT count(*)::int AS n FROM "AssortmentChange" WHERE state IN ('pending','claimed')`))[0].n > 0) await as(B, null, () => worker.processAssortmentChanges())
  }, 1_800_000)

  afterAll(async () => { await database?.close() }, 60_000)

  it(`a bulk edit of ${COUNT} linked products reaches the follower`, async () => {
    expect((await sql(`SELECT count(*)::int AS n FROM "CatalogLink" WHERE status = 'active'`))[0].n).toBe(COUNT + FAMILIES)
    const url = new URL(concurrentDatabaseUrl()!.toString())
    url.pathname = `/${database.name}`
    const stop = worker.startAssortmentSyncWorker({ listenUrl: url.toString() })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const started = Date.now()
    await sql(`UPDATE "Product" SET description = 'Bulk edit' WHERE "parentId" = ANY($1)`, [parents])
    const arrived = new Map<string, number>()
    while (arrived.size < COUNT && Date.now() - started < 1_500_000) {
      for (const row of await sql(`SELECT sku FROM "Product" WHERE "workspaceId" = $1 AND "parentId" IS NOT NULL AND description = 'Bulk edit'`, [B])) {
        if (!arrived.has(row.sku as string)) arrived.set(row.sku as string, Date.now() - started)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    stop()
    const lags = [...arrived.values()].sort((a, b) => a - b)
    const at = (q: number) => lags[Math.min(lags.length - 1, Math.ceil(lags.length * q) - 1)]
    const line = `[AE.4 load] one UPDATE of ${COUNT} linked products in ${FAMILIES} famil${FAMILIES === 1 ? 'y' : 'ies'}, one worker (${process.env.NEXUS_ASSORTMENT_SYNC_CONCURRENCY ?? 4} lanes), disposable PostgreSQL: arrived ${lags.length}/${COUNT}; p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, last ${lags.at(-1)} ms (${(COUNT / ((lags.at(-1) ?? 1) / 1000)).toFixed(1)} products/s)`
    // Retries under load, with their reasons (a note records the last error of each failed try).
    const retries = await sql(`SELECT left("lastError", 160) AS error, count(*)::int AS n, max(attempts)::int AS attempts FROM "AssortmentChange" WHERE "lastError" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5`)
    console.log(line, JSON.stringify(retries))
    if (process.env.AE4_LATENCY_FILE) appendFileSync(process.env.AE4_LATENCY_FILE, `${new Date().toISOString()} ${line}; retries ${JSON.stringify(retries)}\n`)
    expect(lags.length).toBe(COUNT)
  }, 1_800_000)
})
