/**
 * P2b (2026-10-20) — Claude manages an EXISTING Sponsored Display campaign through its ad tools, run for real through the
 * door, the approval gate and undo (PGlite, production schema; the job queue a stub; the ads write gate the real one,
 * sandbox unless a test goes live). The template is ads-sbsd-tools.vitest.test.ts.
 *
 *   set-campaign-settings  an SD campaign's name, end date, portfolio, and start date (only before it starts, today or
 *                          later in its market); its cost type and tactic, and a bidding strategy, refused in words
 *   set-ad-group           an SD ad group's name and default bid (op edit); its bid optimization and creative type, op
 *                          stop/start and a vCPM default bid refused
 *   pause/enable/archive   an SD campaign, ad group, target and product ad; archive is PERMANENT; an SD negative is
 *                          retire-negatives'
 *   suppress/restore       the no-pause stop of an SD campaign that pays per click (the floor in words); vCPM refused
 *
 * Each runs only as an approved request, as the approver, on the approval's change set, marked for SD's own endpoint
 * (`sbSd` on the queue row); undo asks the tool again with the old values. Made-up ids, names and ASINs (B0FX…).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
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
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')

type Row = Record<string, any>
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw as Row
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
/** The queue rows an approval wrote (its change set), with the SD mark and what they change. */
async function queuedBy(approvalId: string) {
  const logs = await sql<{ outboundQueueId: string | null }>(`SELECT "outboundQueueId" FROM "AdvertisingActionLog" WHERE "executionId" = $1 AND "outboundQueueId" IS NOT NULL`, [approvalId])
  const rows = await inside(() => database.client.outboundSyncQueue.findMany({ where: { id: { in: logs.map((l) => l.outboundQueueId!) } } }))
  return rows.map((r) => {
    const p = r.payload as Row
    return { entityId: p.entityId, actor: p.actor, sbSd: p.sbSd === true, fields: (p.fieldChanges as Row[]).map((c) => `${c.field}=${c.newValue}`).sort() }
  }).sort((a, b) => (a.entityId < b.entityId ? -1 : 1))
}
const day = (d: string) => new Date(`${d}T00:00:00.000Z`)

