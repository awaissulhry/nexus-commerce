/**
 * ADS AUTONOMY W4-3 — set-campaign-settings, run for real through the door and the approval gate (PGlite, production
 * schema; the job queue a stub; the ads write gate the real one, sandbox unless a test goes live). Made-up names and ids.
 *
 * Proven: each setting (portfolio in and out, name, end date, bidding strategy) previews from → to and is written through
 * the screens' own write (updateCampaignWithSync) as the approver, changeSetId = the approval; many campaigns move in ONE
 * request; whatever can add spend is in `raises` and runs only with the approver's code; a person's approval passes the
 * live-write allowlist and a run by rule does not; a name the market already uses, another market's portfolio, a portfolio
 * made in Nexus only and a past end date are refused and not queued; undo puts each campaign back with its own values;
 * the default limits let nothing run alone.
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
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'
import { ruleFrom } from '../claude-trust.service.js'
import { settingMove } from './ads-campaign-settings.tools.js'
import { randomUUID } from 'node:crypto'
import { generateSecret, generateSync } from 'otplib'
import { __stepUpTest } from '../../../lib/auth/step-up.js'
import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { queuePlan, runPlan } from '../change-plan.service.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { claudeGateRule } from '../../mcp/mcp-tool-call.js'

const TOOL = 'set-campaign-settings'
const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')

type Row = Record<string, any>
const db = () => database.client as any
const preview = async (args: Record<string, unknown>) => (await inside(() => callTool(claude, TOOL, args))).raw as Row
async function ask(args: Record<string, unknown>) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(TOOL, args, claude, run.id, { forceAsk: true })
  })
}
/** Approve, as a person in Nexus (`via` nexus), with their code (nexus-step-up), or as the business's rule (auto). */
async function approve(approvalId: string, via: 'nexus' | 'nexus-step-up' | 'auto' = 'nexus') {
  if (via !== 'nexus') await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { decisionVia: via } }))
  return inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
}
const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool(TOOL)!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}
const campaignOf = (id: string) => inside(() => db().campaign.findUniqueOrThrow({ where: { id }, select: { name: true, portfolioId: true, endDate: true, biddingStrategy: true } })) as Promise<Row>
const inAYear = () => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)

