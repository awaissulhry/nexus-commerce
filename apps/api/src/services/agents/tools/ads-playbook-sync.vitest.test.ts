/**
 * ADS PLAYBOOK PB-10 — ads-playbook view drift and apply-ads-playbook op sync, run for real through the door and the
 * approval gate (PGlite, production schema; the ads write gate the real one, sandbox). The negative write service and
 * the create service are spies that write the Nexus row a sandbox write would (nothing leaves the process). Values are
 * made up (public repo).
 *
 *   rule 3      products A and B both buy the keyword "test jacket" in their own Broad and Exact | Category slots; A's
 *               Exact | Brand slot is a campaign that advertises A and B. A's drift and A's sync reach only A's own ad
 *               groups (the shared one is left out with its reason); B's keywords stay as they are and B gets nothing
 *   the Owner   a campaign his own hourly plan holds is listed as held, and that rank role is not compared: never drift
 *   a person    a negative a person lifted from A's Auto slot is listed as his (keep: out of the product's negatives,
 *               revert: sync); a sync never puts it back unless revert names it
 *   by rule     what adds spend (a missing keyword) is refused by rule; a sync of negatives only is judged by the kit
 *   approved    the sync writes exactly the negatives approved, as the approver, in A's ad groups only; a keyword is born
 *               at the 2-cent floor with its planned bid remembered; the row records op sync; undo retires the negatives
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { seedProductPlaybook } from '../../../test-support/ads-playbook-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
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
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
/** The negative write service and the create service: spies that write the row a sandbox write would. */
const spies = vi.hoisted(() => ({ negatives: [] as Array<Record<string, any>>, keywords: [] as Array<Record<string, any>> }))
vi.mock('../../advertising/ads-negative-kw.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writeNegativeKeyword: async (args: Record<string, any>) => {
    spies.negatives.push(args)
    const prisma = (await import('../../../db.js')).default as any
    const row = await prisma.adTarget.create({ data: { adGroupId: args.adGroupId, kind: 'KEYWORD', isNegative: true, negativeLevel: 'AD_GROUP', expressionType: `NEGATIVE_${args.matchType}`, expressionValue: args.keywordText, bidCents: 0 } })
    return { outcome: 'created', mode: 'sandbox', externalTargetId: null, reachedAmazon: false, adTargetId: row.id, refusal: null, error: null, rawResponse: null }
  },
}))
vi.mock('../../advertising/ads-create.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createKeywordLocal: async (args: Record<string, any>) => {
    spies.keywords.push(args)
    const prisma = (await import('../../../db.js')).default as any
    const row = await prisma.adTarget.create({ data: { adGroupId: args.adGroupId, kind: 'KEYWORD', expressionType: args.matchType, expressionValue: args.keywordText, bidCents: Math.round(args.bidEur * 100) } })
    return { id: row.id, externalTargetId: null }
  },
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')
type Row = Record<string, any>
const db = () => database.client
const read = async (args: Record<string, unknown>) => (await inside(() => callTool(claude, 'ads-playbook', { view: 'drift', market: 'IT', ...args }))).raw as Row
const preview = async (args: Record<string, unknown>) => (await inside(() => callTool(claude, 'apply-ads-playbook', { op: 'sync', market: 'IT', ...args }))).raw as Row
async function ask(args: Record<string, unknown>) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool('apply-ads-playbook', { op: 'sync', market: 'IT', ...args }, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool('apply-ads-playbook')!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}

type Seeded = Awaited<ReturnType<typeof seedProductPlaybook>>
let A: Seeded
let B: Seeded
/** Ad group ids by product and slot. */
const groups: Record<'A' | 'B', Record<string, string>> = { A: {}, B: {} }
let personsNegative = ''

/**
 * The product's slots as live campaigns, adopted: each with one ad group advertising the product's two children, its
 * keywords as the terms feed them, the product's negative in every keyword and Auto slot, PAT's placements. `shared`:
 * the Exact | Brand slot is a campaign that also advertises `shared`'s first child.
 */
