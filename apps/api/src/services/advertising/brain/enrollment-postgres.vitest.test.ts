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
 *              by an "adopted" product override, keeps each own campaign in shadow with an "adopted" campaign OBSERVE,
 *              and writes no BidBrainEnrollment row (the LIVE one keeps its snapshot)
 *   brakes     re-applying AUTO moves nothing past an adopted OBSERVE; ending one puts the campaign LIVE — a big door
 *              (needsCode) — and runs only on the basis it was approved on (an allowlist moved since: refused)
 *   Owner      excluding a campaign, or locking its bids, takes it out of the bid brain, and the per-campaign tool then
 *              refuses op live with the override's words; ending the exclusion re-applies the product's level (a big
 *              door); an exclusion of a SHARED LIVE campaign takes it back to shadow and ending it never puts it LIVE
 *   by hand    the per-campaign tool's op shadow, approved by a person, is kept as a campaign override: a product
 *              re-apply leaves the campaign in shadow
 *   settings   campaign > product > default with who and when; a campaign override applies to that campaign only;
 *              the negatives warning level never above the maximum (product and campaign)
 *   one writer two changes made on one version: exactly one wins, the other is refused, nothing half-written
 *   refusals   a level levers.ts does not offer, a stale version, a campaign not advertising the product, a change run
 *              inside a weaker outer transaction: nothing changes
 *   brakes win a product LOCK holds a campaign set to AUTO by hand (back to shadow, named); ending it puts it LIVE (a big
 *              door). A product EXCLUDE on a campaign at a floor only the brain would lift is saved: that campaign waits,
 *              HELD, and goes to shadow when the exclusion is set again after the floor lifted
 *   OBSERVE    the product's bids lever back to OBSERVE takes every own campaign back to shadow, a HELD one included; a
 *              campaign's own AUTO stays, and the plan names every campaign it does not reach
 *   rollback   once a product is enrolled, give-back ALWAYS runs: an archived campaign, a campaign whose product's
 *              family root was deleted (its record fails: a warning, in the result and the change record), and a
 *              plain one (recorded as the Owner's campaign choice): the mode flips and the snapshot comes back
 *   rows map   today's LIVE rows by product (a read)
 *   AB-2       a stop's saved settings still owed: the product's AUTO skips that campaign by name (not a failed change);
 *              its way back to shadow gives them back
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
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
const { bidBrainRowsByProduct, brainSettings, brainView, endOverride, enrollProduct, planOverride, recordCampaignBidsChoice, setLever, setOverride } = await import('./enrollment.js')
const { holdCampaigns, setEnrollment } = await import('../bid-brain/enrollment.js')
const { inDatabaseTransaction } = await import('../../../lib/database-context.js')
const { ADS_BID_BRAIN_ENROLLMENT_TOOLS } = await import('../../agents/tools/ads-bid-brain-enrollment.tools.js')
const { decideApproval, runOrQueueTool } = await import('../../agents/approval-gate.service.js')

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
const business = scope(W)
const person = (userId: string, via: 'claude' | 'app') => ({
  kind: 'user' as const, userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
/** The per-campaign tool's preview: what it would refuse. */
const toolPreview = (campaignId: string, op: string) => inW(() => ADS_BID_BRAIN_ENROLLMENT_TOOLS[0].handler!({ campaignId, op }, {} as never)) as Promise<{ ok: boolean; error?: string }>
const campaignOverride = (campaignId: string) => ({ scope: 'CAMPAIGN' as const, campaignId, kind: 'LEVEL' as const, key: 'bids' })

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

  it('enrolling adopts the bids lever, keeps each own campaign in shadow with an adopted OBSERVE, and writes no campaign row', async () => {
    const before = await rows('SELECT * FROM "BidBrainEnrollment" WHERE "workspaceId" = $1 ORDER BY id', [W])
    const r = await inW(() => enrollProduct({ productId: P2, market: 'it', by: 'user:owner', now: NOW }))
    expect(r).toMatchObject({ ok: true, productId: P, market: 'IT', bids: 'AUTO', version: 1, adoptedLive: [C('a-live')], keptInShadow: ['b-asin', 'c-fba', 'd-off'].map(C) })
    expect(await rows('SELECT * FROM "BidBrainEnrollment" WHERE "workspaceId" = $1 ORDER BY id', [W])).toEqual(before)
    const s = await inW(() => brainSettings(P1, 'IT'))
    expect(s?.levers.bids).toMatchObject({ level: { value: 'AUTO', source: 'product', by: 'user:owner' }, effective: 'AUTO', owned: true })
    expect(s?.levers.bids.level.reason).toMatch(/adopted at enrollment: the bid brain already runs 1 own campaign LIVE/)
    expect(s?.levers.negatives).toMatchObject({ level: { value: 'OBSERVE', source: 'default' }, effective: 'OBSERVE' })
    expect((await inW(() => brainSettings(P, 'IT', C('b-asin'))))?.levers.bids).toMatchObject({ level: { value: 'OBSERVE', source: 'campaign', reason: expect.stringContaining('in shadow when the product enrolled') }, effective: 'OBSERVE' })
    expect(await inW(() => enrollProduct({ productId: P, market: 'IT', by: 'user:owner' }))).toEqual({ ok: false, refusal: 'the product is already enrolled in the brain for IT' })
    // A product with no own campaign the bid brain runs starts OBSERVE (the glove sits only in the shared campaign).
    expect(await inW(() => enrollProduct({ productId: Q1, market: 'IT', by: 'user:owner' }))).toMatchObject({ ok: true, productId: Q, bids: 'OBSERVE', adoptedLive: [], keptInShadow: [] })
    expect(await amazonRows()).toBe(0)
  })

  it('adopted brakes hold: re-applying AUTO moves nothing; ending one is a big door and runs only on the basis it was approved on', async () => {
    const v = await version()
    const again = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'AUTO', by: 'user:owner' }))
    expect(again).toMatchObject({ ok: true, version: v, plan: { unchanged: true, needsCode: false, goesLive: [] } })
    expect(await modes()).toEqual({ [C('a-live')]: 'LIVE', [C('e-shared')]: 'LIVE' })
    // Ending b-asin's adopted OBSERVE puts it LIVE: the preview says it is a big door, and the change runs on its basis.
    const preview = await inW(() => planOverride({ productId: P, market: 'IT', end: campaignOverride(C('b-asin')) }))
    expect(preview).toMatchObject({ ok: true, plan: { goesLive: [C('b-asin')], needsCode: true, steps: [{ campaignId: C('b-asin'), op: 'live' }] } })
    if (!preview.ok) return
    const ended = await inW(() => endOverride({ productId: P, market: 'IT', override: campaignOverride(C('b-asin')), by: 'user:owner', expectVersion: v, expectBasis: preview.plan.basis, now: NOW }))
    expect(ended).toMatchObject({ ok: true, version: v + 1, plan: { needsCode: true } })
    const [b] = await rows<{ mode: string; snapshot: { targets: Array<{ bidCents: number }> }; enrolledBy: string }>('SELECT mode, snapshot, "enrolledBy" FROM "BidBrainEnrollment" WHERE "campaignId" = $1', [C('b-asin')])
    expect([b.mode, b.enrolledBy, b.snapshot.targets[0].bidCents]).toEqual(['LIVE', 'user:owner', 40])
    // An approval made on a plan that has moved since (the allowlist of d-off changed: a skip became a live step) runs nothing.
    const stale = await inW(() => planOverride({ productId: P, market: 'IT', end: campaignOverride(C('d-off')) }))
    expect(stale).toMatchObject({ ok: true, plan: { needsCode: false, steps: [{ campaignId: C('d-off'), op: 'skip', why: expect.stringContaining('allowlist') }] } })
    if (!stale.ok) return
    await database.pool.query('UPDATE "Campaign" SET "liveBidWritesEnabled" = true WHERE id = $1', [C('d-off')])
    expect(await inW(() => endOverride({ productId: P, market: 'IT', override: campaignOverride(C('d-off')), by: 'user:owner', expectBasis: stale.plan.basis }))).toEqual({ ok: false, refusal: expect.stringContaining('changed since it was approved') })
    await database.pool.query('UPDATE "Campaign" SET "liveBidWritesEnabled" = false WHERE id = $1', [C('d-off')])
    expect(await version()).toBe(v + 1)
    expect((await modes())[C('d-off')]).toBeUndefined()
    // Ending c-fba's: LIVE, and the lever's snapshot names it.
    expect(await inW(() => endOverride({ productId: P, market: 'IT', override: campaignOverride(C('c-fba')), by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, plan: { goesLive: [C('c-fba')] } })
    expect(await modes()).toEqual({ [C('a-live')]: 'LIVE', [C('b-asin')]: 'LIVE', [C('c-fba')]: 'LIVE', [C('e-shared')]: 'LIVE' })
    const [snap] = await rows<{ snapshots: { bids: { data: unknown } } }>('SELECT snapshots FROM "AdsBrainEnrollment" WHERE "workspaceId" = $1 AND "productId" = $2', [W, P])
    expect(snap.snapshots.bids.data).toEqual({ enrolled: [C('c-fba')], alreadyLive: [], skipped: [] })
    expect(await amazonRows()).toBe(0)
  })

  it('today\'s LIVE rows by product (a read)', async () => {
    expect(await inW(() => bidBrainRowsByProduct('IT'))).toEqual({
      products: [{ productId: P, market: 'IT', campaignIds: ['a-live', 'b-asin', 'c-fba'].map(C).sort(), enrolled: true }],
      shared: [{ campaignId: C('e-shared'), market: 'IT', productIds: [P, Q].sort() }],
      none: [],
    })
  })

  it('the Owner: an excluded or bids-locked campaign leaves the bid brain, the per-campaign tool refuses it, and ending the exclusion is a big door', async () => {
    const v = await version()
    const out = await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('b-asin'), kind: 'EXCLUDE', key: '*' }, by: 'user:owner', reason: 'my own campaign', expectVersion: v, now: NOW }))
    expect(out).toMatchObject({ ok: true, version: v + 1, plan: { needsCode: false, steps: [{ campaignId: C('b-asin'), op: 'shadow', why: expect.stringContaining('excluded by the Owner') }] } })
    const lock = await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('c-fba'), kind: 'LOCK', key: 'bids' }, by: 'user:owner', now: NOW }))
    expect(lock).toMatchObject({ ok: true, version: v + 2, plan: { steps: [{ campaignId: C('c-fba'), op: 'shadow', why: expect.stringContaining('locked') }] } })
    expect(await modes()).toMatchObject({ [C('a-live')]: 'LIVE', [C('b-asin')]: 'SHADOW', [C('c-fba')]: 'SHADOW', [C('e-shared')]: 'LIVE' })
    // Re-applying the product's AUTO never puts them back, and the per-campaign tool refuses them with the override's words.
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'AUTO', by: 'user:owner' }))).toMatchObject({ ok: true, plan: { unchanged: true } })
    expect(await toolPreview(C('b-asin'), 'live')).toEqual({ ok: false, error: expect.stringMatching(/^b-asin cannot go LIVE: it is excluded from the brain by the Owner's campaign override \(user:owner, \d{4}-\d{2}-\d{2}\): "my own campaign"\. The bid brain stays off it/) })
    expect(await toolPreview(C('c-fba'), 'live')).toEqual({ ok: false, error: expect.stringContaining('its bids are locked at the Owner\'s own value by the Owner\'s campaign override (user:owner, ') })
    const view = await inW(() => brainView(P, 'IT'))
    const b = view!.campaigns.find((c) => c.campaignId === C('b-asin'))!
    expect(b).toMatchObject({ owner: 'product', mode: 'SHADOW', excluded: { value: true, source: 'campaign', by: 'user:owner', reason: 'my own campaign' }, bids: { effective: 'EXCLUDED' }, overrides: 1 })
    expect(view!.campaigns.find((c) => c.campaignId === C('c-fba'))!.bids).toMatchObject({ effective: 'LOCKED', lock: { source: 'campaign' } })
    expect(view!.drift).toEqual([expect.stringContaining('1 shared campaign is LIVE by a per-campaign enrollment (e-shared)')])
    // Ending the exclusion: the product's AUTO applies again and the campaign goes LIVE — a live step, so a big door.
    const back = await inW(() => endOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('b-asin'), kind: 'EXCLUDE', key: '*' }, by: 'user:owner', now: NOW }))
    expect(back).toMatchObject({ ok: true, version: v + 3, plan: { set: null, needsCode: true, steps: [{ campaignId: C('b-asin'), op: 'live' }] } })
    expect((await modes())[C('b-asin')]).toBe('LIVE')
    const history = await rows<{ endedAt: Date | null; endedBy: string | null }>('SELECT "endedAt", "endedBy" FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND kind = \'EXCLUDE\'', [W])
    expect(history).toEqual([{ endedAt: expect.any(Date), endedBy: 'user:owner' }])
    expect(await amazonRows()).toBe(0)
  })

  it('an exclusion wins on a shared campaign: the LIVE shared campaign goes back to shadow, the tool refuses it, ending it never puts it LIVE', async () => {
    const out = await inW(() => setOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('e-shared'), kind: 'EXCLUDE', key: '*' }, by: 'user:owner', reason: 'not with the gloves', now: NOW }))
    expect(out).toMatchObject({ ok: true, plan: { steps: [{ campaignId: C('e-shared'), op: 'shadow', why: expect.stringContaining('a shared campaign') }] } })
    expect((await modes())[C('e-shared')]).toBe('SHADOW')
    expect(await toolPreview(C('e-shared'), 'live')).toEqual({ ok: false, error: expect.stringContaining('excluded from the brain by the Owner\'s campaign override') })
    const back = await inW(() => endOverride({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN', campaignId: C('e-shared'), kind: 'EXCLUDE', key: '*' }, by: 'user:owner', now: NOW }))
    expect(back).toMatchObject({ ok: true, plan: { steps: [], goesLive: [], needsCode: false } })
    expect((await modes())[C('e-shared')]).toBe('SHADOW')
    expect(await amazonRows()).toBe(0)
  })

  it('by hand: the per-campaign tool\'s op shadow, approved by a person, is kept as a campaign choice the product\'s AUTO leaves alone; op live too', async () => {
    // Nothing to record when the campaign already resolves to what was done by hand.
    expect(await inW(() => recordCampaignBidsChoice({ campaignId: C('a-live'), level: 'AUTO', by: 'user:owner' }))).toBeNull()
    const result = await inW(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
      const asked = await runOrQueueTool('set-bid-brain-enrollment', { campaignId: C('a-live'), op: 'shadow', why: 'test by hand' }, person('u-asker', 'claude'), run.id)
      expect(asked).toMatchObject({ ok: true, mode: 'queued' })
      return decideApproval(asked.approvalId!, 'approve', person('u-approver', 'app'))
    })
    expect(result).toMatchObject({ ok: true, status: 'executed' })
    expect((await modes())[C('a-live')]).toBe('SHADOW')
    expect((await inW(() => brainSettings(P, 'IT', C('a-live'))))?.levers.bids).toMatchObject({ level: { value: 'OBSERVE', source: 'campaign', reason: expect.stringContaining('set-bid-brain-enrollment op shadow') }, effective: 'OBSERVE' })
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'AUTO', by: 'user:owner' }))).toMatchObject({ ok: true, plan: { unchanged: true } })
    expect((await modes())[C('a-live')]).toBe('SHADOW')
    // Op live by hand is kept too — the tool's own transaction (a big door: the approver's code), run here directly.
    await inW(() => inDatabaseTransaction(database.client as never, async () => {
      await setEnrollment({ campaignId: C('a-live'), marketplace: 'IT', op: 'live', by: 'user:owner', now: NOW })
      return recordCampaignBidsChoice({ campaignId: C('a-live'), level: 'AUTO', by: 'user:owner', reason: 'set-bid-brain-enrollment op live: test' })
    }, { isolationLevel: 'Serializable' }))
    expect((await modes())[C('a-live')]).toBe('LIVE')
    expect((await inW(() => brainSettings(P, 'IT', C('a-live'))))?.levers.bids).toMatchObject({ level: { value: 'AUTO', source: 'campaign' }, effective: 'AUTO' })
    expect((await rows<{ n: number }>('SELECT count(*)::int n FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND "campaignId" = $2 AND kind = \'LEVEL\' AND "endedAt" IS NULL', [W, C('a-live')]))[0].n).toBe(1)
    expect(await amazonRows()).toBe(0)
  })

  it('settings resolve campaign > product > default with who and when; the warning level never above the maximum; a setting moves no campaign', async () => {
    const set = (override: Parameters<typeof setOverride>[0]['override'], by = 'user:owner', reason?: string) => inW(() => setOverride({ productId: P, market: 'IT', override, by, reason }))
    expect(await set({ scope: 'PRODUCT', kind: 'VALUE', key: 'negativesPerEntityWarn', value: 400 }, 'user:owner', 'warn early')).toMatchObject({ ok: true })
    const max = await set({ scope: 'PRODUCT', kind: 'VALUE', key: 'negativesPerEntityMax', value: 900 }, 'user:owner', 'tighter')
    expect(max.ok && max.plan).toMatchObject({ set: { kind: 'VALUE', key: 'negativesPerEntityMax', value: 900 }, ends: null, unchanged: false, needsCode: false })
    expect(max.ok && 'steps' in max.plan).toBe(false)
    expect(await set({ scope: 'CAMPAIGN', campaignId: C('a-live'), kind: 'VALUE', key: 'negativesPerEntityMax', value: 500 }, 'user:owner-2')).toMatchObject({ ok: true })
    expect(await set({ scope: 'PRODUCT', kind: 'VALUE', key: 'portfolioCapOn', value: false })).toMatchObject({ ok: true })
    const forA = await inW(() => brainSettings(P, 'IT', C('a-live')))
    const forD = await inW(() => brainSettings(P, 'IT', C('d-off')))
    expect(forA?.values.negativesPerEntityMax).toMatchObject({ value: 500, source: 'campaign', by: 'user:owner-2', at: expect.any(String) })
    expect(forD?.values.negativesPerEntityMax).toMatchObject({ value: 900, source: 'product', reason: 'tighter' })
    expect(forD?.values.portfolioCapOn).toMatchObject({ value: false, source: 'product' })
    expect(forD?.values.paceTargetPct).toMatchObject({ value: 90, source: 'default' })
    // A second choice of the same thing replaces the first (one open row per thing).
    expect(await set({ scope: 'PRODUCT', kind: 'VALUE', key: 'negativesPerEntityMax', value: 850 })).toMatchObject({ ok: true })
    expect((await rows<{ n: number }>('SELECT count(*)::int n FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND key = \'negativesPerEntityMax\' AND scope = \'PRODUCT\' AND "endedAt" IS NULL', [W]))[0].n).toBe(1)
    expect((await inW(() => brainSettings(P, 'IT', C('d-off'))))?.values.negativesPerEntityMax.value).toBe(850)
    // The warning level never above the maximum: for the product, and for a campaign with its own value.
    const v = await version()
    expect(await set({ scope: 'PRODUCT', kind: 'VALUE', key: 'negativesPerEntityWarn', value: 950 })).toEqual({ ok: false, refusal: expect.stringMatching(/^negativesPerEntityWarn \(950, .*\) would be above negativesPerEntityMax \(850, the Owner's product override/) })
    expect(await set({ scope: 'CAMPAIGN', campaignId: C('a-live'), kind: 'VALUE', key: 'negativesPerEntityMax', value: 300 })).toEqual({ ok: false, refusal: expect.stringContaining(`on campaign ${C('a-live')}`) })
    expect(await version()).toBe(v)
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
    // Never at a weaker level: inside an outer transaction that is not Serializable, a change refuses to run.
    await expect(inW(() => inDatabaseTransaction(database.client as never, () => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'OBSERVE', by: 'user:owner' }), { isolationLevel: 'RepeatableRead' })))
      .rejects.toThrow(/isolation does not match/)
    expect(await version()).toBe(v)
    expect(await modes()).toEqual(before)
  })

  it('brakes win: a product LOCK holds a campaign set to AUTO by hand, and ending it is a big door', async () => {
    const lockInput = { scope: 'PRODUCT' as const, kind: 'LOCK' as const, key: 'bids' }
    const lock = await inW(() => setOverride({ productId: P, market: 'IT', override: lockInput, by: 'user:owner', now: NOW }))
    expect(lock.ok && lock.plan.steps?.filter((s) => s.op === 'shadow').map((s) => s.campaignId).sort()).toEqual(['a-live', 'b-asin'].map(C).sort())
    expect(lock.ok && lock.plan.notReached.map((n) => n.campaignId)).toEqual([C('c-fba')])
    expect(await modes()).toMatchObject({ [C('a-live')]: 'SHADOW', [C('b-asin')]: 'SHADOW' })
    expect((await inW(() => brainSettings(P, 'IT', C('a-live'))))?.levers.bids).toMatchObject({ level: { value: 'AUTO', source: 'campaign' }, lock: { source: 'product' }, effective: 'LOCKED' })
    const back = await inW(() => endOverride({ productId: P, market: 'IT', override: lockInput, by: 'user:owner', now: NOW }))
    expect(back).toMatchObject({ ok: true, plan: { needsCode: true } })
    expect(back.ok && [...back.plan.goesLive].sort()).toEqual(['a-live', 'b-asin'].map(C).sort())
    expect(await modes()).toMatchObject({ [C('a-live')]: 'LIVE', [C('b-asin')]: 'LIVE' })
    expect(await amazonRows()).toBe(0)
  })

  it('a product EXCLUDE on a campaign at a floor only the brain would lift is saved: that campaign waits, HELD, then leaves when set again', async () => {
    // b-asin's keyword sits at a floor the brain wrote (a stop) with no memory of its bid: no engine would give it back.
    await database.pool.query('UPDATE "AdTarget" SET "bidCents" = 3 WHERE id = $1', [`t-${C('b-asin')}`])
    await database.pool.query(`INSERT INTO "BidBrainDecision" ("workspaceId", id, "runId", mode, kind, marketplace, "campaignId", "adGroupId", "targetId", action, layer, "currentCents", "decidedCents", "dataDay", why)
      VALUES ($1, $2, 'run-floor', 'LIVE', 'change', 'IT', $3, $4, $5, 'write', 'stop', 40, 3, '2026-10-07', 'stop: test floor')`, [W, `d-${hex}`, C('b-asin'), `g-${C('b-asin')}`, `t-${C('b-asin')}`])
    const exclude = { scope: 'PRODUCT' as const, kind: 'EXCLUDE' as const, key: '*' }
    const out = await inW(() => setOverride({ productId: P, market: 'IT', override: exclude, by: 'user:owner', reason: 'not now', now: NOW }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.plan.steps?.find((s) => s.campaignId === C('a-live'))).toMatchObject({ op: 'shadow' })
    expect(out.plan.steps?.find((s) => s.campaignId === C('b-asin'))).toMatchObject({ op: 'wait', hold: true, why: expect.stringContaining('cannot go back to shadow now') })
    expect(await modes()).toMatchObject({ [C('a-live')]: 'SHADOW', [C('b-asin')]: 'HELD' })
    expect((await rows<{ n: number }>('SELECT count(*)::int n FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND kind = \'EXCLUDE\' AND scope = \'PRODUCT\' AND "endedAt" IS NULL', [W]))[0].n).toBe(1)
    expect((await inW(() => brainView(P, 'IT')))!.drift).toContainEqual(expect.stringContaining('LIVE although the Owner keeps the bid brain off (b-asin)'))
    // The floor lifted (the keyword serves again): the same exclusion, set again, takes it to shadow.
    await database.pool.query('UPDATE "AdTarget" SET "bidCents" = 40 WHERE id = $1', [`t-${C('b-asin')}`])
    const again = await inW(() => setOverride({ productId: P, market: 'IT', override: exclude, by: 'user:owner', now: NOW }))
    expect(again).toMatchObject({ ok: true, plan: { set: null, steps: expect.arrayContaining([{ campaignId: C('b-asin'), name: 'b-asin', op: 'shadow', why: expect.stringContaining('excluded') }]) } })
    expect((await modes())[C('b-asin')]).toBe('SHADOW')
    // Ending the exclusion: a-live (its own AUTO) and b-asin (the product's AUTO) go LIVE again — a big door.
    const end = await inW(() => endOverride({ productId: P, market: 'IT', override: exclude, by: 'user:owner', now: NOW }))
    expect(end.ok && [...end.plan.goesLive].sort()).toEqual(['a-live', 'b-asin'].map(C).sort())
    expect(await modes()).toMatchObject({ [C('a-live')]: 'LIVE', [C('b-asin')]: 'LIVE' })
    expect(await amazonRows()).toBe(0)
  })

  it('the product\'s bids lever back to OBSERVE takes every own campaign back to shadow, a HELD one included; a campaign\'s own AUTO stays', async () => {
    expect(await inW(() => holdCampaigns({ campaignIds: [C('b-asin')], until: new Date(Date.now() + 7 * 86_400_000), by: 'auto-undo', reason: 'test hold' }))).toEqual([C('b-asin')])
    expect((await modes())[C('b-asin')]).toBe('HELD')
    const r = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'OBSERVE', by: 'user:owner', now: NOW }))
    expect(r.ok && r.plan.steps?.filter((s) => s.op === 'shadow').map((s) => s.campaignId)).toEqual([C('b-asin')])
    expect(r.ok && r.plan.needsCode).toBe(false)
    // The plan names every campaign it does not reach: a-live keeps its own AUTO, c-fba its lock, d-off its own OBSERVE.
    expect(r.ok && r.plan.notReached.map((n) => n.campaignId).sort()).toEqual(['a-live', 'c-fba', 'd-off'].map(C).sort())
    expect(r.ok && r.plan.notReached.find((n) => n.campaignId === C('a-live'))?.why).toMatch(/AUTO by the Owner's campaign override/)
    // a-live keeps its own AUTO (a campaign choice beats the product's level).
    expect(await modes()).toEqual({ [C('a-live')]: 'LIVE', [C('b-asin')]: 'SHADOW', [C('c-fba')]: 'SHADOW', [C('e-shared')]: 'SHADOW' })
    expect((await rows<{ heldUntil: Date | null; heldBy: string | null }>('SELECT "heldUntil", "heldBy" FROM "BidBrainEnrollment" WHERE "campaignId" = $1', [C('b-asin')]))[0]).toEqual({ heldUntil: null, heldBy: null })
    const s = await inW(() => brainSettings(P, 'IT'))
    expect(s?.levers.bids).toMatchObject({ level: { value: 'OBSERVE', source: 'product', by: 'user:owner' }, effective: 'OBSERVE' })
    // The adopted AUTO is history now, ended by this change.
    expect((await rows<{ n: number }>('SELECT count(*)::int n FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND kind = \'LEVEL\' AND key = \'bids\' AND scope = \'PRODUCT\' AND "productId" = $2 AND "endedAt" IS NOT NULL', [W, P]))[0].n).toBe(1)
    expect(await amazonRows()).toBe(0)
  })

  it('rollback: once a product is enrolled, give-back always runs — an archived campaign, a deleted family root, a plain one', async () => {
    const R = id('r'), R1 = id('r1'), S = id('s'), S1 = id('s1')
    await inW(async () => {
      const db = database.client
      await db.product.create({ data: { id: R, sku: `AB1-BOOT-${hex}`, name: 'boot', basePrice: '99.00', totalStock: 5, isParent: true } })
      await db.product.create({ data: { id: R1, sku: `AB1-BOOT-42-${hex}`, name: 'boot 42', basePrice: '99.00', totalStock: 5, parentId: R, amazonAsin: `B0AB1BT4${H}` } })
      await db.product.create({ data: { id: S, sku: `AB1-GLOVE2-${hex}`, name: 'glove', basePrice: '49.00', totalStock: 5, isParent: true } })
      await db.product.create({ data: { id: S1, sku: `AB1-GLOVE2-M-${hex}`, name: 'glove M', basePrice: '49.00', totalStock: 5, parentId: S, amazonAsin: `B0AB1GV2${H}` } })
      const live = async (key: string, productId: string, asin: string, snapshotBid: number, extra: Record<string, unknown> = {}) => {
        await db.campaign.create({ data: { id: C(key), name: key, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
        await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
        await db.adTarget.create({ data: { id: `t-${C(key)}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `boot ${key}`, bidCents: 40, externalTargetId: `EXT-t-${C(key)}` } })
        await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId, asin } })
        await db.bidBrainEnrollment.create({ data: { campaignId: C(key), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner-1008', snapshot: { takenAt: '2026-10-08T10:56:00.000Z', adGroups: [], targets: [{ id: `t-${C(key)}`, bidCents: snapshotBid }], placements: [] } } })
      }
      await live('r-live', R1, `B0AB1BT4${H}`, 55)
      await live('r-archived', R1, `B0AB1BT4${H}`, 66, { status: 'ARCHIVED' })
      await live('s-live', S1, `B0AB1GV2${H}`, 77)
    })
    expect(await inW(() => enrollProduct({ productId: R, market: 'IT', by: 'user:owner' }))).toMatchObject({ ok: true, bids: 'AUTO', adoptedLive: [C('r-live')] })
    expect(await inW(() => enrollProduct({ productId: S, market: 'IT', by: 'user:owner' }))).toMatchObject({ ok: true, bids: 'AUTO', adoptedLive: [C('s-live')] })
    const giveBack = (campaignId: string) => inW(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
      const asked = await runOrQueueTool('set-bid-brain-enrollment', { campaignId, op: 'give-back', why: 'rollback test' }, person('u-asker', 'claude'), run.id)
      expect(asked).toMatchObject({ ok: true, mode: 'queued' })
      return { approvalId: asked.approvalId!, decided: await decideApproval(asked.approvalId!, 'approve', person('u-approver', 'app')) }
    })
    const bid = async (key: string) => (await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = $1', [`t-${C(key)}`]))[0].b
    // An archived campaign: the product's lever never moves it, so nothing is recorded, and the snapshot comes back.
    const arch = await giveBack(C('r-archived'))
    expect(arch.decided).toMatchObject({ ok: true, status: 'executed' })
    expect((arch.decided as { result?: { warnings?: unknown } }).result?.warnings).toBeUndefined()
    expect((await modes())[C('r-archived')]).toBe('SHADOW')
    expect(await bid('r-archived')).toBe(66)
    // A plain own campaign of the enrolled product: back, and kept as the Owner's campaign choice (the nested change).
    const plain = await giveBack(C('r-live'))
    expect(plain.decided).toMatchObject({ ok: true, status: 'executed' })
    expect((await modes())[C('r-live')]).toBe('SHADOW')
    expect(await bid('r-live')).toBe(55)
    expect((await inW(() => brainSettings(R, 'IT', C('r-live'))))?.levers.bids).toMatchObject({ level: { value: 'OBSERVE', source: 'campaign', reason: expect.stringContaining('set-bid-brain-enrollment op give-back') }, effective: 'OBSERVE' })
    // The product's family root was deleted: its record fails, and the way back out still runs, with a warning.
    await database.pool.query('UPDATE "Product" SET "deletedAt" = now() WHERE id = $1', [S])
    const broken = await giveBack(C('s-live'))
    expect(broken.decided).toMatchObject({ ok: true, status: 'executed', result: { warnings: [expect.stringContaining('could not record it as the Owner\'s campaign choice')] } })
    expect((await modes())[C('s-live')]).toBe('SHADOW')
    expect(await bid('s-live')).toBe(77)
    const [change] = await rows<{ after: { warnings?: string[] } }>('SELECT after FROM "AgentChange" WHERE "approvalId" = $1', [broken.approvalId])
    expect(change.after.warnings?.[0]).toMatch(/could not record/)
  })

  it('AB-2 follow-up — a stop\'s saved settings on a campaign: the product\'s AUTO skips it by name (no failed change); its way back to shadow gives them back', async () => {
    const owe = () => database.pool.query('UPDATE "Campaign" SET "biddingStrategy" = \'LEGACY_FOR_SALES\', "suppressedFromBiddingStrategy" = \'AUTO_FOR_SALES\' WHERE id = $1', [C('b-asin')])
    const memory = async () => (await rows<{ b: string; s: string | null }>('SELECT "biddingStrategy" b, "suppressedFromBiddingStrategy" s FROM "Campaign" WHERE id = $1', [C('b-asin')]))[0]
    expect((await modes())[C('b-asin')]).toBe('SHADOW')
    // Down only with up and down still owed: LIVE would refuse it (never dropped unseen), so it is a named skip.
    await owe()
    const live = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'AUTO', by: 'user:owner', now: NOW }))
    expect(live.ok).toBe(true)
    expect(live.ok && live.plan.steps?.find((s) => s.campaignId === C('b-asin'))).toMatchObject({ op: 'skip', why: expect.stringMatching(/b-asin cannot go LIVE yet: a stop's saved settings are still owed: the bidding strategy it switched to down only \(up and down saved\) — set-bid-brain-enrollment op live gives them back first/) })
    expect((await modes())[C('b-asin')]).toBe('SHADOW')
    expect(await memory()).toEqual({ b: 'LEGACY_FOR_SALES', s: 'AUTO_FOR_SALES' })
    // Settled (up and down again): it goes LIVE with the product's AUTO, the old memory dropped.
    await database.pool.query('UPDATE "Campaign" SET "biddingStrategy" = \'AUTO_FOR_SALES\' WHERE id = $1', [C('b-asin')])
    const v = await version()
    const again = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'AUTO', by: 'user:owner', now: NOW, expectVersion: v }))
    expect(again.ok && again.plan.steps?.find((s) => s.campaignId === C('b-asin'))).toMatchObject({ op: 'live' })
    expect((await modes())[C('b-asin')]).toBe('LIVE')
    expect(await memory()).toEqual({ b: 'AUTO_FOR_SALES', s: null })
    // A stop's memory while LIVE, then the product's lever back to OBSERVE: the shadow step gives the strategy back.
    await owe()
    const before = await amazonRows()
    const back = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'OBSERVE', by: 'user:owner', now: NOW }))
    expect(back.ok && back.plan.steps?.find((s) => s.campaignId === C('b-asin'))).toMatchObject({ op: 'shadow' })
    expect((await modes())[C('b-asin')]).toBe('SHADOW')
    expect(await memory()).toEqual({ b: 'AUTO_FOR_SALES', s: null })
    expect(await rows('SELECT "userId", "payloadAfter" ->> \'biddingStrategy\' AS s FROM "AdvertisingActionLog" WHERE "entityId" = $1 AND "actionType" = \'AD_BIDDING_STRATEGY_UPDATE\'', [C('b-asin')])).toEqual([{ userId: 'user:owner', s: 'AUTO_FOR_SALES' }])
    expect(await amazonRows()).toBeGreaterThan(before)
  })
})