async function campaign(id: string, extra: Record<string, unknown> = {}) {
  await db().campaign.create({ data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '12.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    // P-IT-TEST / P-UK-TEST are the fixture's connected profiles: a portfolio of theirs is in IT / UK.
    await db().amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'PF-CAP', name: 'Test capped', state: 'ENABLED', budgetAmount: '500.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'MONTHLY_RECURRING' } })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'PF-OPEN', name: 'Test open', state: 'ENABLED' } })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'P-UK-TEST', externalPortfolioId: 'PF-UK', name: 'Test UK', state: 'ENABLED' } })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'local-IT', externalPortfolioId: 'local-pf-local-IT-test-local', name: 'Test local', state: 'ENABLED' } })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'PF-ARCH', name: 'Test archived', state: 'ARCHIVED' } })
    for (const id of ['c-m1', 'c-m2', 'c-m3', 'c-n1', 'c-e1', 'c-b1', 'c-lim', 'c-ctl', 'c-u1', 'c-u2']) await campaign(id)
    await campaign('c-plan', { endDate: new Date(`${inAYear()}T00:00:00Z`) })
    // Caps as the other writers store them: a sync of a camelCase answer, the bulk sheet as typed, an unknown policy.
    await db().amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'PF-SYNC', name: 'Test synced', state: 'ENABLED', budgetAmount: '400.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'MONTHLYRECURRING' } })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'PF-BULK', name: 'Test bulk sheet', state: 'ENABLED', budgetAmount: '400.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'monthlyRecurring' } })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId: 'PF-ODD', name: 'Test odd', state: 'ENABLED', budgetAmount: '400.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'weekly' } })
    await campaign('c-sync', { portfolioId: 'PF-SYNC' })
    await campaign('c-bulk', { portfolioId: 'PF-BULK' })
    await campaign('c-odd', { portfolioId: 'PF-ODD' })
    await campaign('c-capped', { portfolioId: 'PF-CAP' })
    await campaign('c-end', { endDate: new Date(`${inAYear()}T00:00:00Z`) })
    await campaign('c-built', { portfolioId: 'PF-OPEN' })
    await campaign('c-arch', { status: 'ARCHIVED' })
    // An ads playbook built c-built (a slot it made).
    await db().adsPlaybookLink.create({ data: { playbookId: 'pb-test', kind: 'slot', key: 'exact', refId: 'c-built', origin: 'built', compiledVersion: 1, updatedBy: 'user:test' } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('the tool as the contract holds it', () => {
  it('strategy-bound, alwaysAsk, ceiling auto, fully undoable; at ask by default, and nothing runs alone by default', () => {
    const tool = getTool(TOOL)!
    expect(tool).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'full', openWorld: true, requires: ['ads.campaigns.manage', 'financials.adspend.view'] })
    expect(ruleFrom(tool, null).level).toBe('ask')
    expect(tool.limits!.parse({})).toMatchObject({ maxItems: 0, markets: [], campaignIds: [], allowRename: false, allowUpAndDown: false, allowEndDateRemoval: false, allowEngineOwned: false })
  })

  it('pure: which way each setting moves spend (down only < fixed < up and down; an end date removed or later; a cap left)', () => {
    const words = (_s: string, v: unknown) => String(v)
    expect(settingMove('biddingStrategy', 'legacyForSales', 'autoForSales', { words }).direction).toBe('raise')
    expect(settingMove('biddingStrategy', 'legacyForSales', 'manual', { words }).direction).toBe('raise')
    expect(settingMove('biddingStrategy', 'autoForSales', 'manual', { words }).direction).toBe('cut')
    expect(settingMove('endDate', '2027-01-01', null, { words }).direction).toBe('raise')
    expect(settingMove('endDate', '2027-01-01', '2027-02-01', { words }).direction).toBe('raise')
    expect(settingMove('endDate', null, '2027-01-01', { words }).direction).toBe('cut')
    const cap = { amountCents: 1000, currency: 'EUR', policy: 'monthly' as const, startDate: null, endDate: null }
    expect(settingMove('portfolioId', 'A', null, { words, fromCap: cap, toCap: null }).direction).toBe('raise')
    expect(settingMove('portfolioId', null, 'A', { words, fromCap: null, toCap: cap }).direction).toBe('cut')
    expect(settingMove('portfolioId', 'A', 'B', { words, fromCap: cap, toCap: { ...cap, amountCents: 2000 } }).direction).toBe('raise')
    expect(settingMove('name', 'a', 'b', { words }).direction).toBe('same')
  })
})

