/**
 * ONE BRAIN AB-9 — the term ledger and the market arbiter on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), over two sibling products in IT: a jacket (an auto campaign and an exact one) and a glove (an exact campaign that
 * also bids on "racing jacket"), a campaign both advertise, the IT strategy's 25 % target, the jacket's brand word in its
 * playbook and a protected term.
 *
 *   tables   AdsBrainTerm and AdsBrainTermLead: one row per (product, market, term) and per (market, term), invisible to
 *            another business through Prisma and raw SQL, refused without a business, row-level security forced with the
 *            business policy and the reference guard
 *   no-op    nothing enrolled: the job's tick reads the enrollments, decides nothing, writes nothing, records no run
 *   shadow   the jacket enrolled (negatives and harvest OBSERVE by default): one decision per term — targeted, harvest
 *            candidate (its exact ad group the destination), negate candidate, brand and protected terms PROTECTED, a
 *            keyword blocked in its own ad group TARGETED with the clash, too little evidence WATCH; the shared campaign's
 *            terms are no product's; the two siblings on "racing jacket" → one lead (the jacket, by profit per click) and
 *            the glove's keyword capped at 0.8 × the lead's bid; nothing at Amazon, no bid changed
 *   rerun    the same facts change no decision (same rows, same since); an order on a negate candidate makes it WATCH
 *            (the state before kept), a term that left the window is removed
 *   read     the ads-brain terms view: the stored ledger (a variation names its parent), the lead, the clashes it
 *            removes; the market's ledgers; a dry run for the glove (not enrolled), stored nowhere; every amount hidden
 *            from a person without the ad-spend permission, the rest unchanged
 *   off      both levers OFF → not due, nothing decided; rows older than 30 days pruned also then; another business
 *            decides and sees nothing
 *
 * Every value is made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
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

const { runTermsOnce, termsDue } = await import('./terms-shadow.js')
const { runBrainTermsTick, BRAIN_TERMS_JOB } = await import('../../../jobs/ads-brain-terms.job.js')
const { enrollProduct, setLever } = await import('./enrollment.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { visibleTo } = await import('../../agents/call-tool.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab9_terms_${hex}`
const W2 = `ab9_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const G = (s: string) => `g-${C(s)}`
const JACKET = id('jacket'), JACKET_M = id('jacket-m'), GLOVE = id('glove'), GLOVE_L = id('glove-l')
const NOW = new Date('2026-10-09T05:05:00Z')
const DAY = 86_400_000

type Data = Record<string, any>
const terms = (args: Record<string, unknown>, inX: <T>(work: () => Promise<T>) => Promise<T> = inW) =>
  inX(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'terms', ...args }, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>
// Through Prisma inside the business: a TIMESTAMP read through the raw pool lands on this machine's local clock.
const ledger = async (productId = JACKET) => Object.fromEntries((await inW(() => database.client.adsBrainTerm.findMany({ where: { productId } }))).map((r) => [r.term, r as Data]))
const amazonRows = async () => (await rows<{ n: number }>(
  'SELECT ((SELECT count(*) FROM "AdMutation" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "AdvertisingActionLog" WHERE "workspaceId" = $1))::int AS n', [W]))[0].n
const bids = async () => (await rows<{ id: string; bidCents: number }>('SELECT id, "bidCents" FROM "AdTarget" WHERE "workspaceId" = $1 ORDER BY id', [W]))

/** One search-term row: clicks, orders, spend and sales in cents, on one day. */
const st = (campaign: string, query: string, clicks: number, orders: number, spendCents: number, salesCents: number, date = '2026-09-20') => ({
  profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${date}T00:00:00Z`), campaignId: `EXT-${C(campaign)}`, adGroupId: `EXT-${G(campaign)}`,
  query, impressions: clicks * 7, clicks, costMicros: BigInt(spendCents) * 10_000n, currencyCode: 'EUR', sales7dCents: salesCents, orders7d: orders,
})

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(JACKET, `AB9-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(JACKET_M, `AB9-JACKET-M-${hex}`, { parentId: JACKET, amazonAsin: `B0AB9JKM${H}` })
  await product(GLOVE, `AB9-GLOVE-${hex}`, { isParent: true, name: 'Glove', basePrice: '30.00' })
  await product(GLOVE_L, `AB9-GLOVE-L-${hex}`, { parentId: GLOVE, amazonAsin: `B0AB9GLL${H}`, basePrice: '30.00' })
  const category = await db.category.create({ data: { slug: `jackets-${hex}` } })
  await db.productCategory.create({ data: { productId: JACKET, categoryId: category.id, isPrimary: true } })
  const campaign = async (key: string, groupName: string, ads: Array<[string, string]>, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: key, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), ...extra } })
    await db.adGroup.create({ data: { id: G(key), campaignId: C(key), name: groupName, externalAdGroupId: `EXT-${G(key)}` } })
    for (const [productId, asin] of ads) await db.adProductAd.create({ data: { adGroupId: G(key), productId, asin } })
  }
  const kw = (key: string, tid: string, text: string, bidCents: number, extra: Record<string, unknown> = {}) =>
    db.adTarget.create({ data: { id: id(tid), adGroupId: G(key), kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents, externalTargetId: `EXT-${id(tid)}`, ...extra } })
  const jacket: [string, string] = [JACKET_M, `B0AB9JKM${H}`]
  const glove: [string, string] = [GLOVE_L, `B0AB9GLL${H}`]
  await campaign('jk-auto', 'Auto', [jacket], { targetingType: 'AUTO' })
  await campaign('jk-exact', 'Exact', [jacket], { targetingType: 'MANUAL' })
  await campaign('gl-exact', 'Exact', [glove], { targetingType: 'MANUAL' })
  await campaign('shared', 'Auto', [jacket, glove], { targetingType: 'AUTO' })
  await kw('jk-exact', 't-racing', 'racing jacket', 60)
  await kw('jk-exact', 't-city', 'city jacket', 50)
  await kw('jk-exact', 'n-city', 'city jacket', 0, { isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_EXACT' })
  await kw('gl-exact', 't-gl-racing', 'racing jacket', 70)
  await kw('gl-exact', 't-winter', 'winter gloves', 40)
  await db.amazonAdsSearchTerm.createMany({
    data: [
      st('jk-auto', 'Cheap  Jacket', 800, 0, 16_000, 0),
      st('jk-auto', 'touring jacket', 150, 5, 3000, 40_000),
      st('jk-exact', 'racing jacket', 600, 18, 12_000, 144_000),
      st('jk-auto', 'storm jacket', 900, 0, 18_000, 0),
      st('jk-auto', 'giacca moto acme', 900, 0, 18_000, 0),
      st('jk-auto', 'rain jacket', 30, 0, 600, 0),
      st('jk-auto', 'city jacket', 60, 0, 1200, 0),
      st('gl-exact', 'racing jacket', 50, 0, 2000, 0),
      st('gl-exact', 'winter gloves', 300, 3, 3000, 9000),
      st('shared', 'cheap gloves', 1000, 2, 10_000, 6000),
    ],
  })
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT', targetKind: 'ACOS', targetPct: 25, targetHiPct: 30, updatedBy: 'user:owner' } })
  await db.adsPlaybook.create({ data: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: JACKET, label: 'Jacket (IT)', enrolled: true, terms: { brand: ['storm'] }, updatedBy: 'user:owner' } })
  await db.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'acme', matchType: 'CONTAINS', marketplace: 'IT', reason: 'brand' } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-9 — the term ledger and the market arbiter (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the tables: one row per product × market × term and per market × term, invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const base = { state: 'WATCH', stateSince: NOW, windowDays: 60, dataDay: NOW, why: 'test', evidence: {}, digest: 'd', runId: 'r', checkedAt: NOW, changedAt: NOW }
    const row = await inW(() => db.adsBrainTerm.create({ data: { productId: 'x-table', marketplace: 'IT', term: 'x term', ...base } }))
    expect(row.workspaceId).toBe(W)
    await expect(inW(() => db.adsBrainTerm.create({ data: { productId: 'x-table', marketplace: 'IT', term: 'x term', ...base, state: 'NEGATE_CANDIDATE' } }))).rejects.toMatchObject({ code: 'P2002' })
    const lead = await inW(() => db.adsBrainTermLead.create({ data: { marketplace: 'IT', term: 'x term', leadProductId: 'x-table', leadSince: NOW, rule: 'id', contenders: [], wouldLower: [], why: 't', digest: 'd', runId: 'r', checkedAt: NOW, changedAt: NOW } }))
    await expect(inW(() => db.adsBrainTermLead.create({ data: { marketplace: 'IT', term: 'x term', leadProductId: 'y', leadSince: NOW, rule: 'id', contenders: [], wouldLower: [], why: 't', digest: 'd', runId: 'r', checkedAt: NOW, changedAt: NOW } }))).rejects.toMatchObject({ code: 'P2002' })
    await inW2(async () => {
      expect(await db.adsBrainTerm.findMany()).toEqual([])
      expect(await db.adsBrainTermLead.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AdsBrainTerm"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsBrainTermLead" SET rule = 'brand' WHERE id = ${lead.id}`).toBe(0)
      await expect(db.adsBrainTerm.create({ data: { workspaceId: W, productId: 'x', marketplace: 'IT', term: 't', ...base } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
      // The same product, market and term in another business is its own row.
      expect((await db.adsBrainTerm.create({ data: { productId: 'x-table', marketplace: 'IT', term: 'x term', ...base } })).workspaceId).toBe(W2)
    })
    await expect(db.adsBrainTerm.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    for (const table of ['AdsBrainTerm', 'AdsBrainTermLead']) {
      expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [table])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
      expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [table])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
      expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', [table])).toEqual([{ tgname: 'nexus_workspace_references' }])
    }
    await database.pool.query('DELETE FROM "AdsBrainTerm" WHERE "productId" = \'x-table\'')
    await database.pool.query('DELETE FROM "AdsBrainTermLead" WHERE "term" = \'x term\'')
  })

  it('no-op: nothing enrolled — the job\'s tick decides nothing, writes nothing and records no run', async () => {
    expect(await inW(() => termsDue())).toMatchObject({ due: false, why: expect.stringMatching(/no product is enrolled/) })
    expect(await inW(() => runBrainTermsTick(NOW))).toMatchObject({ ran: false, terms: 0, pruned: 0 })
    expect(await rows('SELECT count(*)::int AS n FROM "AdsBrainTerm" WHERE "workspaceId" = $1', [W])).toEqual([{ n: 0 }])
    expect(await rows('SELECT count(*)::int AS n FROM "AdsBrainTermLead" WHERE "workspaceId" = $1', [W])).toEqual([{ n: 0 }])
    expect(await rows('SELECT count(*)::int AS n FROM "CronRun" WHERE "jobName" = $1', [BRAIN_TERMS_JOB])).toEqual([{ n: 0 }])
  })

  it('shadow: one decision per term of the enrolled jacket; two siblings on one term → one lead; nothing at Amazon', async () => {
    const amazonBefore = await amazonRows()
    const bidsBefore = await bids()
    expect(await inW(() => enrollProduct({ productId: JACKET_M, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, productId: JACKET })
    const run = await inW(() => runBrainTermsTick(NOW))
    expect(run).toMatchObject({ ran: true, products: 1, markets: ['IT'], leads: 1, skipped: [], sharedCampaigns: 1 })
    expect(await rows('SELECT status FROM "CronRun" WHERE "jobName" = $1', [BRAIN_TERMS_JOB])).toHaveLength(1)
    const l = await ledger()
    expect(Object.fromEntries(Object.entries(l).map(([t, r]) => [t, r.state]))).toEqual({
      'cheap jacket': 'NEGATE_CANDIDATE',
      'touring jacket': 'HARVEST_CANDIDATE',
      'racing jacket': 'TARGETED',
      'storm jacket': 'PROTECTED',
      'giacca moto acme': 'PROTECTED',
      'rain jacket': 'WATCH',
      'city jacket': 'TARGETED',
    })
    expect(l['storm jacket'].protection).toBe('brand')
    expect(l['giacca moto acme'].protection).toBe('protected-term')
    expect(l['touring jacket']).toMatchObject({ protection: 'winner', heldBy: null, orders: 5, clicks: 150 })
    expect(l['touring jacket'].evidence.destination).toMatchObject({ source: 'own', adGroupId: G('jk-exact'), keywords: 2 })
    expect(l['cheap jacket'].evidence.tests.negate).toMatchObject({ by: 'brain', pass: true })
    expect(l['city jacket']).toMatchObject({ clashCount: 1 })
    expect(l['city jacket'].evidence.clashes[0]).toMatchObject({ kind: 'self-blocking', targetId: id('t-city'), negativeId: id('n-city') })
    // The siblings on "racing jacket": the jacket leads (its pooled profit per click), the glove's 70 capped at 0.8 × 60.
    expect(l['racing jacket'].leadProductId).toBe(JACKET)
    const leads = await rows<Data>('SELECT * FROM "AdsBrainTermLead" WHERE "workspaceId" = $1', [W])
    expect(leads).toHaveLength(1)
    expect(leads[0]).toMatchObject({ term: 'racing jacket', leadProductId: JACKET, rule: 'profit', leadBidCents: 60, maxBidCents: 48 })
    expect(leads[0].wouldLower).toEqual([{ productId: GLOVE, targetId: id('t-gl-racing'), campaignId: C('gl-exact'), adGroupId: G('gl-exact'), bidCents: 70, toBidCents: 48 }])
    // The shared campaign's terms are no product's; the glove is not due, so it has no ledger.
    expect(l['cheap gloves']).toBeUndefined()
    expect(await ledger(GLOVE)).toEqual({})
    // Shadow: nothing at Amazon, no bid changed.
    expect(await amazonRows()).toBe(amazonBefore)
    expect(await bids()).toEqual(bidsBefore)
  })

  it('rerun: the same facts change no decision; an order makes a negate candidate WATCH (the state before kept); a term that left is removed', async () => {
    const before = await ledger()
    const again = await inW(() => runTermsOnce({ now: new Date(NOW.getTime() + 60_000) }))
    expect(again.ledger).toEqual({ created: 0, changed: 0, unchanged: 7, removed: 0 })
    const same = await ledger()
    for (const term of Object.keys(before)) expect([same[term].id, same[term].stateSince.getTime(), same[term].digest]).toEqual([before[term].id, before[term].stateSince.getTime(), before[term].digest])
    // A day later: one order on "cheap jacket"; "rain jacket" leaves (its rows gone).
    await inW(() => database.client.amazonAdsSearchTerm.create({ data: st('jk-auto', 'cheap jacket', 10, 1, 200, 8000, '2026-09-21') }))
    await database.pool.query('DELETE FROM "AmazonAdsSearchTerm" WHERE "workspaceId" = $1 AND query = $2', [W, 'rain jacket'])
    const later = new Date(NOW.getTime() + DAY)
    const next = await inW(() => runTermsOnce({ now: later }))
    expect(next.ledger).toMatchObject({ created: 0, removed: 1 })
    const l = await ledger()
    expect(l['cheap jacket']).toMatchObject({ state: 'WATCH', previousState: 'NEGATE_CANDIDATE', orders: 1 })
    expect(l['cheap jacket'].stateSince.getTime()).toBe(later.getTime())
    expect(l['rain jacket']).toBeUndefined()
    expect(l['racing jacket'].stateSince.getTime()).toBe(before['racing jacket'].stateSince.getTime())
  })

  it('read: the stored ledger, its lead and clashes; the market\'s ledgers; a dry run for the glove; every amount hidden without the ad-spend permission', async () => {
    const out = await terms({ market: 'IT', productId: JACKET_M })
    expect(out.ok).toBe(true)
    const d = out.data!
    expect(d.scope).toEqual({ productId: JACKET, market: 'IT' })
    expect(d.source).toMatchObject({ kind: 'stored', windowDays: 60 })
    expect(d.product.levers).toMatchObject({ negatives: { effective: 'OBSERVE' }, harvest: { effective: 'OBSERVE' } })
    expect(d.counts).toMatchObject({ TARGETED: 2, HARVEST_CANDIDATE: 1, PROTECTED: 2, WATCH: 1, NEGATE_CANDIDATE: 0 })
    expect(d.terms[0]).toMatchObject({ term: 'touring jacket', state: 'HARVEST_CANDIDATE', destination: { source: 'own' } })
    expect(d.terms.find((t: Data) => t.term === 'racing jacket')).toMatchObject({ lead: { productId: JACKET, isThis: true, rule: 'profit' }, money: { lead: { leadBidCents: 60, maxBidCents: 48 } } })
    expect(d.leads).toEqual([expect.objectContaining({ term: 'racing jacket', thisProductLeads: true, rule: 'profit' })])
    expect(d.clashesRemoved.map((c: Data) => [c.term, c.kind])).toEqual(expect.arrayContaining([['city jacket', 'self-blocking'], ['racing jacket', 'sibling']]))
    expect(d.gaps.harvestWithoutDestination).toEqual([])
    const only = await terms({ market: 'IT', productId: JACKET, state: 'PROTECTED' })
    expect(only.data!.terms.map((t: Data) => t.term).sort()).toEqual(['giacca moto acme', 'storm jacket'])
    const market = await terms({ market: 'IT' })
    expect(market.data!.products).toEqual([expect.objectContaining({ productId: JACKET, name: 'Jacket', counts: expect.objectContaining({ TARGETED: 2 }) })])
    // The glove is not enrolled: decided now, stored nowhere — its "racing jacket" is the jacket's lead, its bid capped.
    const glove = await terms({ market: 'IT', productId: GLOVE })
    expect(glove.data!.source.kind).toBe('dryRun')
    expect(glove.data!.product.levers.negatives.effective).toBe('NOT_ENROLLED')
    expect(glove.data!.terms.find((t: Data) => t.term === 'racing jacket')).toMatchObject({ state: 'TARGETED', lead: { productId: JACKET, isThis: false }, money: { wouldLower: [{ targetId: id('t-gl-racing'), bidCents: 70, toBidCents: 48 }] } })
    expect(await ledger(GLOVE)).toEqual({})
    // A person who may read ads but not their money: the same answer minus every money key, and no amount left.
    const principal = (perms: string[]) => ({ kind: 'user' as const, userId: 'u', label: 'u', via: 'claude' as const, workspace: scope(W), permissions: { isOwner: false, permissions: new Set<string>(perms) } })
    const everything = [...Object.values(FEATURES), ...Object.values(FIELDS)]
    const noMoney = everything.filter((p) => !p.startsWith('financials.'))
    for (const answer of [d, market.data, glove.data]) {
      const full = visibleTo(principal(everything) as never, ADS_BRAIN_TOOLS[0], answer)
      const partial = visibleTo(principal(noMoney) as never, ADS_BRAIN_TOOLS[0], answer)
      expect(JSON.stringify(full)).toBe(JSON.stringify(answer))
      const text = JSON.stringify(partial)
      expect(text).not.toContain('"money":')
      for (const amount of ['16000', '144000', '18000', '12000', '"bidCents"', '€']) expect(text).not.toContain(amount)
      expect(text).toBe(JSON.stringify(answer, (k, v) => (k === 'money' ? undefined : v)))
    }
  })

  it('off: both levers OFF → not due, nothing decided; rows older than 30 days pruned also then; another business decides and sees nothing', async () => {
    for (const lever of ['negatives', 'harvest'] as const) expect(await inW(() => setLever({ productId: JACKET, market: 'IT', by: 'user:owner', lever, level: 'OFF' }))).toMatchObject({ ok: true })
    expect(await inW(() => termsDue())).toMatchObject({ due: false, why: expect.stringMatching(/none with the negatives or harvest lever/) })
    const kept = Object.keys(await ledger()).length
    expect(await inW(() => runTermsOnce({ now: new Date(NOW.getTime() + 2 * DAY) }))).toMatchObject({ ran: false, pruned: 0 })
    expect(Object.keys(await ledger())).toHaveLength(kept)
    expect(await inW2(() => runTermsOnce({ now: NOW }))).toMatchObject({ ran: false, pruned: 0 })
    expect((await terms({ market: 'IT' }, inW2)).data!.products).toEqual([])
    expect(await inW(() => runTermsOnce({ now: new Date(NOW.getTime() + 40 * DAY) }))).toMatchObject({ ran: false, pruned: kept + 1 })
    expect(await ledger()).toEqual({})
    expect(await rows('SELECT count(*)::int AS n FROM "AdsBrainTermLead" WHERE "workspaceId" = $1', [W])).toEqual([{ n: 0 }])
  })
})
