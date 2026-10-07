/**
 * ADS AUTONOMY W4-11 — Claude's existing ad tools on Sponsored Brands and Sponsored Display campaigns, run for real
 * through the door, the approval gate and the change-plan path (PGlite, production schema; the job queue a stub; the ads
 * write gate the real one, sandbox unless a test goes live).
 *
 *   set-campaign-budget, set-target-bid, bulk-ad-bid-change, add-negative-targets, retire-negatives, pause-ads, enable-ads
 * accept an SB/SD campaign for the changes Nexus sends to their own endpoints (a campaign's daily budget and on/off, a
 * keyword's / target's bid and on/off, adding and retiring an SB negative keyword or SD negative product target in an ad
 * group), with the same contract as for Sponsored Products: the same preview, limits, rule, warnings and code rules (no
 * code for bids, budgets and negatives; retire-negatives keeps its own code). Approved, each write is queued as the
 * approver on the approval's change set and marked for the SB/SD route (`sbSd` on the queue row). Everything else stays
 * refused by name: archive, ad groups, placements, SB product negatives, SD keywords, an SB lifetime budget, Amazon DSP.
 * Fake ids, names and amounts only.
 */
import { randomUUID } from 'node:crypto'
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
import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { queuePlan, runPlan } from '../change-plan.service.js'
import { __stepUpTest } from '../../../lib/auth/step-up.js'
import { generateSecret } from 'otplib'

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
const withCode = (approvalId: string) => inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { decisionVia: 'nexus-step-up' } }))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
/** The queue rows an approval wrote (its change set), with the SB/SD mark and what they change. */
async function queuedBy(approvalId: string) {
  const logs = await sql<{ outboundQueueId: string | null }>(`SELECT "outboundQueueId" FROM "AdvertisingActionLog" WHERE "executionId" = $1 AND "outboundQueueId" IS NOT NULL`, [approvalId])
  const rows = await inside(() => database.client.outboundSyncQueue.findMany({ where: { id: { in: logs.map((l) => l.outboundQueueId!) } } }))
  return rows.map((r) => {
    const p = r.payload as Row
    return { entityId: p.entityId, actor: p.actor, sbSd: p.sbSd === true, fields: (p.fieldChanges as Row[]).map((c) => `${c.field}=${c.newValue}`) }
  }).sort((a, b) => (a.entityId < b.entityId ? -1 : 1))
}