describe('a bulk move into a portfolio — one request, one approval, the screens\' own write', () => {
  it('previews each campaign from → to and where it lands; approved, writes as the approver in one change set; undo puts each back', async () => {
    const r = await preview({ campaignIds: ['c-m1', 'c-m2', 'c-m3'], portfolioId: 'PF-OPEN', why: 'group the jackets' })
    expect(r.ok, r.error).toBe(true)
    const p = r.preview as Row
    expect(p).toMatchObject({
      action: TOOL, totals: { changing: 3, already: 0 }, raises: [], noCode: expect.any(String), reach: { reach: 'sandbox' },
      limitFacts: { tool: TOOL, action: 'settings', this: { items: 3, writes: 3, raises: 0 } },
    })
    expect(p.changes[0]).toMatchObject({ campaignId: 'c-m1', label: 'campaign "Test c-m1"', changes: [{ label: 'Portfolio', from: 'no portfolio', to: 'portfolio "Test open"' }] })
    expect(p.effect).toMatch(/^Changes the settings of 3 Sponsored Products campaigns \(portfolio on 3\)/)

    const asked = await ask({ campaignIds: ['c-m1', 'c-m2', 'c-m3'], portfolioId: 'PF-OPEN', why: 'group the jackets' })
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { changed: 3, failed: 0, reach: { reach: 'sandbox' }, changeSetId: asked.approvalId } })
    for (const id of ['c-m1', 'c-m2', 'c-m3']) expect((await campaignOf(id)).portfolioId).toBe('PF-OPEN')
    const logs = await inside(() => db().advertisingActionLog.findMany({ where: { executionId: asked.approvalId }, select: { userId: true, entityId: true, actionType: true } })) as Row[]
    expect(logs.map((l) => l.entityId).sort()).toEqual(['c-m1', 'c-m2', 'c-m3'])
    expect(logs.every((l) => l.userId === 'user:u-approver' && l.actionType === 'AD_CAMPAIGN_PORTFOLIO_UPDATE')).toBe(true)
    const queued = await inside(() => db().outboundSyncQueue.findFirst({ where: { payload: { path: ['entityId'], equals: 'c-m2' } }, orderBy: { createdAt: 'desc' }, select: { payload: true } })) as Row
    expect(queued.payload).toMatchObject({ manual: true, fieldChanges: [{ field: 'portfolioId', oldValue: null, newValue: 'PF-OPEN' }] })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: TOOL, args: { campaigns: [{ campaignId: 'c-m1', portfolioId: null }, { campaignId: 'c-m2', portfolioId: null }, { campaignId: 'c-m3', portfolioId: null }] } },
    })
    // Asked again, nothing would change.
    expect((await preview({ campaignIds: ['c-m1'], portfolioId: 'PF-OPEN' })).error).toMatch(/^Nothing would change: campaign "Test c-m1" has these settings already/)
  })

  it('refused, and not queued: another market\'s portfolio, one made in Nexus only, an archived one, one not found', async () => {
    expect((await preview({ campaignIds: ['c-m1'], portfolioId: 'PF-UK' })).error).toMatch(/portfolio "Test UK" is in UK and campaign "Test c-m1" in IT: a portfolio holds one market's campaigns/)
    expect((await preview({ campaignIds: ['c-m1'], portfolioId: 'local-pf-local-IT-test-local' })).error).toMatch(/made in Nexus while writes were closed and Amazon does not know it/)
    expect((await preview({ campaignIds: ['c-m1'], portfolioId: 'PF-ARCH' })).error).toMatch(/is archived: no campaign can be moved into it/)
    expect((await preview({ campaignIds: ['c-m1'], portfolioId: 'PF-NOPE' })).error).toMatch(/portfolio PF-NOPE not found in this business/)
  })
})

