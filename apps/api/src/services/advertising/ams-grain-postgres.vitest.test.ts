/**
 * BID BRAIN BB-16 — the Marketing Stream ingest at ad group × placement grain on a real PostgreSQL (the throwaway
 * PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login,
 * business profiles ON). Nothing here calls Amazon: the records are the stream's, handed to the real ingest.
 *
 *   tables      AmazonAdsHourlyPlacement and AmazonAdsHourlyArrival: invisible to another business through Prisma and
 *               raw SQL, refused without a business, row-level security forced with the business policy and the
 *               reference guard
 *   businesses  the same Amazon ids in two businesses are two rows; the row-count guard counts one business's rows only
 *               (in memory, per business and day, read once); the capped-day mark is the capped business's alone
 *   at once     one record delivered on eight connections at once adds once; twenty different records on one new row
 *               at once all add (one row created, no update lost)
 *   forced      a redelivery that waits on the first delivery's uncommitted row sees the key once that commits and adds
 *               nothing; a different record that waits the same way adds — the dedupe check runs on the locked,
 *               newest row, not on the statement's snapshot (a snapshot check would add the redelivery again)
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

const { ingestMarketingStream } = await import('./ads-marketing-stream.service.js')
const { ingestPlacementGrain } = await import('./ams-grain.service.js')
const { normalizeAmsMarketplace } = await import('./ads-marketing-stream.service.js')
const { inDatabaseTransaction } = await import('../../lib/database-context.js')

const hex = randomBytes(4).toString('hex')
const W = `bb16_grain_${hex}`
const W2 = `bb16_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const AT = new Date('2026-10-08T12:20:00Z')
let seq = 0
const traffic = (over: Record<string, unknown> = {}) => ({
  dataset_id: 'sp-traffic', idempotency_id: `${hex}-t-${++seq}`, advertiser_id: 'ADV1', marketplace_id: 'APJ6JRA9NG5V4', currency: 'EUR',
  campaign_id: '1001', ad_group_id: '2001', placement: 'Top of Search on-Amazon', time_window_start: '2026-10-08T10:00:00Z',
  impressions: 10, clicks: 1, cost: 0.5, ...over,
})
const grain = (records: Array<Record<string, unknown>>) => ingestPlacementGrain(records, { arrivedAt: AT, marketplaceOf: normalizeAmsMarketplace })
const rowOf = async (w: string, adGroupId: string) => (await rows<Record<string, any>>(
  'SELECT impressions, clicks, "costMicros"::text AS cost, cardinality("appliedKeys") AS keys, (SELECT COALESCE(sum(records), 0)::int FROM "AmazonAdsHourlyArrival" a WHERE a."grainId" = p.id) AS arrivals FROM "AmazonAdsHourlyPlacement" p WHERE "workspaceId" = $1 AND "adGroupId" = $2',
  [w, adGroupId]))[0]

async function untilWaitingOnALock(timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if ((await rows<{ n: number }>('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted'))[0].n > 0) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('the second delivery never waited on a lock')
}

describe.skipIf(!concurrentDatabaseUrl())('BB-16 — the Marketing Stream at ad group × placement grain (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase({ maxConnections: 16 })
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the tables: invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const out = await inW(() => ingestMarketingStream([traffic({ ad_group_id: 'x-table' })] as never, { arrivedAt: AT }))
    expect(out.grain).toMatchObject({ applied: 1, created: 1 })
    const [placement] = await rows<{ id: string; workspaceId: string }>('SELECT id, "workspaceId" FROM "AmazonAdsHourlyPlacement" WHERE "adGroupId" = \'x-table\'')
    expect(placement.workspaceId).toBe(W)
    expect((await rows<{ workspaceId: string }>('SELECT "workspaceId" FROM "AmazonAdsHourlyArrival" WHERE "grainId" = $1', [placement.id]))).toEqual([{ workspaceId: W }])
    await inW2(async () => {
      expect(await db.amazonAdsHourlyPlacement.findMany()).toEqual([])
      expect(await db.amazonAdsHourlyArrival.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AmazonAdsHourlyPlacement"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AmazonAdsHourlyPlacement" SET clicks = 99 WHERE id = ${placement.id}`).toBe(0)
      await expect(db.amazonAdsHourlyArrival.create({ data: { workspaceId: W, grainId: placement.id, date: new Date('2026-10-08'), kind: 'traffic', ageHours: 5, firstAt: AT, lastAt: AT } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
    })
    await expect(db.amazonAdsHourlyPlacement.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    for (const table of ['AmazonAdsHourlyPlacement', 'AmazonAdsHourlyArrival']) {
      expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [table])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
      expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [table])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
      expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', [table])).toEqual([{ tgname: 'nexus_workspace_references' }])
    }
  })

  it('two businesses: the same Amazon ids are two rows; the row-count guard counts one business\'s rows only', async () => {
    vi.stubEnv('NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY', '2')
    try {
      // W already holds one row on this day (the table test). One more fits; the third is refused.
      expect(await inW(() => grain([traffic({ ad_group_id: 'b-1' }), traffic({ ad_group_id: 'b-2' })]))).toMatchObject({ created: 1, capped: 1 })
      // W2 has none: the same ids are its own rows, and W's full day does not stop it.
      expect(await inW2(() => grain([traffic({ ad_group_id: 'b-1' }), traffic({ ad_group_id: 'b-2' })]))).toMatchObject({ created: 2, capped: 0 })
      expect((await rows<{ w: string }>('SELECT "workspaceId" AS w FROM "AmazonAdsHourlyPlacement" WHERE "adGroupId" = \'b-1\' ORDER BY 1')).map((r) => r.w).sort()).toEqual([W, W2].sort())
      // BB-16 follow-up — the refusal is marked, for W only: its reader sees the day capped, W2's does not.
      expect(await rows('SELECT "workspaceId" AS w, kind, refused FROM "AmazonAdsGrainCap" ORDER BY 1')).toEqual([{ w: W, kind: 'rows', refused: 1 }])
      expect(await inW2(() => database.client.amazonAdsGrainCap.findMany())).toEqual([])
      for (const table of ['AmazonAdsGrainCap', 'AdsBrainAsk']) {
        expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [table])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
        expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [table])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
      }
    } finally { vi.unstubAllEnvs(); vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1') }
  })

  it('at once: one record delivered on eight connections adds once', async () => {
    const once = traffic({ ad_group_id: 'r-same', impressions: 7, clicks: 2, cost: 1.25 })
    const results = await Promise.all(Array.from({ length: 8 }, () => inW(() => grain([{ ...once }]))))
    expect(results.reduce((n, r) => n + (r?.applied ?? 0), 0)).toBe(1)
    expect(results.reduce((n, r) => n + (r?.duplicates ?? 0), 0)).toBe(7)
    expect(await rowOf(W, 'r-same')).toEqual({ impressions: 7, clicks: 2, cost: '1250000', keys: 1, arrivals: 1 })
  })

  it('at once: twenty different records on one new row all add — one row created, no update lost', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => inW(() => grain([traffic({ ad_group_id: 'r-many', keyword_id: String(i), impressions: 3, clicks: 1, cost: 0.1 })]))))
    expect(results.reduce((n, r) => n + (r?.applied ?? 0), 0)).toBe(20)
    expect(results.reduce((n, r) => n + (r?.created ?? 0), 0)).toBe(1)
    expect(await rowOf(W, 'r-many')).toEqual({ impressions: 60, clicks: 20, cost: '2000000', keys: 20, arrivals: 20 })
  })

  it('forced: a redelivery waiting on the uncommitted first delivery adds nothing; a different record waiting adds', async () => {
    for (const [label, second, expected] of [
      ['redelivery', (first: Record<string, unknown>) => ({ ...first }), { applied: 0, duplicates: 1, row: { impressions: 5, clicks: 1, keys: 1, arrivals: 1 } }],
      ['another record', (_first: Record<string, unknown>) => traffic({ ad_group_id: 'f-another', impressions: 4, clicks: 1 }), { applied: 1, duplicates: 0, row: { impressions: 9, clicks: 2, keys: 2, arrivals: 2 } }],
    ] as const) {
      const adGroupId = label === 'redelivery' ? 'f-redelivery' : 'f-another'
      const first = traffic({ ad_group_id: adGroupId, impressions: 5, clicks: 1 })
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      let applied!: () => void
      const firstApplied = new Promise<void>((r) => { applied = r })
      const t1 = inW(() => inDatabaseTransaction(database.client as never, async () => {
        const out = await grain([first])
        applied()
        await gate // hold the new row's lock, uncommitted
        return out
      }, { isolationLevel: 'ReadCommitted' }))
      await firstApplied
      const t2 = inW(() => grain([second(first)]))
      await untilWaitingOnALock()
      release()
      expect(await t1).toMatchObject({ applied: 1, created: 1 })
      expect(await t2).toMatchObject({ applied: expected.applied, duplicates: expected.duplicates, created: 0 })
      expect(await rowOf(W, adGroupId)).toMatchObject(expected.row)
    }
  })
})
