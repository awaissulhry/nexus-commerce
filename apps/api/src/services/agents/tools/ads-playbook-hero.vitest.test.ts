/**
 * ADS PLAYBOOK PB-6c — the winners view (ads-playbook view winners) and a winner's own campaign (apply-ads-playbook op
 * hero), run for real through the door and the approval gate (PGlite, production schema; the job queue a stub; the ads
 * write gate the real one, sandbox; the SP Super Wizard launch a stand-in that makes the campaigns in Nexus). Two
 * products, A and B, share the category term "test cape" (the Owner's rule 3: allowed, never blocked). Values are made up.
 *
 *   view      A's terms in A's own campaigns only (a campaign that also advertises B is left out, named): winning where it
 *             runs (no step), declining, lost, unproven (counted); the next step in the Owner's order — bid (auto-bid on
 *             it), placement (a research slot on the allowlist), a campaign of its own
 *   hero      the preview: ONE campaign, ONE exact keyword, modelled on Exact | Category, its bid the term's cost per
 *             click, where the term runs now; B buying the same term only listed; by rule the default limits refuse it
 *   approved  built by the playbook's build (the wizard's launch, one campaign), linked as the slot hero:<term>; the term
 *             keeps running where it ran — no negative, no lower bid; a second hero for the term is refused; the undo
 *             archives what it made
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
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
/** The wizard's launch, as a stand-in that makes each campaign and its ad group in Nexus (sandbox ids); the bodies kept. */
const launches = vi.hoisted(() => ({ bodies: [] as any[], options: [] as any[] }))
vi.mock('../../advertising/ads-sp-wizard-launch.service.js', () => ({
  spWizardLaunch: async (body: any, _actor: unknown, options: unknown) => {
    launches.bodies.push(body)
    launches.options.push(options)
    const prisma = (await import('../../../db.js')).default as any
    const created: any[] = []
    const slots: Record<string, { campaignId: string; adGroupId: string }> = {}
    for (const c of body.campaigns) {
      const camp = await prisma.campaign.create({ data: { name: c.name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: body.market, dailyBudget: String(c.budgetEur), startDate: new Date(), externalCampaignId: `SBX-${c.name}` } })
      const g = await prisma.adGroup.create({ data: { campaignId: camp.id, name: c.adGroupName, externalAdGroupId: `SBX-G-${c.name}` } })
      created.push({ name: c.name, campaignId: camp.id, externalCampaignId: camp.externalCampaignId, mode: 'sandbox' })
      slots[c.id] = { campaignId: camp.id, adGroupId: g.id }
    }
    return { status: 200, body: { ok: true, created, slots, deferredPlacements: [], launch: { ok: true, campaigns: created.map((c) => ({ name: c.name, status: 'live', reason: null })) }, verification: { ok: true, problems: [] } } }
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
const call = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const finished = async (applicationId: string) => {
  await vi.waitFor(async () => {
    const row = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId }, select: { status: true } }))
    if (row.status === 'RUNNING') throw new Error('still running')
  }, { timeout: 10_000, interval: 50 })
}
const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool('apply-ads-playbook')!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}
const winners = async (productId: string) => (await call('ads-playbook', { view: 'winners', market: 'IT', productId })) as Row
const hero = (productId: string, term: string) => ({ op: 'hero', market: 'IT', productId, term })
const DAY = 86_400_000

type Placed = { campaignId: string; adGroupId: string; ext: string; extCampaign: string }
let A: Awaited<ReturnType<typeof seedProductPlaybook>>
let B: Awaited<ReturnType<typeof seedProductPlaybook>>
let exactA: Placed, broadA: Placed, autoA: Placed, sharedA: Placed, exactB: Placed