describe('each setting', () => {
  it('a rename: one campaign, a name the market does not use; refused for a taken name or several campaigns', async () => {
    expect((await preview({ campaignIds: ['c-n1'], name: 'Italy exact' })).error).toMatch(/IT already has a campaign named "Italy exact": Amazon takes one campaign per name/)
    expect((await preview({ campaignIds: ['c-n1', 'c-m1'], name: 'Two at once' })).error).toMatch(/A name is for one campaign/)
    const r = await preview({ campaignIds: ['c-n1'], name: 'Test renamed' })
    expect(r.preview).toMatchObject({ raises: [], changes: [{ changes: [{ label: 'Name', from: '"Test c-n1"', to: '"Test renamed"' }] }] })
    const asked = await ask({ campaignIds: ['c-n1'], name: 'Test renamed' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect((await campaignOf('c-n1')).name).toBe('Test renamed')
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: TOOL, args: { campaigns: [{ campaignId: 'c-n1', name: 'Test c-n1' }] } } })
  })

  it('an end date: setting one holds spend back (no code); a past one is refused; removing one adds spend (code)', async () => {
    const end = inAYear()
    const set = await preview({ campaignIds: ['c-e1'], endDate: end })
    expect(set.preview).toMatchObject({ raises: [], noCode: expect.any(String), changes: [{ changes: [{ label: 'End date', from: 'no end date', to: end }] }], limitFacts: { this: { cuts: 1, raises: 0 } } })
    expect((await preview({ campaignIds: ['c-e1'], endDate: '2020-01-01' })).error).toMatch(/is in the past, which would end it at once/)
    const removed = await preview({ campaignIds: ['c-end'], endDate: null })
    expect(removed.preview).toMatchObject({ raises: [{ campaignId: 'c-end', why: expect.stringMatching(/is removed: it keeps spending until stopped/) }], stepUp: { raises: ['End date'] } })
    const asked = await ask({ campaignIds: ['c-end'], endDate: null })
    // A plain approve does not run a raise; with the approver's code it runs.
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/it raises, and a raise runs only when a person with settings\.security\.manage approved it with their authenticator code/) })
    expect((await campaignOf('c-end')).endDate).not.toBeNull()
    expect(await approve(asked.approvalId!, 'nexus-step-up')).toMatchObject({ ok: true, status: 'executed' })
    expect((await campaignOf('c-end')).endDate).toBeNull()
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: TOOL, args: { campaigns: [{ campaignId: 'c-end', endDate: inAYear() }] } } })
  })

  it('the bidding strategy: up and down (and fixed after down only) add spend and need the code; the screen\'s words', async () => {
    const up = await preview({ campaignIds: ['c-b1'], biddingStrategy: 'autoForSales' })
    expect(up.preview).toMatchObject({
      changes: [{ changes: [{ label: 'Bidding strategy', from: 'Dynamic bids - down only', to: 'Dynamic bids - up and down' }] }],
      raises: [{ why: expect.stringMatching(/Amazon may bid up to twice its bids/) }], stepUp: { raises: ['Bidding strategy'] },
    })
    expect((await preview({ campaignIds: ['c-b1'], biddingStrategy: 'manual' })).preview).toMatchObject({ raises: [{ why: expect.stringMatching(/its full bids, never lowering them/) }] })
    const asked = await ask({ campaignIds: ['c-b1'], biddingStrategy: 'autoForSales' })
    expect(await approve(asked.approvalId!, 'nexus-step-up')).toMatchObject({ ok: true, status: 'executed' })
    expect((await campaignOf('c-b1')).biddingStrategy).toBe('AUTO_FOR_SALES')
    const queued = await inside(() => db().outboundSyncQueue.findFirst({ where: { payload: { path: ['entityId'], equals: 'c-b1' } }, orderBy: { createdAt: 'desc' }, select: { payload: true } })) as Row
    expect(queued.payload).toMatchObject({ fieldChanges: [{ field: 'biddingStrategy', oldValue: 'LEGACY_FOR_SALES', newValue: 'AUTO_FOR_SALES' }] })
    // Back to down only lowers spend: no code.
    expect((await preview({ campaignIds: ['c-b1'], biddingStrategy: 'legacyForSales' })).preview).toMatchObject({ raises: [], noCode: expect.any(String) })
  })

  it('out of a capped portfolio adds spend (code); a campaign a playbook built may move, with a warning that never runs by rule', async () => {
    expect((await preview({ campaignIds: ['c-capped'], portfolioId: null })).preview).toMatchObject({
      raises: [{ why: 'it moves from portfolio "Test capped" to no portfolio: the cap EUR 500.00 a month no longer holds it' }], stepUp: { raises: ['Portfolio'] },
    })
    const built = (await preview({ campaignIds: ['c-built'], portfolioId: null })).preview as Row
    expect(built.warnings[0]).toMatch(/was built by an ads playbook: a portfolio move here leaves the playbook's own portfolio/)
    expect(built.items[0]).toMatchObject({ playbookBuilt: true })
    expect(judge(built, { markets: ['IT'], maxItems: 5 })).toBeTypeOf('string')
  })

  it('refused, and not queued: not found, not Sponsored Products, archived, nothing asked, both ways of naming', async () => {
    expect((await preview({ campaignIds: ['nope'], biddingStrategy: 'manual' })).error).toBe('Not queued: campaign nope was not found in this business.')
    expect((await preview({ campaignIds: ['c-sb'], biddingStrategy: 'manual' })).error).toMatch(/campaign "Italy brands": .*Sponsored Products/)
    expect((await preview({ campaignIds: ['c-arch'], biddingStrategy: 'manual' })).error).toMatch(/it is archived: Amazon does not change an archived campaign/)
    expect((await preview({ campaignIds: ['c-m1'] })).error).toMatch(/^Nothing to change for campaign "Test c-m1": give portfolioId, name, endDate or biddingStrategy/)
    expect((await preview({ campaignIds: ['c-m1'], campaigns: [{ campaignId: 'c-m2', biddingStrategy: 'manual' }] })).error).toMatch(/Name the campaigns one way/)
  })
})