async function slotsOf(token: 'A' | 'B', s: Seeded, asinPrefix: string, opts: { shared?: { productId: string; asin: string; sku: string } } = {}) {
  const c = db()
  const brand = `${s.skus.parent.split('-')[1].toLowerCase()} jacket`
  const parts: Record<string, string> = { auto: 'Auto', 'broad-category': 'Broad | Category', 'exact-category': 'Exact | Category', 'exact-brand': 'Exact | Brand', pat: 'PAT' }
  for (const [key, words] of Object.entries(parts)) {
    const name = `${s.skus.parent.split('-')[1]} | IT | ${words}`
    const camp = await c.campaign.create({ data: {
      name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date(), externalCampaignId: `EXT-${token}-${key}`,
      targetingType: key === 'auto' ? 'AUTO' : 'MANUAL', liveBidWritesEnabled: true,
      ...(key === 'pat' ? { dynamicBidding: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 10 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 15 }] } } : {}),
    } })
    const g = await c.adGroup.create({ data: { campaignId: camp.id, name, externalAdGroupId: `EXT-G-${token}-${key}` } })
    groups[token][key] = g.id
    await c.adProductAd.create({ data: { adGroupId: g.id, asin: `${asinPrefix}01`, sku: s.skus.v1, productId: s.v1, externalAdId: `EXT-AD-${token}-${key}-1` } })
    await c.adProductAd.create({ data: { adGroupId: g.id, asin: `${asinPrefix}02`, sku: s.skus.v2, productId: s.v2, externalAdId: `EXT-AD-${token}-${key}-2` } })
    if (key === 'exact-brand' && opts.shared) await c.adProductAd.create({ data: { adGroupId: g.id, asin: opts.shared.asin, sku: opts.shared.sku, productId: opts.shared.productId, externalAdId: `EXT-AD-${token}-shared` } })
    const kw = (text: string, match: string) => c.adTarget.create({ data: { adGroupId: g.id, kind: 'KEYWORD', expressionType: match, expressionValue: text, bidCents: 40, status: 'ENABLED', externalTargetId: `EXT-T-${token}-${key}-${text}-${match}` } })
    if (key === 'broad-category') { await kw('test jacket', 'BROAD'); await kw('test coat', 'BROAD') }
    if (key === 'exact-category') await kw('test jacket', 'EXACT')
    if (key === 'exact-brand') await kw(brand, 'EXACT')
    if (key === 'pat') await c.adTarget.create({ data: { adGroupId: g.id, kind: 'PRODUCT', expressionType: 'ASIN_SAME_AS', expressionValue: 'B0TESTRIV1', bidCents: 40, status: 'ENABLED', externalTargetId: `EXT-T-${token}-pat` } })
    if (key !== 'pat') {
      const lifted = token === 'A' && key === 'auto'
      const n = await c.adTarget.create({ data: { adGroupId: g.id, kind: 'KEYWORD', isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_PHRASE', expressionValue: 'test kids', bidCents: 0, status: lifted ? 'ARCHIVED' : 'ENABLED', externalTargetId: `EXT-N-${token}-${key}` } })
      if (lifted) {
        personsNegative = n.id
        await c.advertisingActionLog.create({ data: { userId: 'user:u-owner', actionType: 'retire_negative', entityType: 'AD_TARGET', entityId: n.id, payloadBefore: {}, payloadAfter: { status: 'ARCHIVED' }, amazonResponseStatus: 'SUCCESS' } })
      }
    }
    await c.adsPlaybookLink.create({ data: { playbookId: s.rowId, kind: 'slot', key, refId: camp.id, adGroupId: g.id, origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
  }
  await c.adsPlaybook.update({ where: { id: s.rowId }, data: { state: 'RUNNING' } })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(db())
    A = await seedProductPlaybook(db(), { token: 'TESTSYA', asinPrefix: 'B0TESTSA' })
    B = await seedProductPlaybook(db(), { token: 'TESTSYB', asinPrefix: 'B0TESTSB' })
    await slotsOf('A', A, 'B0TESTSA', { shared: { productId: B.v1, asin: 'B0TESTSB01', sku: B.skus.v1 } })
    await slotsOf('B', B, 'B0TESTSB')
    await db().adsStrategy.updateMany({ where: { market: 'IT', level: 'MARKET' }, data: { claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 100_000 } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

const mineA = () => new Set(Object.entries(groups.A).filter(([k]) => k !== 'exact-brand').map(([, g]) => g))
const allB = () => new Set(Object.values(groups.B))

describe('rule 3 — two products buy the same keyword; each one\'s drift is its own', () => {
  it("A's drift lists only A's own ad groups; the campaign that also advertises B is left out, with why", async () => {
    const r = await read({ productId: A.parent })
    expect(r.ok).toBe(true)
    const items = r.data.items as Row[]
    expect(items.length).toBeGreaterThan(0)
    for (const i of items) {
      if (i.adGroupId) expect(mineA().has(i.adGroupId), `${i.key} lands in ${i.adGroupId}`).toBe(true)
      expect(allB().has(i.adGroupId)).toBe(false)
    }
    // The shared keyword: A's own exact "test jacket" is kept apart from A's own Broad slot — never from B's.
    expect(items).toContainEqual(expect.objectContaining({ kind: 'negative_missing', slot: 'broad-category', term: 'test jacket', match: 'EXACT', adGroupId: groups.A['broad-category'], negative: expect.objectContaining({ of: 'isolation' }) }))
    expect(r.data.excluded).toContainEqual({ slot: 'exact-brand', why: expect.stringMatching(/also advertises TEST-TESTSYB-V1, which is not this product/) })
    expect(r.data.note).toMatch(/Bids and budgets the engines, Claude or a person moved are not drift/)
  })

  it("the Owner's own hourly plan is never drift: a campaign it holds is listed as held, the role not compared", async () => {
    const own = await inside(async () => {
      const g = await db().rankScheduleGroup.create({ data: { name: 'Owner test plan', marketplace: 'IT', windows: [{ days: [1], startHour: 9, endHour: 17, targetKey: 'test-owner' }], enabled: true } })
      await db().adSchedule.create({ data: { campaignId: (await db().adGroup.findUniqueOrThrow({ where: { id: groups.B['exact-category'] } })).campaignId, name: 'Owner test plan member', groupId: g.id, windows: [], enabled: true } })
      return g.id
    })
    const r = await read({ productId: B.parent })
    expect((r.data.items as Row[]).filter((i) => i.artifact?.kind === 'rankGroup').map((i) => i.key)).toEqual(['artifact_missing|rankgroup|rank:research'])
    expect(r.data.heldBack).toContainEqual({ slot: 'exact-category', what: 'TESTSYB | IT | Exact | Category', why: expect.stringMatching(/^Held by the Owner's plan — the hourly plan "Owner test plan"/) })
    expect(r.data.notChecked).toContainEqual(expect.stringMatching(/^rankGroup: the performance plan is not compared: 1 campaign of it is held by an hourly plan the playbook did not make/))
    await inside(() => db().rankScheduleGroup.delete({ where: { id: own } }))
    await inside(() => db().adSchedule.deleteMany({ where: { name: 'Owner test plan member' } }))
  })

  it("B's drift is B's alone; the market list counts both", async () => {
    const r = await read({ productId: B.parent })
    for (const i of r.data.items as Row[]) if (i.adGroupId) expect(allB().has(i.adGroupId)).toBe(true)
    const list = await read({})
    expect((list.data.products as Row[]).map((p) => p.sku).sort()).toEqual([A.skus.parent, B.skus.parent].sort())
    expect((list.data.products as Row[])[0]).toMatchObject({ counts: expect.objectContaining({ items: expect.any(Number) }), top: expect.any(Array) })
  })
})

describe("a person's own change is his: keep or revert, never put back by itself", () => {
  it('the negative a person lifted is listed with both; a sync leaves it unless revert names it', async () => {
    const r = await read({ productId: A.parent })
    const lifted = (r.data.items as Row[]).find((i) => i.kind === 'negative_missing' && i.slot === 'auto' && i.term === 'test kids')!
    expect(lifted).toMatchObject({
      byPerson: { userId: 'user:u-owner', action: 'retire_negative' },
      revert: { by: 'sync', part: 'negatives' },
      keep: { tool: 'set-ads-playbook', args: { kind: 'playbook', market: 'IT', level: 'product', productId: A.parent, values: { terms: expect.objectContaining({ negatives: [] }) } } },
    })
    const p = (await preview({ productId: A.parent })).preview as Row
    expect((p.negatives as Row[]).map((n) => n.key)).not.toContain(lifted.key)
    expect(p.left.byPerson).toContainEqual(expect.objectContaining({ key: lifted.key, keep: expect.any(Object), revert: expect.any(Object) }))
    const named = (await preview({ productId: A.parent, fix: [lifted.key] })).error
    expect(named).toMatch(/is a change user:u-owner made himself — name it in revert/)
    const reverted = (await preview({ productId: A.parent, fix: [lifted.key], revert: [lifted.key] })).preview as Row
    expect(reverted.negatives).toEqual([expect.objectContaining({ key: lifted.key, reverted: true })])
    expect(personsNegative).toBeTruthy()
  })
})

describe('by rule: what adds spend waits for a person', () => {
  it('a missing keyword adds spend: refused by rule; negatives only are judged by the kit', async () => {
    await inside(() => db().adTarget.updateMany({ where: { adGroupId: groups.A['broad-category'], expressionValue: 'test coat' }, data: { status: 'ARCHIVED' } }))
    const drift = await read({ productId: A.parent })
    const archived = (drift.data.items as Row[]).find((i) => i.kind === 'positive_archived')
    expect(archived).toMatchObject({ term: 'test coat', fix: { by: 'none' }, keep: { tool: 'set-ads-playbook' } })
    // An archived keyword never comes back; drop the row so it is missing (as if never made).
    await inside(() => db().adTarget.deleteMany({ where: { adGroupId: groups.A['broad-category'], expressionValue: 'test coat' } }))
    const missing = ((await read({ productId: A.parent })).data.items as Row[]).find((i) => i.kind === 'positive_missing')!
    expect(missing).toMatchObject({ slot: 'broad-category', term: 'test coat', match: 'BROAD', startBidCents: expect.any(Number) })
    const spend = (await preview({ productId: A.parent, fix: [missing.key] })).preview as Row
    expect(spend).toMatchObject({ op: 'sync', addsSpend: true, totals: { positives: 1 }, effect: expect.stringMatching(/It adds spend: a person decides\./) })
    expect(judge(spend, { maxItems: 10 })).toMatch(/^it adds spend/)
    const negKey = ((await read({ productId: A.parent })).data.items as Row[]).find((i) => i.kind === 'negative_missing' && !i.byPerson)!.key
    const lowering = (await preview({ productId: A.parent, fix: [negKey] })).preview as Row
    expect(lowering).toMatchObject({ addsSpend: false, totals: { negatives: 1, positives: 0 }, limitFacts: { tool: 'apply-ads-playbook', action: 'negative' } })
    expect(judge(lowering, { maxItems: 10 }) ?? '').not.toMatch(/adds spend/)
  })
})

describe('approved, a sync adds exactly what was approved — in A\'s own ad groups only', () => {
  it('negatives (and the reverted one) through the write service, a keyword at the floor; op sync recorded; undo retires the negatives', async () => {
    const drift = await read({ productId: A.parent })
    const items = drift.data.items as Row[]
    const negatives = items.filter((i) => i.kind === 'negative_missing').map((i) => i.key)
    const lifted = items.find((i) => i.kind === 'negative_missing' && i.byPerson)!.key
    const keyword = items.find((i) => i.kind === 'positive_missing')!
    const asked = await ask({ productId: A.parent, fix: [...negatives, keyword.key], revert: [lifted], why: 'sync the test playbook' })
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    spies.negatives.length = 0
    spies.keywords.length = 0
    const done = await approve(asked.approvalId!) as Row
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { changeSetId: asked.approvalId, negatives: { local: negatives.length } } })
    expect(spies.negatives).toHaveLength(negatives.length)
    for (const n of spies.negatives) {
      expect(mineA().has(n.adGroupId)).toBe(true)
      expect(allB().has(n.adGroupId)).toBe(false)
      expect(n).toMatchObject({ scope: 'AD_GROUP', userId: 'user:u-approver', changeSetId: asked.approvalId, protectConverting: null })
    }
    expect(spies.negatives).toContainEqual(expect.objectContaining({ adGroupId: groups.A.auto, keywordText: 'test kids', matchType: 'PHRASE' }))
    expect(spies.keywords).toEqual([expect.objectContaining({ adGroupId: groups.A['broad-category'], keywordText: 'test coat', matchType: 'BROAD', bidEur: 0.02, changeSetId: asked.approvalId })])
    const made = await inside(() => db().adTarget.findFirstOrThrow({ where: { adGroupId: groups.A['broad-category'], expressionValue: 'test coat', isNegative: false }, select: { bidCents: true, suppressedFromBidCents: true } }))
    expect(made).toEqual({ bidCents: 2, suppressedFromBidCents: keyword.startBidCents })
    // B is untouched: its "test jacket" keywords stand, and it got no negative.
    expect(await inside(() => db().adTarget.count({ where: { adGroupId: { in: [...allB()] }, expressionValue: 'test jacket', isNegative: false, status: 'ENABLED' } }))).toBe(2)
    expect(await inside(() => db().adsPlaybookVersion.findFirst({ where: { refId: A.rowId, op: 'sync' }, select: { approvalId: true } }))).toEqual({ approvalId: asked.approvalId })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'undo-ad-change', args: { changeSetId: asked.approvalId } } })
    // Nothing is left for this sync to fix among what it took.
    const after = (await read({ productId: A.parent })).data.items as Row[]
    expect(after.filter((i) => [...negatives, keyword.key].includes(i.key))).toEqual([])
  })

  it('a sync that moved since approval is not run', async () => {
    await inside(() => db().adTarget.deleteMany({ where: { adGroupId: groups.A['broad-category'], expressionValue: 'test coat', isNegative: false } }))
    const asked = await ask({ productId: A.parent })
    await inside(() => db().adsPlaybook.update({ where: { id: A.rowId }, data: { version: { increment: 1 } } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/basis changed|moved/) })
  })
})