/**
 * Beside the fixture: SD campaigns (cpc unless named vcpm, numeric Amazon ids as Amazon's are) — sd-c (started) with an
 * ad group, two targets, a negative and a product ad; sd-f (starts 2099-03-10, ends 2099-06-30); sd-v (vcpm); sd-s (the
 * stop); sd-x (archived whole); and a portfolio Amazon holds in IT.
 */
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await seedAdsFixture(db)
    let next = 100000000700
    const campaign = (id: string, extra: Record<string, unknown> = {}) => db.campaign.create({
      data: { id, name: `Test ${id}`, type: 'SD', adProduct: 'SPONSORED_DISPLAY', marketplace: 'IT', externalCampaignId: String(next++), dailyBudget: '20.00', startDate: day('2026-01-01'), liveBidWritesEnabled: true, costType: 'cpc', ...extra } as never,
    })
    await campaign('sd-c')
    await campaign('sd-f', { startDate: day('2099-03-10'), endDate: day('2099-06-30') })
    await campaign('sd-v', { costType: 'vcpm' })
    await campaign('sd-s')
    await campaign('sd-x')
    for (const [g, c, bid] of [['sd-g', 'sd-c', 40], ['sd-vg', 'sd-v', 300], ['sd-sg', 'sd-s', 60], ['sd-xg', 'sd-x', 40]] as const) {
      await db.adGroup.create({ data: { id: g, campaignId: c, name: `group ${g}`, externalAdGroupId: String(next++), defaultBidCents: bid } })
    }
    const target = (id: string, adGroupId: string, kind: string, text: string, bidCents: number, extra: Record<string, unknown> = {}) => db.adTarget.create({
      data: { id, adGroupId, kind, expressionType: kind === 'AUDIENCE' ? 'VIEWS' : 'ASIN', expressionValue: text, bidCents, externalTargetId: String(next++), ...extra },
    })
    await target('sd-t1', 'sd-g', 'PRODUCT', 'B0FXTESTA1', 40)
    await target('sd-n', 'sd-g', 'PRODUCT', 'B0FXTESTN1', 0, { isNegative: true, negativeLevel: 'AD_GROUP' })
    await target('sd-st1', 'sd-sg', 'PRODUCT', 'B0FXTESTS1', 45)
    await target('sd-st2', 'sd-sg', 'AUDIENCE', 'views', 30)
    await target('sd-xt', 'sd-xg', 'PRODUCT', 'B0FXTESTX1', 40)
    await db.adProductAd.create({ data: { id: 'sd-a', adGroupId: 'sd-g', sku: 'TEST-SD-SKU-1', asin: 'B0FXTESTP1', externalAdId: String(next++) } })
    await db.adProductAd.create({ data: { id: 'sd-xa', adGroupId: 'sd-xg', sku: 'TEST-SD-SKU-2', asin: 'B0FXTESTP2', externalAdId: String(next++) } })
    await db.amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: '600000000701', name: 'Test SD portfolio', state: 'ENABLED' } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('set-campaign-settings on a Sponsored Display campaign', () => {
  it('rename, end date and portfolio: from → to in the preview; approved, queued as the approver for SD\'s own endpoint; undo puts each back', async () => {
    const args = { campaignIds: ['sd-c'], name: 'Test display autumn', endDate: '2099-12-31', portfolioId: '600000000701' }
    const r = await preview('set-campaign-settings', args)
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      reach: { reach: 'sandbox' },
      changes: [{ campaignId: 'sd-c', changes: expect.arrayContaining([
        { label: 'Name', from: '"Test sd-c"', to: '"Test display autumn"' },
        { label: 'End date', from: 'no end date', to: '2099-12-31' },
        { label: 'Portfolio', from: 'no portfolio', to: 'portfolio "Test SD portfolio"' },
      ]) }],
      effect: expect.stringMatching(/^Changes the settings of 1 Sponsored Display campaign \(/),
    })
    const asked = await ask('set-campaign-settings', { ...args, why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { changed: 1 } })
    expect(await queuedBy(asked.approvalId!)).toEqual([
      { entityId: 'sd-c', actor: 'user:u-approver', sbSd: true, fields: ['endDate=2099-12-31T00:00:00.000Z', 'name=Test display autumn', 'portfolioId=600000000701'] },
    ])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: 'set-campaign-settings', args: { campaigns: [{ campaignId: 'sd-c', name: 'Test sd-c', endDate: null, portfolioId: null }] } },
    })
  })

  it('the start date: only before it starts, today or later; earlier is a raise (it spends sooner), later a cut; undo puts it back', async () => {
    const earlier = await preview('set-campaign-settings', { campaignIds: ['sd-f'], startDate: '2099-03-01' })
    expect(earlier.ok, earlier.error).toBe(true)
    expect(earlier.preview.raises).toEqual([{ campaignId: 'sd-f', label: 'campaign "Test sd-f"', why: 'its start date moves earlier, from 2099-03-10 to 2099-03-01: it spends sooner' }])
    expect(earlier.preview.effect).toMatch(/start date 2099-03-10 → 2099-03-01/)
    expect((await preview('set-campaign-settings', { campaignIds: ['sd-f'], startDate: '2099-04-01' })).preview.raises).toEqual([])
    const later = await ask('set-campaign-settings', { campaignIds: ['sd-f'], startDate: '2099-04-01', why: 'test' })
    expect(await approve(later.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { changed: 1 } })
    expect(await queuedBy(later.approvalId!)).toEqual([{ entityId: 'sd-f', actor: 'user:u-approver', sbSd: true, fields: ['startDate=2099-04-01T00:00:00.000Z'] }])
    expect(await inside(() => undoRequestFor({ approvalId: later.approvalId! }))).toMatchObject({ request: { tool: 'set-campaign-settings', args: { campaigns: [{ campaignId: 'sd-f', startDate: '2099-03-10' }] } } })
    // Started, in the past, after its end date, or a Sponsored Products campaign: refused, in words.
    expect((await preview('set-campaign-settings', { campaignIds: ['sd-c'], startDate: '2099-01-01' })).error).toMatch(/started on 2026-01-01: Amazon changes the start date of a campaign that has not started yet only/)
    expect((await preview('set-campaign-settings', { campaignIds: ['sd-f'], startDate: '2020-01-01' })).error).toMatch(/is in the past in IT \(today is \d{4}-\d{2}-\d{2}\): Amazon takes a start date of today or later/)
    expect((await preview('set-campaign-settings', { campaignIds: ['sd-f'], startDate: '2099-07-01' })).error).toMatch(/is after its end date 2099-06-30/)
    expect((await preview('set-campaign-settings', { campaignIds: ['c-it'], startDate: '2099-01-01' })).error).toMatch(/Nexus changes the start date of a Sponsored Display campaign only/)
  })

  it('what Amazon fixes at creation (cost type, tactic) and a bidding strategy are refused in words; a Sponsored Brands rename stays refused', async () => {
    expect((await preview('set-campaign-settings', { campaignIds: ['sd-c'], costType: 'vcpm' })).error).toMatch(/^Not queued: Amazon fixes how a Sponsored Display campaign pays \(costType: cpc or vcpm\) and its tactic when it is made: its update changes only the name, state, budget, start date and end date \(and its portfolio\)/)
    expect((await preview('set-campaign-settings', { campaigns: [{ campaignId: 'sd-c', tactic: 'T00030' }] })).error).toMatch(/Amazon fixes how a Sponsored Display campaign pays/)
    expect((await preview('set-campaign-settings', { campaignIds: ['sd-c'], biddingStrategy: 'manual' })).error).toMatch(/a Sponsored Display campaign has no bidding strategy/)
    expect((await preview('set-campaign-settings', { campaignIds: ['c-sb'], name: 'Test brands renamed' })).error).toMatch(/Italy brands is not a Sponsored Products campaign \(it is Sponsored Brands\)\. Nexus makes this change for Sponsored Products campaigns only/)
    // The one name rule (P1): a dash Amazon refuses.
    expect((await preview('set-campaign-settings', { campaignIds: ['sd-c'], name: 'Test — display' })).error).toMatch(/contains "—", which Amazon refuses in names/)
  })
})