describe('a stored cap in another spelling, or one Nexus cannot read: leaving it is never "the same"', () => {
  it('a synced MONTHLYRECURRING, the bulk sheet\'s monthlyRecurring and an unknown policy: each move out is a raise (code)', async () => {
    for (const [id, why] of [
      ['c-sync', 'it moves from portfolio "Test synced" to no portfolio: the cap EUR 400.00 a month no longer holds it'],
      ['c-bulk', 'it moves from portfolio "Test bulk sheet" to no portfolio: the cap EUR 400.00 a month no longer holds it'],
      ['c-odd', 'it moves from portfolio "Test odd" to no portfolio: the cap it holds now is a cap Nexus cannot read (its policy "weekly" is not one Nexus knows), so Nexus cannot tell whether it lets more spend: it counts as a raise'],
    ] as const) {
      expect((await preview({ campaignIds: [id], portfolioId: null })).preview, id).toMatchObject({ raises: [{ why }], stepUp: { raises: ['Portfolio'] } })
    }
    // Into a portfolio with a cap Nexus cannot read: a raise too (fail closed).
    expect((await preview({ campaignIds: ['c-ctl'], portfolioId: 'PF-ODD' })).preview).toMatchObject({ raises: [{ why: expect.stringMatching(/the cap it gets is a cap Nexus cannot read/) }] })
    const asked = await ask({ campaignIds: ['c-odd'], portfolioId: null })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/it raises/) })
    expect((await campaignOf('c-odd')).portfolioId).toBe('PF-ODD')
  })
})