/** A campaign with one ad group advertising these products, its positives, linked to a playbook slot. */
async function slotCampaign(rowId: string, key: string, name: string, opts: { allowlist: boolean; ads: Array<{ productId: string; asin: string }>; targets: Array<{ kind?: string; match: string; text: string; ext: string; bidCents: number }> }): Promise<Placed> {
  const c = await db().campaign.create({ data: { name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), externalCampaignId: `EXT-${name}`, liveBidWritesEnabled: opts.allowlist } })
  const g = await db().adGroup.create({ data: { campaignId: c.id, name, externalAdGroupId: `EXT-G-${name}` } })
  for (const ad of opts.ads) await db().adProductAd.create({ data: { adGroupId: g.id, productId: ad.productId, asin: ad.asin } })
  for (const t of opts.targets) await db().adTarget.create({ data: { adGroupId: g.id, kind: t.kind ?? 'KEYWORD', expressionType: t.match, expressionValue: t.text, bidCents: t.bidCents, externalTargetId: t.ext } })
  await db().adsPlaybookLink.create({ data: { playbookId: rowId, kind: 'slot', key, refId: c.id, adGroupId: g.id, origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
  return { campaignId: c.id, adGroupId: g.id, ext: `EXT-G-${name}`, extCampaign: `EXT-${name}` }
}
/** One day of one search term in one ad group, `daysAgo` days back. */
const searched = (g: Placed, query: string, daysAgo: number, r: { orders: number; clicks: number; costCents: number; salesCents: number }, matched: string) =>
  db().amazonAdsSearchTerm.create({ data: {
    profileId: 'P-IT-PB', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.now() - daysAgo * DAY), campaignId: g.extCampaign, adGroupId: g.ext,
    query, impressions: r.clicks * 10, clicks: r.clicks, costMicros: BigInt(r.costCents * 10_000), currencyCode: 'EUR', sales7dCents: r.salesCents, orders7d: r.orders, matchedKeywordId: matched,
  } })

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    A = await seedProductPlaybook(db(), { token: 'TESTWIA', asinPrefix: 'B0TESTWA' })
    B = await seedProductPlaybook(db(), { token: 'TESTWIB', asinPrefix: 'B0TESTWB' })
    // The market strategy lets changes run by rule today: the default limits of the tool still hold a hero.
    await db().adsStrategy.updateMany({ where: { market: 'IT', level: 'MARKET' }, data: { claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 100_000 } })
    const adA = [{ productId: A.v1, asin: 'B0TESTWA01' }]
    exactA = await slotCampaign(A.rowId, 'exact-category', 'TESTWIA | IT | Exact | Category', { allowlist: true, ads: adA, targets: [{ match: 'EXACT', text: 'test coat', ext: 'KW-WA-COAT', bidCents: 50 }] })
    broadA = await slotCampaign(A.rowId, 'broad-category', 'TESTWIA | IT | Broad | Category', { allowlist: false, ads: adA, targets: [{ match: 'BROAD', text: 'test', ext: 'KW-WA-TEST', bidCents: 40 }] })
    autoA = await slotCampaign(A.rowId, 'auto', 'TESTWIA | IT | Auto', { allowlist: true, ads: adA, targets: [{ kind: 'AUTO', match: 'CLOSE_MATCH', text: '', ext: 'AT-WA-CLOSE', bidCents: 40 }] })
    // A campaign that advertises A and B: never A's alone, so never read for A (rule 3).
    sharedA = await slotCampaign(A.rowId, 'exact-brand', 'TESTWIA | IT | Exact | Brand', { allowlist: true, ads: [...adA, { productId: B.v1, asin: 'B0TESTWB01' }], targets: [{ match: 'EXACT', text: 'testwia jacket', ext: 'KW-WA-BRAND', bidCents: 50 }] })
    // B buys "test cape" as its own exact keyword: allowed, and never A's business.
    exactB = await slotCampaign(B.rowId, 'exact-category', 'TESTWIB | IT | Exact | Category', { allowlist: true, ads: [{ productId: B.v1, asin: 'B0TESTWB01' }], targets: [{ match: 'EXACT', text: 'test cape', ext: 'KW-WB-CAPE', bidCents: 60 }] })

    // A's search terms. The strategy sets no harvest group: the rules' fallbacks (2 orders, 60 days) are the bar.
    await searched(exactA, 'test coat', 5, { orders: 6, clicks: 40, costCents: 1600, salesCents: 12_000 }, 'KW-WA-COAT')
    await searched(broadA, 'test cape', 70, { orders: 5, clicks: 30, costCents: 900, salesCents: 9000 }, 'KW-WA-TEST')
    await searched(broadA, 'test cape', 5, { orders: 1, clicks: 10, costCents: 300, salesCents: 1500 }, 'KW-WA-TEST')
    await searched(broadA, 'test cloak', 70, { orders: 4, clicks: 20, costCents: 600, salesCents: 7000 }, 'KW-WA-TEST')
    await searched(broadA, 'test junk', 5, { orders: 0, clicks: 3, costCents: 90, salesCents: 0 }, 'KW-WA-TEST')
    await searched(autoA, 'test vest', 70, { orders: 5, clicks: 25, costCents: 800, salesCents: 9000 }, 'AT-WA-CLOSE')
    await searched(autoA, 'test vest', 5, { orders: 1, clicks: 8, costCents: 240, salesCents: 1500 }, 'AT-WA-CLOSE')
    await searched(sharedA, 'testwia jacket', 5, { orders: 9, clicks: 50, costCents: 1500, salesCents: 20_000 }, 'KW-WA-BRAND')
    await searched(exactB, 'test cape', 5, { orders: 8, clicks: 40, costCents: 1200, salesCents: 14_000 }, 'KW-WB-CAPE')
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

const entry = (view: Row, term: string) => view.data.entries.find((e: Row) => e.term === term)

describe('ads-playbook view winners — one product\'s own campaigns, the Owner\'s order', () => {
  it('winning where it runs (kept), declining, lost, unproven counted; another product\'s campaigns never read', async () => {
    const view = await winners(A.parent)
    expect(view.ok).toBe(true)
    expect(view.data).toMatchObject({ view: 'winners', market: 'IT', product: { productId: A.parent }, scope: { adGroups: 3 }, counts: { winning: 1, declining: 2, lost: 1, unproven: 1 }, listed: 4 })
    expect(view.data.scope.excluded).toEqual([expect.objectContaining({ slot: 'exact-brand', why: expect.stringMatching(/also advertises TEST-TESTWIB-V1, which is not this product/) })])
    expect(view.data.entries.map((e: Row) => [e.term, e.state])).toEqual([['test cloak', 'lost'], ['test cape', 'declining'], ['test vest', 'declining'], ['test coat', 'winning']])
    expect(view.data.entries.map((e: Row) => e.campaignId)).not.toContain(exactB.campaignId)
    expect(view.data.entries.map((e: Row) => e.term)).not.toContain('testwia jacket')

    const coat = entry(view, 'test coat')
    expect(coat).toMatchObject({
      slot: 'exact-category', state: 'winning', nextStep: 'none', ladder: [], servedBy: { text: 'test coat', match: 'EXACT', bidCents: 50 },
      bar: { minOrders: 2, windowDays: 60, source: expect.stringMatching(/harvest rules' defaults/) }, current: { orders: 6, clicks: 40 }, previous: null,
    })
    expect(coat.nextWhy).toMatch(/^winning where it runs: it stays there/)
  })

  it('the next step: a research slot on the allowlist → placement; off the allowlist → a campaign of its own', async () => {
    const view = await winners(A.parent)
    expect(view.data.autoBid).toMatchObject({ on: false, why: expect.stringMatching(/the account ads dial is SUGGEST/) })
    const vest = entry(view, 'test vest')
    expect(vest).toMatchObject({ slot: 'auto', state: 'declining', nextStep: 'placement', placement: { campaignId: autoA.campaignId, otherTerms: 0, tool: 'set-placement-multipliers' } })
    expect(vest.ladder.map((r: Row) => [r.step, r.open])).toEqual([['bid', false], ['placement', true], ['ownCampaign', true]])
    const cape = entry(view, 'test cape')
    expect(cape).toMatchObject({
      slot: 'broad-category', state: 'declining', nextStep: 'ownCampaign', servedBy: { text: 'test', match: 'BROAD' },
      current: { orders: 1, clicks: 10 }, previous: { orders: 5, clicks: 30 },
      ownCampaign: { tool: 'apply-ads-playbook', args: { op: 'hero', market: 'IT', productId: A.parent, term: 'test cape' } },
    })
    expect(cape.ladder[1]).toMatchObject({ step: 'placement', open: false, why: expect.stringMatching(/off the live-write allowlist/) })
    expect(entry(view, 'test cloak')).toMatchObject({ state: 'lost', nextStep: 'ownCampaign', current: null })
  })

  it('auto-bid on (the dial at AUTO, a target you set): bid first — it already moves the bid', async () => {
    await inside(() => db().adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO', defaultTargetAcosPct: 30 }, update: { autonomy: 'AUTO', defaultTargetAcosPct: 30 } }))
    try {
      const view = await winners(A.parent)
      expect(view.data.autoBid.on).toBe(true)
      const vest = entry(view, 'test vest')
      expect(vest).toMatchObject({ nextStep: 'bid', target: { targetAcosPct: 30, source: 'the account default' }, servedBy: { match: 'AUTO', bidCents: 40 } })
      // Off the allowlist, auto-bid cannot write: the ladder goes on.
      expect(entry(view, 'test cape').ladder[0]).toMatchObject({ step: 'bid', open: false, why: expect.stringMatching(/off the live-write allowlist/) })
      expect(entry(view, 'test coat')).toMatchObject({ state: 'winning', nextStep: 'none' })
    } finally {
      await inside(() => db().adsAutomationState.update({ where: { id: 'singleton' }, data: { autonomy: 'SUGGEST', defaultTargetAcosPct: null } }))
    }
  })
})

describe('apply-ads-playbook op hero — the preview and what refuses it', () => {
  it('ONE campaign, ONE exact keyword, modelled on Exact | Category; where the term runs now; B only listed', async () => {
    const r = await call('apply-ads-playbook', hero(A.parent, 'test cape'))
    expect(r.ok).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({
      action: 'apply-ads-playbook', op: 'hero', market: 'IT', term: 'test cape', currency: 'EUR', liveWrites: false, startsSuppressed: { floorCents: 2 },
      hero: { key: 'hero:test cape', intent: 'CATEGORY', modelSlot: 'exact-category', keyword: { text: 'test cape', match: 'EXACT' }, bidFrom: expect.stringMatching(/cost per click/), budgetFrom: expect.stringMatching(/least budget per slot/) },
      current: [{ slot: 'broad-category', campaignId: broadA.campaignId, state: 'declining', nextStep: 'ownCampaign', orders: 1 }],
      keepsRunning: expect.stringMatching(/keeps running where it runs now: no negative, no lower bid, no pause/),
      dailyBudgetCents: 100, highestPlannedBidCents: 30, portfolio: { does: 'none' },
      limitFacts: { tool: 'apply-ads-playbook', action: 'create' }, reach: { reach: 'sandbox' },
      undoNote: expect.stringMatching(/archive-ads buildRunId/),
    })
    expect(p.campaigns).toEqual([expect.objectContaining({ slot: 'hero:test cape', name: 'TESTWIA | IT | Exact | Category | Hero | test cape', keywords: 1, productTargets: 0, startBidCents: 30, placementsAtStart: 1 })])
    expect(p.effect).toMatch(/^Builds ONE Sponsored Products campaign of its own for "test cape"/)
    expect(p.effect).toMatch(/"test cape" keeps running where it runs now \("TESTWIA \| IT \| Broad \| Category" \(declining\)\): nothing is negated and no bid is lowered there/)
    expect(p.sharedWithOtherProducts).toEqual([{ term: 'test cape', existing: [{ campaignName: 'TESTWIB | IT | Exact | Category', campaignId: exactB.campaignId }] }])
    expect(p.nextSteps[1]).toMatch(/apply-ads-playbook op start, slots \["hero:test cape"\]/)
  })

  it('by rule: the default limits refuse it (maxCampaigns 0); inside the limits it may run', async () => {
    const p = (await call('apply-ads-playbook', hero(A.parent, 'test cape'))).preview as Row
    expect(judge(p)).toMatch(/it creates 1 campaign, more than the 0 this tool's limits let a build create by rule/)
    expect(judge(p, { maxCampaigns: 1, maxDailyBudgetCents: 1000, maxBidCents: 100 })).toBeNull()
    expect(judge(p, { maxCampaigns: 1, maxDailyBudgetCents: 50, maxBidCents: 100 })).toMatch(/daily budgets add up to/)
  })

  it('refused, and not queued: no term, an ASIN, a product not enrolled', async () => {
    expect((await call('apply-ads-playbook', { op: 'hero', market: 'IT', productId: A.parent })).error).toMatch(/A hero is for one term: name it/)
    expect((await call('apply-ads-playbook', hero(A.parent, 'B0RIVAL001'))).error).toMatch(/it is an ASIN: a hero holds one exact keyword/)
    await inside(() => db().adsPlaybook.update({ where: { id: B.rowId }, data: { enrolled: false } }))
    expect((await call('apply-ads-playbook', hero(B.parent, 'test cape'))).error).toMatch(/is not enrolled in its playbook in IT/)
    await inside(() => db().adsPlaybook.update({ where: { id: B.rowId }, data: { enrolled: true } }))
    expect(await inside(() => db().agentApproval.count())).toBe(0)
  })
})

describe('approved, a hero is built by the playbook\'s build; the term keeps running where it ran', () => {
  let approvalId = ''
  let applicationId = ''
  it('one campaign through the wizard\'s launch, born at the floor and off the allowlist, linked as hero:<term>', async () => {
    const before = await inside(() => db().adTarget.findMany({ where: { adGroupId: broadA.adGroupId }, select: { expressionValue: true, isNegative: true, bidCents: true, status: true } }))
    const asked = await ask('apply-ads-playbook', { ...hero(A.parent, 'test cape'), why: 'give the term its own campaign' })
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    approvalId = asked.approvalId!
    const done = await approve(approvalId) as Row
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { status: 'RUNNING', key: 'hero:test cape', applicationId: expect.any(String), changeSetId: approvalId } })
    applicationId = done.result.applicationId
    await finished(applicationId)

    expect(launches.bodies).toHaveLength(1)
    expect(launches.bodies[0].campaigns).toEqual([expect.objectContaining({
      id: 'hero:test cape', name: 'TESTWIA | IT | Exact | Category | Hero | test cape', kind: 'keyword',
      keywords: [{ text: 'test cape', matchType: 'EXACT', bidEur: 0.3 }],
    })])
    expect(launches.options[0]).toMatchObject({ allowlistAtBirth: false, bornSuppressed: { floorCents: 2 }, deferPlacements: true, changeSetId: approvalId })
    const run = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))
    expect(run).toMatchObject({ status: 'APPLIED', playbookId: A.rowId })
    expect((run.options as Row).slots).toEqual(['hero:test cape'])
    const link = await inside(() => db().adsPlaybookLink.findFirstOrThrow({ where: { playbookId: A.rowId, kind: 'slot', key: 'hero:test cape' } }))
    expect(link).toMatchObject({ origin: 'built', refId: run.createdCampaignIds[0], adGroupId: expect.any(String) })

    // Rule 2: nothing moved where the term runs — no negative, no lower bid, no pause.
    expect(await inside(() => db().adTarget.findMany({ where: { adGroupId: broadA.adGroupId }, select: { expressionValue: true, isNegative: true, bidCents: true, status: true } }))).toEqual(before)
    // Rule 3: B's own "test cape" is untouched.
    expect(await inside(() => db().adTarget.findMany({ where: { adGroupId: exactB.adGroupId }, select: { expressionValue: true, isNegative: true, bidCents: true } }))).toEqual([{ expressionValue: 'test cape', isNegative: false, bidCents: 60 }])
  })

  it('START is the playbook\'s own (op start, slots ["hero:<term>"]): the hero alone; restore-campaign refuses it', async () => {
    const heroId = (await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))).createdCampaignIds[0]
    // As the wizard's launch leaves it (the stand-in does not): at the 2¢ floor, flagged by the person who asked.
    await inside(() => db().campaign.update({ where: { id: heroId }, data: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'user:u-asker' } }))
    const start = await call('apply-ads-playbook', { op: 'start', market: 'IT', productId: A.parent, slots: ['hero:test cape'] })
    expect(start.ok).toBe(true)
    expect((start.preview as Row).campaigns.map((c: Row) => [c.slot, c.campaignId, c.allowlist])).toEqual([['hero:test cape', heroId, 'on']])
    expect(start.preview).toMatchObject({ op: 'start', stepUp: expect.any(Object) })
    expect((await call('restore-campaign', { campaignId: heroId })).error).toMatch(/was built by an ads playbook: its bids go back only with apply-ads-playbook op start/)
  })

  it('one hero per term: a second is refused; the view names the term\'s own campaign and proposes no other', async () => {
    expect((await call('apply-ads-playbook', hero(A.parent, 'Test  Cape'))).error).toMatch(/it has its own campaign already \(one hero per term per product per market\)/)
    const cape = entry(await winners(A.parent), 'test cape')
    expect(cape).toMatchObject({ slot: 'broad-category', nextStep: 'none', heroOf: { key: 'hero:test cape', campaignName: 'TESTWIA | IT | Exact | Category | Hero | test cape' } })
    expect(cape.ladder[2]).toMatchObject({ step: 'ownCampaign', open: false, why: expect.stringMatching(/it has its own campaign already/) })
    // B may still have a campaign of its own for the same term (rule 3: one product never blocks another).
    expect((await call('apply-ads-playbook', hero(B.parent, 'test cape'))).ok).toBe(true)
  })

  it('undo: archive-ads of what the hero\'s build made (buildRunId), a new request a person approves', async () => {
    expect(await inside(() => undoRequestFor({ approvalId }))).toMatchObject({ request: { tool: 'archive-ads', args: { buildRunId: applicationId, why: 'undo of a playbook hero: archived for good' } } })
    const archive = await call('archive-ads', { buildRunId: applicationId })
    expect(archive.ok).toBe(true)
    expect((archive.preview as Row).totals).toMatchObject({ changing: 1 })
  })
})