async function realPerson(label: string) {
  const client = database.client
  const secret = generateSecret()
  const role = await client.role.create({ data: { key: `W411_${randomUUID().slice(0, 8)}`, name: label, description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const user = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label, twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })
  await client.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: user.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return { id: user.id, secret, principal: { kind: 'user', userId: user.id, label, via: 'app', workspace: business, permissions: { isOwner: false, permissions: EVERYTHING } } as UserPrincipal }
}

/**
 * Beside the fixture (c-sb: SB, IT, keyword t-sb at 40¢): an SB campaign with a product target, an SB negative keyword and
 * a cost type; an SD campaign (cpc) with a product target, an audience target and an SD negative product target; an SB
 * campaign with a lifetime budget; an Amazon DSP campaign.
 */
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await seedAdsFixture(db)
    // SB and SD take Amazon's ids as numbers (SB 3.0 / SD 3.0): the fixture's SB campaign gets numeric ones, as Amazon's are.
    await db.campaign.update({ where: { id: 'c-sb' }, data: { costType: 'CPC', externalCampaignId: '100000000101', budgetJson: { budgetType: 'DAILY' } } })
    await db.adGroup.update({ where: { id: 'g-c-sb' }, data: { externalAdGroupId: '200000000101' } })
    let next = 100000000200
    const campaign = (id: string, name: string, type: string, adProduct: string, extra: Record<string, unknown> = {}) => db.campaign.create({
      data: { id, name, type, adProduct, marketplace: 'IT', externalCampaignId: String(next++), dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, costType: 'cpc', ...extra } as never,
    })
    await campaign('c-sd', 'Test display', 'SD', 'SPONSORED_DISPLAY')
    await campaign('c-sb-life', 'Test brands lifetime', 'SB', 'SPONSORED_BRANDS', { budgetJson: { budgetType: 'LIFETIME' } })
    await campaign('c-sb-unread', 'Test brands unread', 'SB', 'SPONSORED_BRANDS')
    await campaign('c-sd-vcpm', 'Test display vcpm', 'SD', 'SPONSORED_DISPLAY', { costType: 'vcpm' })
    await campaign('c-dsp', 'Test DSP', 'DSP', 'DSP')
    for (const [g, c] of [['g-c-sd', 'c-sd'], ['g-c-sb-life', 'c-sb-life'], ['g-c-dsp', 'c-dsp'], ['g-c-sd-vcpm', 'c-sd-vcpm']]) {
      await db.adGroup.create({ data: { id: g, campaignId: c, name: `group ${g}`, externalAdGroupId: String(next++) } })
    }
    const target = (id: string, adGroupId: string, kind: string, text: string, bidCents: number, extra: Record<string, unknown> = {}) => db.adTarget.create({
      data: { id, adGroupId, kind, expressionType: kind === 'KEYWORD' ? 'EXACT' : 'ASIN', expressionValue: text, bidCents, externalTargetId: String(next++), ...extra },
    })
    await target('t-sb-pt', 'g-c-sb', 'PRODUCT', 'B0TESTSB01', 50)
    await target('t-sb-aud', 'g-c-sb', 'AUDIENCE', 'views', 50)
    await target('t-sd-pt', 'g-c-sd', 'PRODUCT', 'B0TESTSD01', 30)
    await target('t-sd-aud', 'g-c-sd', 'AUDIENCE', 'views', 30)
    await target('t-dsp', 'g-c-dsp', 'PRODUCT', 'B0TESTDS01', 30)
    await target('t-sd-vcpm', 'g-c-sd-vcpm', 'AUDIENCE', 'views', 300)
    await target('n-sb2', 'g-c-sb', 'KEYWORD', 'cheap brand two', 0, { isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_EXACT' })
    await target('n-sb', 'g-c-sb', 'KEYWORD', 'cheap brand', 0, { isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_EXACT' })
    await target('n-sd', 'g-c-sd', 'PRODUCT', 'B0TESTNEG1', 0, { isNegative: true, negativeLevel: 'AD_GROUP' })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('set-campaign-budget', () => {
  it('previews an SB and an SD budget as it does an SP one; approved, each is queued as the approver, marked for its own endpoint', async () => {
    for (const [id, name] of [['c-sb', 'Italy brands'], ['c-sd', 'Test display']]) {
      const r = await preview('set-campaign-budget', { campaignId: id, dailyBudgetCents: 2500 })
      expect(r.ok, r.error).toBe(true)
      expect(r.preview).toMatchObject({ action: 'set-campaign-budget', currentBudgetCents: 2000, proposedBudgetCents: 2500, reach: { reach: 'sandbox' }, effect: `Sets the daily budget of ${name} from EUR 20.00 to EUR 25.00.` })
      // Rule A (Owner 10-07): a budget is a day-to-day raise — a normal approval, no code, as for Sponsored Products.
      expect(r.preview.stepUp).toBeUndefined()
    }
    const asked = await ask('set-campaign-budget', { campaigns: [{ campaignId: 'c-sb', dailyBudgetCents: 2600 }, { campaignId: 'c-sd', dailyBudgetCents: 1800 }] })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { changed: 2 } })
    expect(await queuedBy(asked.approvalId!)).toEqual([
      { entityId: 'c-sb', actor: 'user:u-approver', sbSd: true, fields: ['dailyBudget=26'] },
      { entityId: 'c-sd', actor: 'user:u-approver', sbSd: true, fields: ['dailyBudget=18'] },
    ])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-campaign-budget', args: { campaigns: [{ campaignId: 'c-sb', dailyBudgetCents: 2000 }, { campaignId: 'c-sd', dailyBudgetCents: 2000 }] } } })
  })

  it('refuses an SB lifetime budget, one whose period Nexus has not read, and an Amazon DSP campaign, by name; not queued', async () => {
    expect((await preview('set-campaign-budget', { campaignId: 'c-sb-life', dailyBudgetCents: 2500 })).error).toMatch(/^Test brands lifetime is a Sponsored Brands campaign with a lifetime budget at Amazon/)
    expect((await preview('set-campaign-budget', { campaignId: 'c-sb-unread', dailyBudgetCents: 2500 })).error).toMatch(/^Test brands unread is a Sponsored Brands campaign, and Nexus has not read from Amazon whether its budget is daily or for the campaign's lifetime/)
    expect((await preview('set-campaign-budget', { campaignId: 'c-dsp', dailyBudgetCents: 2500 })).error).toMatch(/^Test DSP is not a Sponsored Products campaign \(it is Amazon DSP\)/)
  })

  it("live: Amazon's SD budget range is the one judged; placements stay Sponsored Products only", async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview('set-campaign-budget', { campaignId: 'c-sd', dailyBudgetCents: 5_000_100 })).error).toMatch(/above Amazon's maximum of €50,000\.00 in IT/)
    const ok = await preview('set-campaign-budget', { campaignId: 'c-sd', dailyBudgetCents: 1900 })
    expect(ok.preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' } })
    vi.unstubAllEnvs()
    expect((await preview('set-placement-multipliers', { campaignId: 'c-sb', topOfSearchPct: 20 })).error).toMatch(/not a Sponsored Products campaign \(it is Sponsored Brands\)/)
  })
})

describe('set-target-bid and bulk-ad-bid-change', () => {
  it('an SB keyword, an SB product target and SD targets take a bid; an SB audience target is refused by name', async () => {
    for (const id of ['t-sb', 't-sb-pt', 't-sd-pt', 't-sd-aud']) {
      const r = await preview('set-target-bid', { targetId: id, proposedBidCents: 60 })
      expect(r.ok, `${id}: ${r.error}`).toBe(true)
      expect(r.preview.stepUp).toBeUndefined()
    }
    expect((await preview('set-target-bid', { targetId: 't-sb-aud', proposedBidCents: 60 })).error).toMatch(/is a Sponsored Brands campaign\. .* — not that kind of target —/)
    expect((await preview('set-target-bid', { targetId: 't-dsp', proposedBidCents: 60 })).error).toMatch(/it is Amazon DSP/)
    // A vCPM campaign's bids are not changed: the ads strategy's bid limits and the floors are per click.
    expect((await preview('set-target-bid', { targetId: 't-sd-vcpm', proposedBidCents: 400 })).error).toMatch(/^Test display vcpm is a Sponsored Display campaign that pays per thousand viewable impressions \(vCPM\)/)
    expect((await preview('bulk-ad-bid-change', { bids: [{ targetId: 't-sd-vcpm', bidCents: 400 }] })).error).toMatch(/^Nothing would change: 1 its ad product/)
    // Its on/off is not a bid: it still pauses.
    expect((await preview('pause-ads', { targetIds: ['t-sd-vcpm'] })).ok).toBe(true)
  })

  it("live: an SB bid under Amazon's SB minimum (€0.15) is refused before it is queued; an SD CPC bid of €0.05 is not", async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview('set-target-bid', { targetId: 't-sb', proposedBidCents: 10 })).error).toMatch(/below Amazon's minimum of €0\.15 in IT/)
    expect((await preview('set-target-bid', { targetId: 't-sd-pt', proposedBidCents: 5 })).preview).toMatchObject({ reach: { reach: 'live' } })
  })

  it('approved, set-target-bid queues the SB bid as the approver, marked; undo asks set-target-bid for the old bid', async () => {
    const asked = await ask('set-target-bid', { targetId: 't-sb-pt', proposedBidCents: 55, why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await queuedBy(asked.approvalId!)).toEqual([{ entityId: 't-sb-pt', actor: 'user:u-approver', sbSd: true, fields: ['bid=55'] }])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-target-bid', args: { targetId: 't-sb-pt', proposedBidCents: 50 } } })
  })

  it('bulk: SB and SD bids change in one request; the SB audience target is left out by reason', async () => {
    const r = await preview('bulk-ad-bid-change', { bids: [{ targetId: 't-sb', bidCents: 45 }, { targetId: 't-sd-aud', bidCents: 35 }, { targetId: 't-sb-aud', bidCents: 60 }] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({ totals: { asked: 3, changing: 2, excluded: { notSponsoredProducts: 1 } } })
    expect(r.preview.excludedLines).toEqual([{ targetId: 't-sb-aud', why: expect.stringMatching(/^its ad product: Nexus changes Sponsored Products bids, and the bids of Sponsored Brands keywords and product targets and Sponsored Display targets in campaigns that pay per click, only$/) }])
    const asked = await ask('bulk-ad-bid-change', { bids: [{ targetId: 't-sb', bidCents: 45 }, { targetId: 't-sd-aud', bidCents: 35 }] })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { applied: 2 } })
    expect(await queuedBy(asked.approvalId!)).toEqual([
      { entityId: 't-sb', actor: 'user:u-approver', sbSd: true, fields: ['bid=45'] },
      { entityId: 't-sd-aud', actor: 'user:u-approver', sbSd: true, fields: ['bid=35'] },
    ])
  })
})

describe('pause-ads and enable-ads', () => {
  it('an SB campaign and an SD target pause and come back on; archive and an SB ad group are refused by name', async () => {
    const r = await preview('pause-ads', { campaignIds: ['c-sb'], targetIds: ['t-sd-pt'] })
    expect(r.ok, r.error).toBe(true)
    expect((await preview('archive-ads', { targetIds: ['t-sd-pt'] })).error).toMatch(/— not archiving a target —/)
    expect((await preview('pause-ads', { adGroupIds: ['g-c-sd'] })).error).toMatch(/ad group "group g-c-sd" .*it is Sponsored Display/)
    const asked = await ask('pause-ads', { campaignIds: ['c-sb'], targetIds: ['t-sd-pt'], why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { paused: 2 } })
    expect(await queuedBy(asked.approvalId!)).toEqual([
      { entityId: 'c-sb', actor: 'user:u-approver', sbSd: true, fields: ['status=PAUSED'] },
      { entityId: 't-sd-pt', actor: 'user:u-approver', sbSd: true, fields: ['status=PAUSED'] },
    ])
    // Claude's own pause comes back on with enable-ads (its undo), on the same route.
    const back = await ask('enable-ads', { campaignIds: ['c-sb'], targetIds: ['t-sd-pt'], why: 'test' })
    expect(await approve(back.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { enabled: 2 } })
    expect((await queuedBy(back.approvalId!)).map((q) => [q.entityId, q.sbSd, q.fields])).toEqual([['c-sb', true, ['status=ENABLED']], ['t-sd-pt', true, ['status=ENABLED']]])
  })
})

describe('add-negative-targets and retire-negatives', () => {
  it('an SB negative keyword and an SD negative product target are added (no code); an SB ASIN, an SD keyword and an SB campaign negative are refused by name', async () => {
    const sb = await preview('add-negative-targets', { adGroupIds: ['g-c-sb'], keywords: [{ text: 'free brand' }] })
    expect(sb.ok, sb.error).toBe(true)
    expect(sb.preview).toMatchObject({ action: 'add-negative-targets', raises: [], totals: { negatives: 1, keywords: 1 } })
    expect(sb.preview.stepUp).toBeUndefined()
    expect((await preview('add-negative-targets', { adGroupIds: ['g-c-sd'], asins: ['B0TESTOTH1'] })).ok).toBe(true)
    expect((await preview('add-negative-targets', { adGroupIds: ['g-c-sb'], asins: ['B0TESTOTH1'] })).error).toMatch(/not a negative other than a keyword in an ad group/)
    expect((await preview('add-negative-targets', { adGroupIds: ['g-c-sd'], keywords: [{ text: 'free brand' }] })).error).toMatch(/not a negative other than a product target \(an ASIN\) in an ad group/)
    expect((await preview('add-negative-targets', { scope: 'CAMPAIGN', campaignIds: ['c-sb'], keywords: [{ text: 'free brand' }] })).error).toMatch(/not a negative other than a keyword in an ad group/)
  })

  it('approved, both are made through the one negative write service as the approver, on the change set', async () => {
    const asked = await ask('add-negative-targets', { negatives: [{ adGroupId: 'g-c-sb', text: 'free brand' }, { adGroupId: 'g-c-sd', asin: 'B0TESTOTH1' }], why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { added: 2 } })
    const made = await sql<{ adGroupId: string; kind: string; expressionValue: string; negativeLevel: string }>(
      `SELECT "adGroupId", kind, "expressionValue", "negativeLevel" FROM "AdTarget" WHERE "isNegative" AND "expressionValue" IN ('free brand', 'B0TESTOTH1') ORDER BY "adGroupId"`)
    expect(made).toEqual([
      { adGroupId: 'g-c-sb', kind: 'KEYWORD', expressionValue: 'free brand', negativeLevel: 'AD_GROUP' },
      { adGroupId: 'g-c-sd', kind: 'PRODUCT', expressionValue: 'B0TESTOTH1', negativeLevel: 'AD_GROUP' },
    ])
    const logs = await sql<{ userId: string; executionId: string }>(`SELECT "userId", "executionId" FROM "AdvertisingActionLog" WHERE "executionId" = $1`, [asked.approvalId])
    expect(logs.length).toBe(2)
  })

  it('retire-negatives lifts an SB negative keyword (for good: said plainly) and an SD negative product target (a day-to-day change: no authenticator code, as for SP — code rule A), marked', async () => {
    const r = await preview('retire-negatives', { negativeIds: ['n-sb', 'n-sd'] })
    expect(r.ok, r.error).toBe(true)
    // Code rule A (#479): lifting a negative is day-to-day — listed in raises, no authenticator code.
    expect(r.preview).not.toHaveProperty('stepUp')
    expect(r.preview).toMatchObject({
      totals: { retiring: 2, atAmazon: 2 },
      irreversible: ['negative exact "cheap brand" · ad group "group c-sb" (campaign "Italy brands")'],
      irreversibleNote: 'Amazon does not let a Sponsored Brands negative keyword archived in a campaign be added to that campaign again: these retires cannot be undone.',
      effect: expect.stringMatching(/To block that search again, a new negative is added\. For good: negative exact "cheap brand" .* — Amazon does not let a Sponsored Brands negative keyword archived in a campaign be added to that campaign again, so that search cannot be blocked there again, not even by an undo\./),
      warning: expect.stringMatching(/blocking the search again adds a new one; Amazon does not let a Sponsored Brands negative keyword archived in a campaign be added to that campaign again, so that block cannot be made again there\.$/),
      undoNote: expect.stringMatching(/The Sponsored Brands negative keywords are not added again/),
    })
    const asked = await ask('retire-negatives', { negativeIds: ['n-sb', 'n-sd'], why: 'test' })
    await withCode(asked.approvalId!)
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { retired: 2 } })
    expect((await queuedBy(asked.approvalId!)).map((q) => [q.entityId, q.sbSd, q.fields])).toEqual([['n-sb', true, ['status=ARCHIVED']], ['n-sd', true, ['status=ARCHIVED']]])
    // Its undo adds the SD one again and says honestly that the SB keyword cannot come back.
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: 'add-negative-targets', args: { negatives: [{ adGroupId: 'g-c-sd', asin: 'B0TESTNEG1' }], why: expect.stringMatching(/not the Sponsored Brands negative keyword: Amazon does not let one archived in a campaign be added there again/) } },
    })
    // …and add-negative-targets refuses it by name rather than send it for Amazon to refuse.
    expect((await preview('add-negative-targets', { adGroupIds: ['g-c-sb'], keywords: [{ text: 'cheap brand' }] })).error).toMatch(/negative exact "cheap brand" was retired in campaign "Italy brands" before: Amazon does not let a Sponsored Brands negative keyword archived in a campaign be added to that campaign again/)
  })

  it('a retire of SB negative keywords only: its undo is refused, honestly', async () => {
    const asked = await ask('retire-negatives', { negativeIds: ['n-sb2'], why: 'test' })
    await withCode(asked.approvalId!)
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { retired: 1 } })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toEqual({
      error: 'Amazon does not let a Sponsored Brands negative keyword archived in a campaign be added to that campaign again: the Sponsored Brands negative keyword this retire lifted cannot be added again. Nothing was queued.',
    })
  })
})