/** Real people (a row, a role, a membership, an authenticator), for the real approve and commit paths. */
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
type RealPerson = { id: string; secret: string; principal: UserPrincipal }
async function realPerson(label: string): Promise<RealPerson> {
  const client = db()
  const secret = generateSecret()
  const role = await client.role.create({ data: { key: `W43_${randomUUID().slice(0, 8)}`, name: label, description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const user = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label, twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })
  await client.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: user.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return { id: user.id, secret, principal: { kind: 'user', userId: user.id, label, via: 'app', workspace: business, permissions: { isOwner: false, permissions: EVERYTHING } } }
}
const codeOf = (p: RealPerson) => { __stepUpTest.reset(); return generateSync({ secret: p.secret }) }
const approvalRow = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } })) as Promise<Row>
/** The undo window closes now, and the sweep's commit takes it (as the person who approved it, re-checked). */
const commitNow = async (approvalId: string) => {
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

describe('the real approve paths', () => {
  let approverPerson: RealPerson
  let asker: RealPerson
  beforeAll(async () => {
    approverPerson = await inside(() => realPerson('Test Approver'))
    asker = await inside(() => realPerson('Test Asker'))
  }, 60_000)

  it('a change plan carries the step\'s code: no code → mfa_required; with it the step runs', async () => {
    const queued = await inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
      return queuePlan({ title: 'Test settings plan', steps: [{ tool: TOOL, args: { campaignIds: ['c-plan'], endDate: null } }] }, claude, run.id)
    }) as Row
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    const planId = queued.approvalId as string
    expect((await approvalRow(planId)).preview.stepUp).toMatchObject({ what: 'changes settings that can add spend on 1 campaign', raises: ['End date'], steps: [1] })
    const decide = (code?: string) => inside(() => decideFleetApproval({ id: planId, decision: 'approve', actor: approverPerson.principal, ...(code ? { code } : {}) }))
    expect(await decide()).toMatchObject({ ok: false, code: 'mfa_required' })
    expect((await campaignOf('c-plan')).endDate).not.toBeNull()
    expect(await decide(codeOf(approverPerson))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(planId)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(planId))).toMatchObject({ finished: true, counts: { done: 1 } })
    expect((await campaignOf('c-plan')).endDate).toBeNull()
  })

  it('never by rule: a playbook-built campaign\'s move waits for a person at the business\'s rule (auto), and is not run if a rule decided it', async () => {
    const strategy = await inside(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 0 } }))
    await inside(() => db().agentTool.create({ data: { name: TOOL, riskTier: 'high', requiresApproval: true, claudeTrust: 'auto', claudeLimits: { markets: ['IT'], maxItems: 5, allowEngineOwned: true } } }))
    try {
      const mcp = { ...asker.principal, via: 'claude', business: { id: LEGACY_WORKSPACE_ID, name: 'Test business' }, scopes: ['nexus.read', 'nexus.write', 'nexus.run'], oauthGrantId: 'grant-w43' } as McpPrincipal
      const viaGate = (args: Record<string, unknown>) => inside(async () => {
        const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: mcp.userId } })
        return runOrQueueTool(TOOL, args, mcp, run.id, { rule: claudeGateRule(mcp) })
      }) as Promise<Row>
      // Control: a plain move inside every limit runs by the business's rule.
      expect(await viaGate({ campaignIds: ['c-ctl'], portfolioId: 'PF-OPEN' })).toMatchObject({ ok: true, rule: { by: 'rule', level: 'auto' } })
      // The playbook-built campaign: the same limits, and a person decides.
      const built = await viaGate({ campaignIds: ['c-built'], portfolioId: null })
      expect(built).toMatchObject({ ok: true, mode: 'queued', rule: { by: 'person', level: 'auto', why: expect.stringMatching(/an ads playbook built/) } })
      expect((await approvalRow(built.approvalId)).status).toBe('pending')
      // Should a rule ever decide it, execute refuses it.
      await inside(() => db().agentApproval.update({ where: { id: built.approvalId }, data: { decisionVia: 'auto' } }))
      expect(await inside(() => decideApproval(built.approvalId, 'approve', approver))).toMatchObject({ ok: false, error: expect.stringMatching(/never runs by rule: a person approves it/) })
      expect((await campaignOf('c-built')).portfolioId).toBe('PF-OPEN')
    } finally {
      await inside(() => db().agentTool.deleteMany({ where: { name: TOOL } }))
      await inside(() => db().adsStrategy.delete({ where: { id: strategy.id } }))
    }
  })
})

describe('the other doors: undo-ad-change and undo-change are no way around the code', () => {
  it('undo-ad-change refuses to put back a setting that adds spend; undo-change asks set-campaign-settings, which needs the code', async () => {
    const asked = await ask({ campaignIds: ['c-u1'], endDate: inAYear() })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    const back = await inside(() => callTool(claude, 'undo-ad-change', { changeSetId: asked.approvalId })) as Row
    expect(back.raw.error).toMatch(/^Not undone: putting these campaign settings back would add spend — campaign "Test c-u1": its end date .* is removed: it keeps spending until stopped\. set-campaign-settings does that, with the approver's authenticator code/)
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! })) as Row
    expect(undo).toMatchObject({ request: { tool: TOOL, args: { campaigns: [{ campaignId: 'c-u1', endDate: null }] } } })
    expect((await preview(undo.request.args)).preview).toMatchObject({ stepUp: { raises: ['End date'] } })
  })

  it('undo-ad-change still puts back a setting that lowers spend', async () => {
    const asked = await ask({ campaignIds: ['c-u2'], biddingStrategy: 'autoForSales' })
    expect(await approve(asked.approvalId!, 'nexus-step-up')).toMatchObject({ ok: true, status: 'executed' })
    const back = await inside(() => callTool(claude, 'undo-ad-change', { changeSetId: asked.approvalId })) as Row
    expect(back.raw.ok, back.raw.error).toBe(true)
  })
})

