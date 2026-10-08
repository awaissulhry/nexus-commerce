/**
 * ONE BRAIN AB-1 — a product's brain on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business
 * profiles ON). The job queue is a stub: nothing leaves the process, and nothing here may write to Amazon.
 *
 *   tables     AdsBrainEnrollment and AdsBrainOverride: one enrollment per product × market, invisible to another
 *              business through Prisma and raw SQL and never written into it, refused without a business, row-level
 *              security forced with the business policy and the reference guard
 *   resolver   on real rows: a variation, a SKU and an ASIN in another case roll up to the parent; a parentless FBA row
 *              joins its variation's family; two products, or one plus an ad Nexus cannot tie → shared; only an
 *              untied ad → none; archived campaigns, archived ads, other markets and Sponsored Brands left out
 *   adopt      enrolling a product whose campaign the bid brain already runs (GALE IT, 10-08) sets its bids lever AUTO
 *              by an "adopted" product override and writes no BidBrainEnrollment row (the LIVE one keeps its snapshot)
 *   bids AUTO  re-applying AUTO puts the own campaigns LIVE that may (each with its snapshot), skips the one off the
 *              allowlist with the reason, leaves the LIVE and the shared one; a rerun writes nothing
 *   Owner      excluding a campaign, or locking its bids, takes it out of the bid brain (and it never goes back LIVE
 *              while it lasts); ending the exclusion re-applies the product's level; settings resolve campaign >
 *              product > default with who and when; a campaign override applies to that campaign only
 *   one writer two changes made on one version: exactly one wins, the other is refused, nothing half-written
 *   refusals   a level levers.ts does not offer, a stale version, a campaign not advertising the product: nothing changes
 *   OBSERVE    the product's bids lever back to OBSERVE takes every own campaign back to shadow; the shared stays LIVE
 *   rows map   today's LIVE rows by product (a read)
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
// The app's client as db.ts builds it: an inDatabaseTransaction's statements run on its transaction (all or nothing).
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

const { productCampaigns, resolveCampaignOwnership } = await import('./ownership.js')
const { bidBrainRowsByProduct, brainSettings, brainView, endOverride, enrollProduct, planOverride, setLever, setOverride } = await import('./enrollment.js')

const hex = randomBytes(4).toString('hex')
/** Amazon writes ASINs in capitals. */
const H = hex.slice(0, 2).toUpperCase()
const W = `ab1_brain_${hex}`
const W2 = `ab1_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const P = id('p'), P1 = id('p1'), P2 = id('p2'), P2F = id('p2f'), Q = id('q'), Q1 = id('q1')
const C = (s: string) => id(`c-${s}`)
const TABLES = ['AdsBrainEnrollment', 'AdsBrainOverride']
const NOW = new Date('2026-10-08T12:00:00Z')

const modes = async () => Object.fromEntries((await rows<{ campaignId: string; mode: string }>('SELECT "campaignId", mode FROM "BidBrainEnrollment" WHERE "workspaceId" = $1', [W])).map((r) => [r.campaignId, r.mode]))
const amazonRows = async () => (await rows<{ n: number }>(
  'SELECT ((SELECT count(*) FROM "AdMutation" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "AdvertisingActionLog" WHERE "workspaceId" = $1))::int AS n', [W]))[0].n
const version = async () => (await rows<{ version: number }>('SELECT version FROM "AdsBrainEnrollment" WHERE "workspaceId" = $1 AND "productId" = $2 AND marketplace = \'IT\'', [W, P]))[0]?.version

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '99.00', totalStock: 5, ...extra } })
  await product(P, `AB1-JACKET-${hex}`, { isParent: true, amazonAsin: `B0AB1PAR${H}` })
  await product(P1, `AB1-JACKET-S-${hex}`, { parentId: P, amazonAsin: `B0AB1JKS${H}` })
  await product(P2, `AB1-JACKET-M-${hex}`, { parentId: P, amazonAsin: `B0AB1JKM${H}` })
  await product(P2F, `AB1-JACKET-M-FBA-${hex}`, { amazonAsin: `B0AB1JKM${H}` })
  await product(Q, `AB1-GLOVE-${hex}`, { isParent: true })
  await product(Q1, `AB1-GLOVE-L-${hex}`, { parentId: Q, amazonAsin: `B0AB1GLL${H}` })
  const campaign = async (key: string, ads: Array<{ productId?: string; asin?: string; sku?: string; status?: 'ARCHIVED' }>, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: `${key}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    await db.adTarget.create({ data: { id: `t-${C(key)}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `jacket ${key}`, bidCents: 40, externalTargetId: `EXT-t-${C(key)}` } })
    let i = 0
    for (const ad of ads) await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId: ad.productId ?? null, asin: ad.asin ?? `B0NOASIN${H.slice(0, 1)}${i++}`, sku: ad.sku ?? null, ...(ad.status ? { status: ad.status } : {}) } })
  }
  const asin = (p: string) => `B0AB1${p}${H}`
  await campaign('a-live', [{ productId: P1, asin: asin('JKS') }])
  await campaign('b-asin', [{ asin: asin('JKM').toLowerCase() }])
  await campaign('c-fba', [{ sku: `AB1-JACKET-M-FBA-${hex}` }])
  await campaign('d-off', [{ productId: P2, asin: asin('JKM') }], { liveBidWritesEnabled: false })
  await campaign('e-shared', [{ productId: P1, asin: asin('JKS') }, { productId: Q1, asin: asin('GLL') }])
  await campaign('f-untied', [{ productId: P1, asin: asin('JKS') }, { asin: `B0AB1UNK${H}` }])
  await campaign('g-none', [{ asin: `B0AB1UNX${H}` }])
  await campaign('h-de', [{ productId: P1, asin: asin('JKS') }], { marketplace: 'DE' })
  await campaign('i-archived', [{ productId: P1, asin: asin('JKS') }], { status: 'ARCHIVED' })
  await campaign('j-archived-ad', [{ productId: P1, asin: asin('JKS'), status: 'ARCHIVED' }])
  await campaign('k-brands', [{ productId: P1, asin: asin('JKS') }], { type: 'SB', adProduct: 'SPONSORED_BRANDS' })
  // GALE IT, 10-08: a campaign put LIVE one by one with set-bid-brain-enrollment; and a person's LIVE row on the shared one.
  await db.bidBrainEnrollment.create({ data: { campaignId: C('a-live'), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner-1008', snapshot: { takenAt: '2026-10-08T10:56:00.000Z', adGroups: [], targets: [{ id: `t-${C('a-live')}`, bidCents: 40 }], placements: [] } } })
  await db.bidBrainEnrollment.create({ data: { campaignId: C('e-shared'), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner-1008', snapshot: { takenAt: '2026-10-08T10:56:00.000Z', adGroups: [], targets: [], placements: [] } } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-1 — a product\'s brain: enrollment, overrides, the bids lever (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the tables: one enrollment per product × market, invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const row = await inW(() => db.adsBrainEnrollment.create({ data: { productId: 'x-table-test', marketplace: 'IT', enrolledBy: 'user:test', updatedBy: 'user:test' } }))
    expect(row).toMatchObject({ workspaceId: W, version: 1, snapshots: null })
    await expect(inW(() => db.adsBrainEnrollment.create({ data: { productId: 'x-table-test', marketplace: 'IT', enrolledBy: 'user:test', updatedBy: 'user:test' } }))).rejects.toMatchObject({ code: 'P2002' })
    expect((await inW(() => db.adsBrainEnrollment.findUnique({ where: { product_market: { productId: 'x-table-test', marketplace: 'IT' } } })))?.id).toBe(row.id)
    const o = await inW(() => db.adsBrainOverride.create({ data: { productId: 'x-table-test', marketplace: 'IT', scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO', by: 'user:test' } }))
    expect(o).toMatchObject({ workspaceId: W, ref: '', endedAt: null })
    await inW2(async () => {
      expect(await db.adsBrainEnrollment.findMany()).toEqual([])
      expect(await db.adsBrainOverride.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AdsBrainOverride"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsBrainEnrollment" SET version = 9 WHERE id = ${row.id}`).toBe(0)
      expect(await db.$executeRaw`DELETE FROM "AdsBrainOverride" WHERE id = ${o.id}`).toBe(0)
      await expect(db.adsBrainOverride.create({ data: { workspaceId: W, productId: 'x', marketplace: 'IT', scope: 'PRODUCT', kind: 'EXCLUDE', key: '*', by: 'user:test' } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
      // The same product id in another business is its own row.
      expect((await db.adsBrainEnrollment.create({ data: { productId: 'x-table-test', marketplace: 'IT', enrolledBy: 'user:test', updatedBy: 'user:test' } })).workspaceId).toBe(W2)
    })
    await expect(db.adsBrainEnrollment.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    await expect(db.adsBrainOverride.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    const flags = await rows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>('SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY relname', [TABLES])
    expect(flags).toEqual(TABLES.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })))
    expect((await rows<{ tablename: string }>('SELECT tablename FROM pg_policies WHERE policyname = \'nexus_workspace_isolation\' AND tablename = ANY($1) ORDER BY tablename', [TABLES])).map((r) => r.tablename)).toEqual(TABLES)
    expect((await rows<{ relname: string }>('SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = \'nexus_workspace_references\' AND c.relname = ANY($1) ORDER BY c.relname', [TABLES])).map((r) => r.relname)).toEqual(TABLES)
    await database.pool.query('DELETE FROM "AdsBrainOverride" WHERE "productId" = \'x-table-test\'')
    await database.pool.query('DELETE FROM "AdsBrainEnrollment" WHERE "productId" = \'x-table-test\'')
  })

  it('the resolver on real rows: variations, SKU, ASIN case and the FBA row roll up; shared, none and what is left out', async () => {
    const all = ['a-live', 'b-asin', 'c-fba', 'd-off', 'e-shared', 'f-untied', 'g-none', 'h-de', 'i-archived', 'j-archived-ad', 'k-brands'].map(C)
    const owners = await inW(() => resolveCampaignOwnership([...all, 'not-in-this-business']))
    expect(owners.size).toBe(all.length)
    const kind = (k: string) => owners.get(C(k))!.owner
    for (const k of ['a-live', 'b-asin', 'c-fba', 'd-off', 'h-de', 'i-archived', 'k-brands']) expect(kind(k)).toEqual({ kind: 'product', productId: P })
    expect(kind('e-shared')).toEqual({ kind: 'shared', productIds: [P, Q].sort() })
    expect(owners.get(C('f-untied'))).toMatchObject({ owner: { kind: 'shared', productIds: [P] }, unresolved: [`B0AB1UNK${H}`] })
    expect(kind('g-none')).toEqual({ kind: 'none' })
    expect(kind('j-archived-ad')).toEqual({ kind: 'none' })
    expect(owners.get(C('h-de'))?.market).toBe('DE')
    // From the product side: any member names the family; IT only, Sponsored Products only, archived left out.
    for (const member of [P1, P2F, P]) {
      const found = await inW(() => productCampaigns(member, 'IT'))
      expect(found?.root).toBe(P)
      expect(found?.owned.map((c) => c.campaignId)).toEqual(['a-live', 'b-asin', 'c-fba', 'd-off'].map(C))
      expect(found?.shared.map((c) => c.campaignId)).toEqual(['e-shared', 'f-untied'].map(C))
    }
    expect((await inW(() => productCampaigns(P, 'DE')))?.owned.map((c) => c.campaignId)).toEqual([C('h-de')])
    expect(await inW(() => productCampaigns('no-such-product', 'IT'))).toBeNull()
  })

  it('enrolling adopts the bids lever from the campaigns (an "adopted" product override) and writes no campaign row', async () => {
    const before = await rows('SELECT * FROM "BidBrainEnrollment" WHERE "workspaceId" = $1 ORDER BY id', [W])
    const r = await inW(() => enrollProduct({ productId: P2, market: 'it', by: 'user:owner', now: NOW }))
    expect(r).toMatchObject({ ok: true, productId: P, market: 'IT', bids: 'AUTO', version: 1, adoptedLive: [C('a-live')] })
    expect(await rows('SELECT * FROM "BidBrainEnrollment" WHERE "workspaceId" = $1 ORDER BY id', [W])).toEqual(before)
    const s = await inW(() => brainSettings(P1, 'IT'))
    expect(s?.levers.bids).toMatchObject({ level: { value: 'AUTO', source: 'product', by: 'user:owner' }, effective: 'AUTO', owned: true })
    expect(s?.levers.bids.level.reason).toMatch(/adopted at enrollment: the bid brain already runs 1 own campaign LIVE/)
    expect(s?.levers.negatives).toMatchObject({ level: { value: 'OBSERVE', source: 'default' }, effective: 'OBSERVE' })
    expect(await inW(() => enrollProduct({ productId: P, market: 'IT', by: 'user:owner' }))).toEqual({ ok: false, refusal: 'the product is already enrolled in the brain for IT' })
    // A product with no own campaign the bid brain runs starts OBSERVE (the glove sits only in the shared campaign).
    expect(await inW(() => enrollProduct({ productId: Q1, market: 'IT', by: 'user:owner' }))).toMatchObject({ ok: true, productId: Q, bids: 'OBSERVE', adoptedLive: [] })
    expect(await amazonRows()).toBe(0)
  })

  it('bids AUTO again puts the own campaigns LIVE that may, skips the one off the allowlist, leaves the LIVE and the shared; a rerun writes nothing', async () => {
    const [aLive] = await rows<{ updatedAt: Date; snapshot: unknown }>('SELECT "updatedAt", snapshot FROM "BidBrainEnrollment" WHERE "campaignId" = $1', [C('a-live')])
    const preview = await inW(() => planOverride({ productId: P, market: 'IT', set: { scope: 'PRODUCT', kind: 'LEVEL', key: 'bids', value: 'AUTO' } }))
    expect(preview.ok && preview.plan.set).toBeNull()
    const r = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'AUTO', by: 'user:owner', expectVersion: 1, now: NOW }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.version).toBe(2)
    expect(r.plan.set).toBeNull() // the adopted AUTO already says it: no new override row, only the campaigns move
    expect(r.plan.steps?.map((s) => [s.campaignId, s.op])).toEqual([[C('a-live'), 'keep'], [C('b-asin'), 'live'], [C('c-fba'), 'live'], [C('d-off'), 'skip']])
    expect(r.plan.steps?.find((s) => s.op === 'skip')).toMatchObject({ why: expect.stringContaining('not on the live-write allowlist') })
    expect(await modes()).toEqual({ [C('a-live')]: 'LIVE', [C('b-asin')]: 'LIVE', [C('c-fba')]: 'LIVE', [C('e-shared')]: 'LIVE' })
    const fresh = await rows<{ campaignId: string; snapshot: { targets: Array<{ bidCents: number }> }; enrolledBy: string }>('SELECT "campaignId", snapshot, "enrolledBy" FROM "BidBrainEnrollment" WHERE "campaignId" = ANY($1) ORDER BY "campaignId"', [[C('b-asin'), C('c-fba')]])
    expect(fresh.map((f) => [f.enrolledBy, f.snapshot.targets[0].bidCents])).toEqual([['user:owner', 40], ['user:owner', 40]])
    const [aAfter] = await rows<{ updatedAt: Date; snapshot: unknown }>('SELECT "updatedAt", snapshot FROM "BidBrainEnrollment" WHERE "campaignId" = $1', [C('a-live')])
    expect(aAfter).toEqual(aLive)
    const [snap] = await rows<{ snapshots: { bids: { data: unknown } } }>('SELECT snapshots FROM "AdsBrainEnrollment" WHERE "workspaceId" = $1 AND "productId" = $2', [W, P])
    expect(snap.snapshots.bids.data).toEqual({ enrolled: [C('b-asin'), C('c-fba')], alreadyLive: [C('a-live')], skipped: [{ campaignId: C('d-off'), why: expect.stringContaining('allowlist') }] })
    const again = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'AUTO', by: 'user:owner' }))
    expect(again).toMatchObject({ ok: true, version: 2, plan: { unchanged: true } })
    expect(await version()).toBe(2)
    expect(await amazonRows()).toBe(0)
  })

  it('today\'s LIVE rows by product (a read)', async () => {
    expect(await inW(() => bidBrainRowsByProduct('IT'))).toEqual({
      products: [{ productId: P, market: 'IT', campaignIds: ['a-live', 'b-asin', 'c-fba'].map(C).sort(), enrolled: true }],
      shared: [{ campaignId: C('e-shared'), market: 'IT', productIds: [P, Q].sort() }],
      none: [],
    })
  })

  it('the Owner: an excluded or bids-locked campaign leaves the bid brain and never comes back while it lasts; ending it re-applies', async () => {
    const out = await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('b-asin'), kind: 'EXCLUDE', key: '*' }, by: 'user:owner', reason: 'my own campaign', expectVersion: 2, now: NOW }))
    expect(out).toMatchObject({ ok: true, version: 3, plan: { steps: [{ campaignId: C('b-asin'), op: 'shadow', why: expect.stringContaining('excluded by the Owner') }] } })
    const lock = await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('c-fba'), kind: 'LOCK', key: 'bids' }, by: 'user:owner', now: NOW }))
    expect(lock).toMatchObject({ ok: true, version: 4, plan: { steps: [{ campaignId: C('c-fba'), op: 'shadow', why: expect.stringContaining('locked') }] } })
    expect(await modes()).toMatchObject({ [C('a-live')]: 'LIVE', [C('b-asin')]: 'SHADOW', [C('c-fba')]: 'SHADOW', [C('e-shared')]: 'LIVE' })
    // Re-applying the product's AUTO never puts them back.
    const again = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'AUTO', by: 'user:owner' }))
    expect(again).toMatchObject({ ok: true, plan: { unchanged: true } })
    const view = await inW(() => brainView(P, 'IT'))
    const b = view!.campaigns.find((c) => c.campaignId === C('b-asin'))!
    expect(b).toMatchObject({ owner: 'product', mode: 'SHADOW', excluded: { value: true, source: 'campaign', by: 'user:owner', reason: 'my own campaign' }, bids: { effective: 'EXCLUDED' }, overrides: 1 })
    expect(view!.campaigns.find((c) => c.campaignId === C('c-fba'))!.bids).toMatchObject({ effective: 'LOCKED', lock: { source: 'campaign' } })
    expect(view!.drift).toEqual([
      expect.stringContaining(`not LIVE although bids resolve to AUTO (d-off)`),
      expect.stringContaining('1 shared campaign is LIVE by a per-campaign enrollment (e-shared)'),
    ])
    // Ending the exclusion: the product's AUTO applies again and the campaign goes LIVE (a new snapshot).
    const back = await inW(() => endOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('b-asin'), kind: 'EXCLUDE', key: '*' }, by: 'user:owner', now: NOW }))
    expect(back).toMatchObject({ ok: true, version: 5, plan: { set: null, steps: [{ campaignId: C('b-asin'), op: 'live' }] } })
    expect((await modes())[C('b-asin')]).toBe('LIVE')
    const history = await rows<{ endedAt: Date | null; endedBy: string | null }>('SELECT "endedAt", "endedBy" FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND kind = \'EXCLUDE\'', [W])
    expect(history).toEqual([{ endedAt: expect.any(Date), endedBy: 'user:owner' }])
    expect(await amazonRows()).toBe(0)
  })

  it('settings resolve campaign > product > default with who and when; a setting change moves no campaign', async () => {
    const pace = await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'negativesPerEntityMax', value: 900 }, by: 'user:owner', reason: 'tighter' }))
    expect(pace.ok).toBe(true)
    expect(pace.ok && pace.plan).toMatchObject({ set: { kind: 'VALUE', key: 'negativesPerEntityMax', value: 900 }, ends: null, unchanged: false })
    expect(pace.ok && 'steps' in pace.plan).toBe(false)
    await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('a-live'), kind: 'VALUE', key: 'negativesPerEntityMax', value: 500 }, by: 'user:owner-2' }))
    await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'portfolioCapOn', value: false }, by: 'user:owner' }))
    const forA = await inW(() => brainSettings(P, 'IT', C('a-live')))
    const forD = await inW(() => brainSettings(P, 'IT', C('d-off')))
    expect(forA?.values.negativesPerEntityMax).toMatchObject({ value: 500, source: 'campaign', by: 'user:owner-2', at: expect.any(String) })
    expect(forD?.values.negativesPerEntityMax).toMatchObject({ value: 900, source: 'product', reason: 'tighter' })
    expect(forD?.values.portfolioCapOn).toMatchObject({ value: false, source: 'product' })
    expect(forD?.values.paceTargetPct).toMatchObject({ value: 90, source: 'default' })
    // A second choice of the same thing replaces the first (one open row per thing).
    await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'negativesPerEntityMax', value: 850 }, by: 'user:owner' }))
    expect((await rows<{ n: number }>('SELECT count(*)::int n FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND key = \'negativesPerEntityMax\' AND scope = \'PRODUCT\' AND "endedAt" IS NULL', [W]))[0].n).toBe(1)
    expect((await inW(() => brainSettings(P, 'IT', C('d-off'))))?.values.negativesPerEntityMax.value).toBe(850)
    expect(await amazonRows()).toBe(0)
  })

  it('one writer: two changes made on one version — exactly one wins, the other changes nothing', async () => {
    const v = await version()
    const results = await Promise.all([
      inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'harvestPerDay', value: 5 }, by: 'user:a', expectVersion: v })),
      inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'PRODUCT', kind: 'VALUE', key: 'skcMax', value: 4 }, by: 'user:b', expectVersion: v })),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, refusal: expect.stringMatching(/changed (since it was read|while this change ran)/) })
    expect(await version()).toBe(v + 1)
    const open = await rows<{ key: string }>('SELECT key FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND key IN (\'harvestPerDay\', \'skcMax\') AND "endedAt" IS NULL', [W])
    expect(open).toHaveLength(1)
  })

  it('refusals change nothing: a level not offered, a stale version, a campaign that does not advertise the product', async () => {
    const v = await version()
    const before = await modes()
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'negatives', level: 'AUTO', by: 'user:owner' }))).toEqual({ ok: false, refusal: expect.stringContaining('takes OFF or OBSERVE today') })
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'PROPOSE', by: 'user:owner' }))).toEqual({ ok: false, refusal: expect.stringContaining('no proposal path') })
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'OBSERVE', by: 'user:owner', expectVersion: v - 1 }))).toEqual({ ok: false, refusal: expect.stringContaining('changed since it was read') })
    expect(await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('g-none'), kind: 'EXCLUDE', key: '*' }, by: 'user:owner' }))).toEqual({ ok: false, refusal: expect.stringContaining('does not advertise this product') })
    expect(await inW(() => setLever({ productId: 'no-such-product', market: 'IT', lever: 'bids', level: 'AUTO', by: 'user:owner' }))).toMatchObject({ ok: false })
    expect(await version()).toBe(v)
    expect(await modes()).toEqual(before)
  })

  it('the product\'s bids lever back to OBSERVE takes every own campaign back to shadow; the shared one stays LIVE', async () => {
    const r = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'OBSERVE', by: 'user:owner', now: NOW }))
    expect(r.ok && r.plan.steps?.filter((s) => s.op === 'shadow').map((s) => s.campaignId).sort()).toEqual(['a-live', 'b-asin'].map(C).sort())
    expect(await modes()).toEqual({ [C('a-live')]: 'SHADOW', [C('b-asin')]: 'SHADOW', [C('c-fba')]: 'SHADOW', [C('e-shared')]: 'LIVE' })
    const s = await inW(() => brainSettings(P, 'IT'))
    expect(s?.levers.bids).toMatchObject({ level: { value: 'OBSERVE', source: 'product', by: 'user:owner' }, effective: 'OBSERVE' })
    // The adopted AUTO is history now, ended by this change.
    expect((await rows<{ n: number }>('SELECT count(*)::int n FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND kind = \'LEVEL\' AND key = \'bids\' AND "productId" = $2 AND "endedAt" IS NOT NULL', [W, P]))[0].n).toBe(1)
    expect(await amazonRows()).toBe(0)
  })
})