describe('undo-ad-change of an SB/SD request (its writes go back on the same route)', () => {
  it('the undo of add-negative-targets retires the SB negative keyword it added: live, the gate is told what it is; in sandbox it runs', async () => {
    const asked = await ask('add-negative-targets', { adGroupIds: ['g-c-sb'], keywords: [{ text: 'undo brand' }], why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { added: 1 } })
    // As if Amazon had answered with its id (sandbox gives none): the retire then goes to Amazon, not to Nexus only.
    await inside(() => database.client.adTarget.updateMany({ where: { adGroupId: 'g-c-sb', expressionValue: 'undo brand' }, data: { externalTargetId: '400000000777' } }))
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'undo-ad-change', args: { changeSetId: asked.approvalId } } })
    const args = (undo as { request: { args: Record<string, unknown> } }).request.args
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const live = await preview('undo-ad-change', args)
    expect(live.ok, live.error).toBe(true)
    expect(live.preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' }, negatives: [expect.objectContaining({ keywordText: 'undo brand' })] })
    vi.unstubAllEnvs()
    const back = await ask('undo-ad-change', args)
    expect(await approve(back.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { negatives: { retired: 1, refused: 0, failed: 0 } } })
    const [row] = await sql<{ id: string; status: string }>(`SELECT id, status FROM "AdTarget" WHERE "adGroupId" = 'g-c-sb' AND "expressionValue" = 'undo brand'`)
    expect(row.status).toBe('ARCHIVED')
    const [q] = await sql<{ payload: Row }>(`SELECT payload FROM "OutboundSyncQueue" WHERE payload->>'entityId' = $1`, [row.id])
    expect(q.payload).toMatchObject({ entityType: 'AD_TARGET', sbSd: true, fieldChanges: [{ field: 'status', newValue: 'ARCHIVED' }] })
  })

  it('the undo of an SB keyword bid puts it back on the same route: live preview reaches Amazon, sandbox reverses it', async () => {
    const [{ bidCents: was }] = await sql<{ bidCents: number }>(`SELECT "bidCents" FROM "AdTarget" WHERE id = 't-sb'`)
    const asked = await ask('set-target-bid', { targetId: 't-sb', proposedBidCents: 70, why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const live = await preview('undo-ad-change', { changeSetId: asked.approvalId! })
    expect(live.ok, live.error).toBe(true)
    expect(live.preview).toMatchObject({ reach: { reach: 'live' } })
    vi.unstubAllEnvs()
    const back = await ask('undo-ad-change', { changeSetId: asked.approvalId!, why: 'test' })
    expect(await approve(back.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { reversed: 1, failed: 0 } })
    expect(await queuedBy(back.approvalId!)).toEqual([{ entityId: 't-sb', actor: 'user:u-approver', sbSd: true, fields: [`bid=${was}`] }])
  })

  it('🔴 a write the mark did not cover is not given the SB/SD route by the undo: the gate refuses it with the true sentence', async () => {
    const asked = await ask('set-campaign-budget', { campaignId: 'c-sd', dailyBudgetCents: 2100, why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    // As if some other path had queued it: its queue row loses the mark.
    const [log] = await sql<{ outboundQueueId: string }>(`SELECT "outboundQueueId" FROM "AdvertisingActionLog" WHERE "executionId" = $1 AND "outboundQueueId" IS NOT NULL`, [asked.approvalId])
    await sql(`UPDATE "OutboundSyncQueue" SET payload = payload - 'sbSd' WHERE id = $1`, [log.outboundQueueId])
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview('undo-ad-change', { changeSetId: asked.approvalId! })).error).toMatch(/Test display is not a Sponsored Products campaign \(it is Sponsored Display\)\. Nexus makes this change for Sponsored Products campaigns only/)
  })
})