describe('set-ad-group on a Sponsored Display ad group', () => {
  it('op edit: name and default bid from → to; approved, queued for SD\'s endpoint; undo asks for the old ones', async () => {
    const r = await preview('set-ad-group', { adGroupId: 'sd-g', defaultBidCents: 35, name: 'group autumn' })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({ changes: [{ field: 'defaultBid', from: 'EUR 0.40', to: 'EUR 0.35' }, { field: 'name', from: '"group sd-g"', to: '"group autumn"' }], raises: [] })
    const asked = await ask('set-ad-group', { adGroupId: 'sd-g', defaultBidCents: 35, name: 'group autumn', why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await queuedBy(asked.approvalId!)).toEqual([{ entityId: 'sd-g', actor: 'user:u-approver', sbSd: true, fields: ['defaultBid=35', 'name=group autumn'] }])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-ad-group', args: { adGroupId: 'sd-g', op: 'edit', defaultBidCents: 40, name: 'group sd-g' } } })
  })

  it('refused in words: bid optimization and creative type (fixed at creation), op stop, a vCPM default bid, a dash Amazon refuses', async () => {
    expect((await preview('set-ad-group', { adGroupId: 'sd-g', bidOptimization: 'clicks' })).error).toMatch(/^Not queued: Amazon fixes a Sponsored Display ad group's bid optimization and creative type \(image or video\) when it is made: its update changes only the name, the default bid and the state/)
    expect((await preview('set-ad-group', { adGroupId: 'sd-g', creativeType: 'VIDEO' })).error).toMatch(/Amazon fixes a Sponsored Display ad group's bid optimization and creative type/)
    expect((await preview('set-ad-group', { adGroupId: 'sd-g', op: 'stop' })).error).toMatch(/is in a Sponsored Display campaign: op stop .* suppress-campaign/)
    expect((await preview('set-ad-group', { adGroupId: 'sd-vg', defaultBidCents: 400 })).error).toMatch(/Test sd-v is a Sponsored Display campaign that pays per thousand viewable impressions \(vCPM\)/)
    expect((await preview('set-ad-group', { adGroupId: 'sd-vg', name: 'vcpm group renamed' })).ok).toBe(true)
    expect((await preview('set-ad-group', { adGroupId: 'sd-g', name: 'group — dash' })).error).toMatch(/contains "—", which Amazon refuses in names/)
  })
})

describe('pause-ads, enable-ads and archive-ads at every Sponsored Display level', () => {
  it('an SD ad group and product ad pause and come back on (enable-ads, the pause\'s undo), each on SD\'s endpoint', async () => {
    const args = { adGroupIds: ['sd-g'], productAds: [{ adGroupId: 'sd-g', product: 'TEST-SD-SKU-1' }] }
    expect((await preview('pause-ads', args)).ok).toBe(true)
    const paused = await ask('pause-ads', { ...args, why: 'test' })
    expect(await approve(paused.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { paused: 2 } })
    expect(await queuedBy(paused.approvalId!)).toEqual([
      { entityId: 'sd-a', actor: 'user:u-approver', sbSd: true, fields: ['status=PAUSED'] },
      { entityId: 'sd-g', actor: 'user:u-approver', sbSd: true, fields: ['status=PAUSED'] },
    ])
    const undo = await inside(() => undoRequestFor({ approvalId: paused.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'enable-ads', args: { adGroupIds: ['sd-g'], productAds: [{ adGroupId: 'sd-g', product: 'TEST-SD-SKU-1' }] } } })
    const back = await ask('enable-ads', { ...(undo as { request: { args: Row } }).request.args })
    expect(await approve(back.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { enabled: 2 } })
    expect((await queuedBy(back.approvalId!)).map((q) => [q.entityId, q.sbSd, q.fields])).toEqual([['sd-a', true, ['status=ENABLED']], ['sd-g', true, ['status=ENABLED']]])
  })

  it('archive: PERMANENT in the preview; approved, the campaign, ad group, target and product ad are queued as archived for SD', async () => {
    const args = { campaignIds: ['sd-x'], adGroupIds: ['sd-xg'], targetIds: ['sd-xt'], productAds: [{ adGroupId: 'sd-xg', product: 'TEST-SD-SKU-2' }] }
    const r = await preview('archive-ads', args)
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({ totals: { changing: 4 }, permanent: expect.stringMatching(/^PERMANENT: Amazon cannot switch an archived ad on again/) })
    expect(r.preview.effect).toMatch(/^Archives 4 ads at Amazon, for good/)
    const asked = await ask('archive-ads', { ...args, why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { archived: 4 } })
    expect((await queuedBy(asked.approvalId!)).map((q) => [q.entityId, q.sbSd, q.fields])).toEqual([
      ['sd-x', true, ['status=ARCHIVED']], ['sd-xa', true, ['status=ARCHIVED']], ['sd-xg', true, ['status=ARCHIVED']], ['sd-xt', true, ['status=ARCHIVED']],
    ])
  })

  it('an SD negative product target is retire-negatives\' (its own record and undo), never a status tool\'s', async () => {
    for (const tool of ['pause-ads', 'archive-ads']) {
      expect((await preview(tool, { targetIds: ['sd-n'] })).error).toMatch(/it is a negative product target: it keeps the ads off that product and serves no ad \(retire-negatives retires it\)/)
    }
  })
})

describe('suppress-campaign and restore-campaign on a Sponsored Display campaign', () => {
  it('a per-click campaign: the floor said in words; approved, its bids go to the floor on SD\'s endpoints and come back with restore-campaign', async () => {
    const r = await preview('suppress-campaign', { campaignId: 'sd-s' })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      moves: { targets: 2, adGroups: 1 }, stopBidCents: 2,
      floorMeans: 'Test sd-s is a Sponsored Display campaign that pays per click: its floor is a bid of EUR 0.02 a click (Amazon\'s lowest Sponsored Display click bid is EUR 0.02), so it stops winning auctions as a Sponsored Products campaign does; its ad group default bids and target bids go to Sponsored Display\'s own endpoints.',
    })
    const asked = await ask('suppress-campaign', { campaignId: 'sd-s', why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { moved: 3 } })
    expect(await queuedBy(asked.approvalId!)).toEqual([
      { entityId: 'sd-sg', actor: 'user:u-approver', sbSd: true, fields: ['defaultBid=2'] },
      { entityId: 'sd-st1', actor: 'user:u-approver', sbSd: true, fields: ['bid=2'] },
      { entityId: 'sd-st2', actor: 'user:u-approver', sbSd: true, fields: ['bid=2'] },
    ])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'restore-campaign', args: { campaignId: 'sd-s' } } })
    const restore = await preview('restore-campaign', { campaignId: 'sd-s' })
    expect(restore.ok, restore.error).toBe(true)
    expect(restore.preview).toMatchObject({ restores: { targets: 2, adGroups: 1 }, highestRestoredBidCents: 45 })
    const back = await ask('restore-campaign', { campaignId: 'sd-s', why: 'test' })
    expect(await approve(back.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { restored: 3 } })
    expect(await queuedBy(back.approvalId!)).toEqual([
      { entityId: 'sd-sg', actor: 'user:u-approver', sbSd: true, fields: ['defaultBid=60'] },
      { entityId: 'sd-st1', actor: 'user:u-approver', sbSd: true, fields: ['bid=45'] },
      { entityId: 'sd-st2', actor: 'user:u-approver', sbSd: true, fields: ['bid=30'] },
    ])
  })

  it('a vCPM campaign is refused: its lowest bid (€1.00 per thousand viewable impressions) still buys impressions', async () => {
    expect((await preview('suppress-campaign', { campaignId: 'sd-v' })).error).toBe(
      'Test sd-v is a Sponsored Display campaign that pays per thousand viewable impressions (vCPM). Its lowest bid at Amazon is EUR 1.00 per thousand viewable impressions, which still buys impressions: a low-bid stop does not stop it the way a 2-cent click bid does, and Nexus\'s stop bids and bid limits are per click. Nothing was queued; for a real stop pause it (pause-ads), and enable-ads switches it back on.',
    )
    expect((await preview('suppress-campaign', { campaignId: 'c-sb' })).error).toMatch(/Italy brands is not a Sponsored Products campaign \(it is Sponsored Brands\)/)
  })
})

describe('undo-ad-change of a Sponsored Display ad group write (its reversal goes back on the same route)', () => {
  it('a default bid Claude set: live, the preview reaches Amazon; in sandbox it runs and the reversal is queued for SD', async () => {
    const asked = await ask('set-ad-group', { adGroupId: 'sd-g', defaultBidCents: 30, why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const live = await preview('undo-ad-change', { changeSetId: asked.approvalId! })
    expect(live.ok, live.error).toBe(true)
    expect(live.preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' } })
    vi.unstubAllEnvs()
    const back = await ask('undo-ad-change', { changeSetId: asked.approvalId!, why: 'test' })
    expect(await approve(back.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { reversed: 1, failed: 0 } })
    expect(await queuedBy(back.approvalId!)).toEqual([{ entityId: 'sd-g', actor: 'user:u-approver', sbSd: true, fields: ['defaultBid=35'] }])
  })
})