describe('the live-write allowlist: a person\'s approval passes it, a run by rule does not', () => {
  it('a campaign off the allowlist lands live on its profile, and the write gate refuses it as a run by rule', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const row = await inside(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 0 } }))
    try {
      const p = (await preview({ campaignIds: ['c-off'], biddingStrategy: 'legacyForSales', endDate: inAYear() })).preview as Row
      expect(p.reach).toMatchObject({ reach: 'live', profileId: 'P-IT-TEST' })
      expect(p.ruleGate).toMatch(/campaign "Italy not allowlisted": Amazon's write gate refuses it as a run by rule/)
      // Inside every limit and the strategy: only the allowlist holds it back, and it waits for a person.
      expect(judge(p, { markets: ['IT'], maxItems: 5, allowEngineOwned: true })).toMatch(/write gate refuses it as a run by rule .*; a person decides$/)
      // An allowlisted campaign in the same market passes the same judgement.
      const on = (await preview({ campaignIds: ['c-lim'], endDate: inAYear() })).preview as Row
      expect(on.ruleGate).toBeNull()
      expect(judge(on, { markets: ['IT'], maxItems: 5, allowEngineOwned: true })).toBeNull()
    } finally {
      await inside(() => db().adsStrategy.delete({ where: { id: row.id } }))
    }
  })
})

describe('the limits: nothing runs alone by default; inside the strategy and the limits, it may', () => {
  it('lists, renames, up and down and an end date each wait for a person unless the limits allow them', async () => {
    const row = await inside(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 0 } }))
    try {
      const same = (await preview({ campaignIds: ['c-lim'], portfolioId: 'PF-OPEN' })).preview
      expect(judge(same)).toMatch(/names no market|none listed/)
      expect(judge(same, { markets: ['IT'] })).toMatch(/more than the 0 this tool's limits allow/)
      expect(judge(same, { markets: ['IT'], maxItems: 5 })).toBeNull()
      expect(judge(same, { campaignIds: ['c-lim'], maxItems: 5 })).toBeNull()
      const rename = (await preview({ campaignIds: ['c-lim'], name: 'Test lim renamed' })).preview
      expect(judge(rename, { markets: ['IT'], maxItems: 5 })).toMatch(/a rename runs by rule only with allowRename/)
      expect(judge(rename, { markets: ['IT'], maxItems: 5, allowRename: true })).toBeNull()
      const up = (await preview({ campaignIds: ['c-lim'], biddingStrategy: 'autoForSales' })).preview
      expect(judge(up, { markets: ['IT'], maxItems: 5 })).toMatch(/runs by rule only with allowUpAndDown/)
      expect(judge(up, { markets: ['IT'], maxItems: 5, allowUpAndDown: true })).toBeNull()
      // The strategy narrows the kind: settings held at ask in the market.
      await inside(() => db().adsStrategy.update({ where: { id: row.id }, data: { claudeAutonomy: { settings: 'ask' }, version: 2 } }))
      expect(judge((await preview({ campaignIds: ['c-lim'], portfolioId: 'PF-OPEN' })).preview, { markets: ['IT'], maxItems: 5 }))
        .toMatch(/lets Claude only ask for changing campaign settings/)
    } finally {
      await inside(() => db().adsStrategy.delete({ where: { id: row.id } }))
    }
  })

  it('a preview without facts, or of another tool, is never inside', () => {
    expect(judge({ action: TOOL, items: [] })).toBeTypeOf('string')
    expect(judge({ summary: 'no facts' })).toMatch(/no preview of this settings change/)
  })
})

describe('stale: what was approved moved', () => {
  it('a campaign whose portfolio moved after the person approved is not run', async () => {
    const asked = await ask({ campaignIds: ['c-m3'], portfolioId: 'PF-CAP' })
    await inside(() => db().campaign.update({ where: { id: 'c-m3' }, data: { portfolioId: null } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false })
    expect((await campaignOf('c-m3')).portfolioId).toBeNull()
  })
})