describe('the plan path (submit-change-plan)', () => {
  it('an SB budget and an SB negative keyword in one plan: a normal approval, no code; every step runs', async () => {
    const boss = await inside(() => realPerson('Test SBSD Plan Approver'))
    const queued = await inside(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
      return queuePlan({
        title: 'Test SB plan',
        steps: [
          { tool: 'set-campaign-budget', args: { campaignId: 'c-sb', dailyBudgetCents: 2700 } },
          { tool: 'add-negative-targets', args: { adGroupIds: ['g-c-sb'], keywords: [{ text: 'plan brand socks' }] } },
        ],
      }, claude, run.id)
    })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    expect((queued.preview as Row | undefined)?.stepUp).toBeUndefined()
    const planId = queued.approvalId!
    expect(await inside(() => decideFleetApproval({ id: planId, decision: 'approve', actor: boss.principal }))).toMatchObject({ ok: true, status: 'scheduled' })
    await inside(() => database.client.agentApproval.update({ where: { id: planId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    __stepUpTest.reset()
    expect(await inside(() => commitScheduledApproval(planId))).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(planId))).toMatchObject({ finished: true, counts: { done: 2 } })
    expect((await sql(`SELECT id FROM "AdTarget" WHERE "adGroupId" = 'g-c-sb' AND "expressionValue" = 'plan brand socks'`)).length).toBe(1)
  })
})
