/**
 * ADS AUTONOMY W4-8 — assign-ad-rules, set-coverage-set and run-ad-engine-now through Claude's door, the Approvals routes
 * (real TOTP codes through the existing step-up verifier) and the commit, on PGlite with the production schema. Made-up
 * names, ids and amounts (public repo).
 *
 *   assign      the preview lists each campaign with its market and warns when it is not the rule's (the name's "— DE");
 *               such a request never runs by rule; approved, a builder rule's picker list is saved by the rule drawer's
 *               path (audit row naming the request, the Apply Rules column mirrored) and an engine budget rule's rows by
 *               the Apply Rules path (another rule on the campaign kept); refusals; a rule at Auto raises: listed and
 *               said, a day-to-day change under the Owner's code rule A (a plain approve runs it, no code; by rule only
 *               with allowRaise); undo puts the list back
 *   coverage    term edits through the cockpit's service; a higher target is a raise; a lead ASIN the family does not
 *               advertise is refused; an unmeasured seed creates a switched-off draft
 *   run-now     the preview says when the engine last ran and that a second run on the same data takes one more step;
 *               refused while it runs (its run row open, or its lock held), with when it should end; refused where the
 *               Control Room does not offer Run now; approved, it starts the registry's own job by hand (one CronRun row,
 *               manual) and approval-status reads how it went; by rule only with maxItems 1, a listed engine, and long
 *               enough after the last run
 *   plan        a change plan with a step that raises carries no code (day-to-day), and a plain approve runs it
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { __codeRuleTest } from './ads-code-rule.js'
import Fastify, { type FastifyInstance } from 'fastify'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
// The jobs a Run now starts: stood in, so the test runs no real engine (the start, its run row and its words are real).
const jobs = vi.hoisted(() => ({ ran: [] as string[] }))
vi.mock('../../../jobs/cron-registry.js', () => {
  const registry: Record<string, () => Promise<unknown>> = {
    'advertising-rule-evaluator': async () => { jobs.ran.push('advertising-rule-evaluator'); return 'rules=2 matched=0 (test)' },
    'ads-auto-bid': async () => { jobs.ran.push('ads-auto-bid'); return 'proposed=0 applied=0 (test)' },
  }
  return { CRON_REGISTRY: registry, isKnownCron: (n: string) => n in registry, listKnownCrons: () => Object.keys(registry) }
})
// The Control Room's answer for a lever (its level, and whether its drawer offers Run now), as the test sets it.
const lever = vi.hoisted(() => ({ mode: 'AUTO', available: true, why: null as string | null }))
const LEVERS: Record<string, { job: string; schedule: string }> = {
  'auto-bid': { job: 'ads-auto-bid', schedule: 'every 6 h' },
  'rank-defend': { job: 'ad-rank-defend', schedule: 'every 15 min' },
  'budget-pools': { job: 'budget-pool-rebalance', schedule: 'every 15 min' },
}
vi.mock('../../advertising/ads-control-room.service.js', () => ({
  getEngineLevers: async () => ({ levers: Object.entries(LEVERS).map(([key, l]) => ({ key, mode: lever.mode, modeReason: 'test reason', schedule: l.schedule })), global: {} }),
}))
vi.mock('../../advertising/ads-control-room-detail.service.js', () => ({
  getEngineDetail: async (key: string) => (LEVERS[key] ? { key, run: { available: lever.available, jobName: lever.available ? LEVERS[key].job : null, why: lever.why }, runs: [] } : null),
}))

import { __stepUpTest } from '../../../lib/auth/step-up.js'
import { resolvePermissions } from '../../../lib/auth/rbac.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { createWorkspaceService } from '../../workspace.service.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { setClaudeRule } from '../claude-trust.service.js'
import { runPlan } from '../change-plan.service.js'
import { nameMarket } from '../../advertising/ads-rule-assign.service.js'
import { getTool } from '../tool-registry.js'
import { setEngineLockStoreForTests } from '../../advertising/ads-engine-lock.js'
import agentFleetRoutes from '../../../routes/agent-fleet.routes.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 60_000
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const EVERYTHING = [...Object.values(F), ...Object.values(FIELDS)] as string[]
type Who = 'owner' | 'manager'
const people: Record<Who, { id: string; secret: string; label: string }> = {} as never
const ids: Record<string, string> = {}
let nameA = ''
let app: FastifyInstance
let signedIn = ''
type Json = Record<string, any>

async function person(who: Who, label: string, permissions: string[]) {
  const c = database.client
  const role = await c.role.create({ data: { key: `W48_${randomUUID().slice(0, 8)}`, name: label, description: 'test', isSystem: false, permissions } })
  const secret = generateSecret()
  const user = await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label, twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })
  await c.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await c.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  people[who] = { id: user.id, secret, label }
}
const codeOf = (who: Who = 'owner') => generateSync({ secret: people[who].secret })
function claude(who: Who = 'owner'): McpPrincipal {
  return {
    kind: 'user', userId: people[who].id, label: people[who].label, permissions: { isOwner: false, permissions: new Set(EVERYTHING) },
    workspace: business, business: { id: A, name: nameA }, via: 'claude', oauthGrantId: `grant-${who}`, scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
const viewer = (who: Who): UserPrincipal => ({ kind: 'user', userId: people[who].id, label: people[who].label, permissions: { isOwner: false, permissions: new Set(EVERYTHING) }, workspace: business, via: 'app' })
async function call(tool: string, args: Record<string, unknown>) {
  const result = await runToolForClaude(claude(), getTool(tool)!, { ...args, business: nameA })
  return { isError: !!result.isError, answer: JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join('')) as Json }
}
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(viewer('owner'), tool, args))).raw as Json
const decide = (who: Who, id: string, payload: Record<string, unknown>) => {
  signedIn = people[who].id
  return app.inject({ method: 'POST', url: `/agent/fleet/approvals/${id}/decide`, payload: { decision: 'approve', ...payload } })
}
async function commit(id: string) {
  await inside(() => db().agentApproval.update({ where: { id }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(id))
}
const tool = (name: string) => getTool(name)!
const judge = (name: string, p: unknown, limits: Record<string, unknown> = {}) => tool(name).withinLimits!(p, tool(name).limits!.parse(limits) as Record<string, unknown>)
const picks = async (ruleId: string) => (((await inside(() => db().automationRule.findUniqueOrThrow({ where: { id: ruleId } }))).actions as Json[])[0].campaigns as Json[]).map((c) => c.id).sort()
const links = (ruleId: string) => inside(async () => (await db().campaignRuleAssignment.findMany({ where: { ruleId }, select: { campaignId: true, createdBy: true } })).sort((a, b) => a.campaignId.localeCompare(b.campaignId)))

const budgetGroup = { match: 'all', conditions: [{ metric: 'Spend', op: 'gte', value: '5' }], action: { op: 'decPct', value: '10' } }

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  await person('owner', 'Olga Owner', EVERYTHING)
  await person('manager', 'Max Manager', EVERYTHING.filter((p) => p !== F.settingsSecurityManage))
  nameA = (await database.client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  await inside(async () => {
    const c = db()
    const campaign = async (key: string, marketplace: string, extra: Record<string, unknown> = {}) => {
      ids[key] = (await c.campaign.create({ data: { name: `TEST ${key}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace, externalCampaignId: `TEST-EXT-${key}`, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), ...extra } })).id
    }
    await campaign('de1', 'DE', { portfolioId: 'TEST-PF-1' })
    await campaign('de2', 'DE', { portfolioId: 'TEST-PF-1' })
    await campaign('it1', 'IT')
    await campaign('fr1', 'FR')
    const group = await c.adGroup.create({ data: { campaignId: ids.de1, name: 'TEST group', externalAdGroupId: 'TEST-EXT-G1' } })
    await c.adProductAd.create({ data: { adGroupId: group.id, asin: 'B0TESTLEAD', sku: 'TEST-SKU-W48' } })
    await c.amazonAdsConnection.create({ data: { profileId: 'TEST-PROFILE-DE', marketplace: 'DE', region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } })
    const rule = async (key: string, data: Record<string, unknown>) => {
      ids[key] = (await c.automationRule.create({ data: { domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', ...data } as never })).id
    }
    // A builder Budget rule whose NAME says DE (no scope): it cuts budgets.
    await rule('budget', { name: 'Trim spend — DE', actions: [{ type: 'budget', campaigns: [{ id: ids.de1, name: 'TEST de1' }], budgetFloor: 1, budgetCeiling: 30 }], conditions: [budgetGroup] })
    // The same with a DE scope: the drawer refuses picks outside DE.
    await rule('scoped', { name: 'Scoped trim', scopeMarketplace: 'DE', actions: [{ type: 'budget', campaigns: [{ id: ids.de1, name: 'TEST de1' }], budgetFloor: 1, budgetCeiling: 30 }], conditions: [budgetGroup] })
    // Engine-native budget rules (the Apply Rules column): one under test, another already on de1.
    await rule('engine', { name: 'Engine budget cut', actions: [{ type: 'adjust_ad_budget', percent: -10 }], conditions: [] })
    await rule('other', { name: 'Other engine budget rule', actions: [{ type: 'adjust_ad_budget', percent: -5 }], conditions: [] })
    await c.campaignRuleAssignment.create({ data: { campaignId: ids.de1, ruleId: ids.other, kind: 'budget', createdBy: 'user:test' } })
    // A Bid rule at Auto that raises bids.
    await rule('auto', { name: 'Push bids — DE', autonomyLevel: 'AUTO', dryRun: false, actions: [{ type: 'bid', campaigns: [{ id: ids.de1, name: 'TEST de1' }] }], conditions: [{ ...budgetGroup, action: { op: 'incPct', value: '10' } }] })
    await rule('log', { name: 'Just log', actions: [{ type: 'log_only' }], conditions: [] })
    // A coverage set on the DE family.
    const set = await c.keywordCoverageSet.create({ data: { name: 'TEST coverage', portfolioId: 'TEST-PF-1', marketplace: 'DE', enabled: true } })
    ids.set = set.id
    ids.t1 = (await c.keywordCoverageTerm.create({ data: { setId: set.id, term: 'test term one', status: 'ACTIVE' } })).id
    ids.t2 = (await c.keywordCoverageTerm.create({ data: { setId: set.id, term: 'test term two', status: 'ACTIVE', targetSharePct: 20, maxCpcCents: 80 } })).id
    ids.t3 = (await c.keywordCoverageTerm.create({ data: { setId: set.id, term: 'test term three', status: 'PAUSED', targetSharePct: 15 } })).id
    // The rules evaluator's last scheduled run: 3 hours ago, 2 minutes long.
    const started = new Date(Date.now() - 3 * 3600_000)
    await c.cronRun.create({ data: { jobName: 'advertising-rule-evaluator', status: 'SUCCESS', triggeredBy: 'cron', startedAt: started, finishedAt: new Date(started.getTime() + 120_000), outputSummary: 'rules=2 matched=1 (earlier)' } })
  })

  const c = database.client
  const workspaces = createWorkspaceService(c as never)
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    void (async () => {
      const user = await c.userProfile.findUniqueOrThrow({
        where: { id: signedIn },
        select: { id: true, email: true, displayName: true, status: true, permissionsVersion: true, roleAssignments: { select: { role: { select: { key: true } } } } },
      })
      const authUser = { ...user, roleKeys: user.roleAssignments.map((a) => a.role.key) }
      const r = request as unknown as Record<string, unknown>
      r.__sessionLoaded = true
      r.authUser = authUser
      if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
        const access = await workspaces.membership(user.id, A)
        r.__rbacResolved = { isOwner: access.isOwner, permissions: access.permissions }
        r.workspace = access.context
      } else {
        r.__rbacResolved = await resolvePermissions(authUser as never)
      }
      withWorkspace(business, done)
    })().catch(done)
  })
  await app.register(agentFleetRoutes)
  await app.ready()
}, 180_000)

beforeEach(() => { __stepUpTest.reset(); lever.mode = 'AUTO'; lever.available = true; lever.why = null; setEngineLockStoreForTests(undefined) })

afterAll(async () => {
  vi.unstubAllEnvs()
  setEngineLockStoreForTests(undefined)
  await app?.close()
  await database?.close()
}, 30_000)

describe('W4-8 assign-ad-rules — the market check, and the screens’ own paths', { timeout: TIMEOUT }, () => {
  it('lists each campaign with its market and warns when it is not the rule’s market; never by rule then', async () => {
    const r = await preview('assign-ad-rules', { ruleId: ids.budget, op: 'add', campaignIds: [ids.de2, ids.it1, ids.fr1] })
    expect(r.ok, r.error).toBe(true)
    const p = r.preview
    expect(p).toMatchObject({
      action: 'assign-ad-rules', op: 'add', binding: 'picker',
      rule: { id: ids.budget, name: 'Trim spend — DE', level: 'PROPOSE', market: 'DE', marketFrom: 'name', kind: 'a Budget rule' },
      totals: { before: 1, after: 4, added: 3, removed: 0, otherMarketAfter: 2 },
      marketsAfter: { DE: 2, IT: 1, FR: 1 },
      raises: [],
      reach: { nexusOnly: true },
    })
    expect(p.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ campaignId: ids.it1, market: 'IT', from: 'not bound', to: 'bound', otherMarket: true }),
      expect.objectContaining({ campaignId: ids.de2, market: 'DE', from: 'not bound', to: 'bound' }),
    ]))
    expect(p.changes.find((l: Json) => l.campaignId === ids.de2).otherMarket).toBeUndefined()
    expect(p.warnings[0]).toBe('The rule\'s name says DE, but 2 campaigns it will act on are in other markets (1 in FR, 1 in IT). Check that this rule is meant for them.')
    expect(p.effect).toMatch(/Nexus only: nothing is sent to Amazon by this change; at Propose it suggests changes there on its next run/)
    expect(p.stepUp).toBeUndefined()
    // Even with every limit open, a campaign outside the rule's market waits for a person.
    expect(judge('assign-ad-rules', p, { maxItems: 250, allowEngineOwned: true, allowRaise: true })).toMatch(/outside DE \(its name\): a person decides/)
  })

  it('approved, a builder rule’s list is saved by the rule drawer’s path (its audit row names the request; the column mirrors it); undo puts it back', async () => {
    const { answer } = await call('assign-ad-rules', { ruleId: ids.budget, op: 'add', campaignIds: [ids.de2], why: 'test: add de2' })
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 'waiting_for_approval', consequences: { reaches: 'Nexus only', reversibility: 'partial' } })
    expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await picks(ids.budget)).toEqual([ids.de1, ids.de2].sort())
    expect((await links(ids.budget)).map((l) => l.campaignId)).toEqual([ids.de1, ids.de2].sort())
    const audit = await inside(() => db().advertisingActionLog.findFirstOrThrow({ where: { entityType: 'RULE', entityId: ids.budget, actionType: 'update_rule' }, orderBy: { createdAt: 'desc' } }))
    expect(audit.userId).toBe(`user:${people.owner.id}`)
    expect(JSON.stringify(audit.evidence)).toContain(`Claude request ${answer.approvalId}: test: add de2`)
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: answer.approvalId } }))
    expect(change.before).toMatchObject({ ruleId: ids.budget, binding: 'picker', campaignIds: [ids.de1] })
    // A rename since does not stop the undo: it goes by the rule's id.
    await inside(() => db().automationRule.update({ where: { id: ids.budget }, data: { name: 'Trim spend renamed — DE' } }))
    const undo = await call('undo-change', { changeId: change.id })
    expect(undo.answer, JSON.stringify(undo.answer)).toMatchObject({ status: 'waiting_for_approval', preview: { action: 'assign-ad-rules', op: 'replace', totals: { removed: 1, after: 1 } } })
    expect((await decide('owner', undo.answer.approvalId, {})).statusCode).toBe(200)
    expect(await commit(undo.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await picks(ids.budget)).toEqual([ids.de1])
  })

  it('an engine budget rule is bound by the Apply Rules path: each campaign keeps its other rules', async () => {
    const { answer } = await call('assign-ad-rules', { ruleId: ids.engine, op: 'replace', campaignIds: [ids.de1, ids.de2] })
    expect(answer.preview).toMatchObject({ binding: 'assignment', rule: { kind: 'an engine budget rule', market: null }, totals: { before: 0, after: 2, added: 2 } })
    expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await links(ids.engine)).toEqual([ids.de1, ids.de2].sort().map((campaignId) => ({ campaignId, createdBy: `user:${people.owner.id}` })))
    expect((await links(ids.other)).map((l) => l.campaignId)).toEqual([ids.de1])
  })

  it('refuses, and queues nothing: a rule not bound to campaigns, emptying a Bid rule, picks the drawer refuses, a campaign not found', async () => {
    expect((await preview('assign-ad-rules', { ruleId: ids.log, op: 'add', campaignIds: [ids.de1] })).error).toMatch(/is not bound to campaigns: its scope decides .*save-ad-rule/)
    expect((await preview('assign-ad-rules', { ruleId: ids.auto, op: 'remove', campaignIds: [ids.de1] })).error).toMatch(/^Not queued: an empty campaign list makes a Bid rule act on every campaign in its scope.*turn-down-automation/)
    expect((await preview('assign-ad-rules', { ruleId: ids.scoped, op: 'add', campaignIds: [ids.it1] })).error)
      .toBe('Not queued: the rule drawer\'s save refuses it — This rule runs in DE only, but 1 of its 2 picked campaigns is in another market (1 in IT), so it can never change it. Remove the pick outside DE.')
    expect((await preview('assign-ad-rules', { ruleId: ids.budget, op: 'add', campaignIds: ['no-such-campaign'] })).error).toMatch(/1 campaign was not found in this business/)
    expect((await preview('assign-ad-rules', { ruleId: ids.budget, op: 'add', campaignIds: [ids.de1] })).error).toMatch(/^Nothing would change/)
  })

  it('a rule at Auto: the raise is listed and said, no code (code rule A: day-to-day); by rule never with allowRaise off; a plain approve runs it', async () => {
    const { answer } = await call('assign-ad-rules', { ruleId: ids.auto, op: 'add', campaignIds: [ids.de2] })
    expect(answer.preview).toMatchObject({
      rule: { level: 'AUTO' }, raises: ['at Auto, the rule starts acting on 1 more campaign, and it can raise what they spend'],
      noCode: expect.stringMatching(/day-to-day/),
      effect: expect.stringMatching(/ It ADDS SPEND \(at Auto, the rule starts acting on 1 more campaign, and it can raise what they spend\): a day-to-day change — a person's approval sends it, with no authenticator code\.$/),
      warnings: expect.arrayContaining(['It can raise spend: at Auto, the rule starts acting on 1 more campaign, and it can raise what they spend.']),
    })
    expect(answer.preview.stepUp).toBeUndefined()
    // The code table decides the code: its line flipped ('assign-ad-rules: a rule at Auto'), the card asks for it.
    __codeRuleTest.flip('assign-ad-rules: a rule at Auto')
    try {
      expect(((await preview('assign-ad-rules', { ruleId: ids.auto, op: 'add', campaignIds: [ids.de2] })).preview).stepUp, 'assign-ad-rules: a rule at Auto').toMatchObject({ needs: expect.stringContaining('settings.security.manage') })
    } finally { __codeRuleTest.reset() }
    // By rule: never with allowRaise off (the default), whatever else is open.
    expect(judge('assign-ad-rules', answer.preview, { maxItems: 250, allowEngineOwned: true })).toMatch(/it can raise spend .*a person decides \(allowRaise is off\)$/)
    expect(await picks(ids.auto)).toEqual([ids.de1])
    expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await picks(ids.auto)).toEqual([ids.de1, ids.de2].sort())
  })

  it('never by rule: a campaign outside the rule’s market is refused at the commit, and by execute itself', async () => {
    const { answer } = await call('assign-ad-rules', { ruleId: ids.budget, op: 'add', campaignIds: [ids.it1] })
    expect(answer.preview.totals.otherMarketAfter).toBe(1)
    // As if the business's rule had decided it (an old or edited request): the commit's fresh check hands it back.
    expect(await inside(() => scheduleApproval({ id: answer.approvalId, actor: viewer('owner'), via: 'auto' }))).toMatchObject({ ok: true })
    expect(await commit(answer.approvalId)).toMatchObject({ ok: false })
    expect((await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: answer.approvalId } }))).status).not.toBe('executed')
    expect(await picks(ids.budget)).not.toContain(ids.it1)
    // And execute refuses a run the business's rule decided, whatever reached it.
    const out = (await inside(() => executeTool(viewer('owner'), 'assign-ad-rules', { ruleId: ids.budget, op: 'add', campaignIds: [ids.it1] }, { approvalId: answer.approvalId, decidedVia: 'auto', via: 'claude' }))).raw
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/outside the rule's market, and that never runs by rule/) })
    expect(await picks(ids.budget)).not.toContain(ids.it1)
  })

  it('a market in a rule’s name is a separate capital token after a dash', () => {
    expect(nameMarket('Trim spend — DE')).toBe('DE')
    expect(nameMarket('Trim spend - GB')).toBe('UK')
    expect(nameMarket('Trim spend –IT')).toBe('IT')
    for (const name of ['pause it', 'let it be', 'Trim spend IT', 'Trim spend - it', 'Trim spend — XX', 'Trim (DE)']) expect(nameMarket(name), name).toBeNull()
  })

  it('a change plan with a step that raises at Auto: no code on the plan (day-to-day)', async () => {
    const { answer } = await call('submit-change-plan', { title: 'Test plan', steps: [{ tool: 'assign-ad-rules', args: { ruleId: ids.auto, op: 'add', campaignIds: [ids.it1] } }] })
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 'waiting_for_approval' })
    expect(answer.preview?.stepUp).toBeUndefined()
  })
})

describe('W4-8 set-coverage-set — the cockpit’s own service', { timeout: TIMEOUT }, () => {
  it('a higher target is a raise, listed and said (no code: day-to-day); a pause is not; a lead ASIN the family does not advertise is refused', async () => {
    const raise = await preview('set-coverage-set', { op: 'edit-terms', setId: ids.set, terms: [{ termId: ids.t2, targetSharePct: 30 }, { termId: ids.t3, status: 'ACTIVE' }] })
    expect(raise.preview).toMatchObject({
      action: 'set-coverage-set', op: 'edit-terms', set: { name: 'TEST coverage', enabled: true },
      totals: { termsEdited: 2, raises: 2 }, raisedTerms: [ids.t2, ids.t3], noCode: expect.stringMatching(/day-to-day/), reach: { nexusOnly: true },
      effect: expect.stringMatching(/It ADDS SPEND \("test term two": target share 20 → 30 %/),
    })
    expect(raise.preview.stepUp).toBeUndefined()
    // The code table decides the code: its line flipped ('set-coverage-set'), the card asks for it.
    __codeRuleTest.flip('set-coverage-set')
    try {
      expect(((await preview('set-coverage-set', { op: 'edit-terms', setId: ids.set, terms: [{ termId: ids.t2, targetSharePct: 30 }, { termId: ids.t3, status: 'ACTIVE' }] })).preview).stepUp, 'set-coverage-set').toMatchObject({ needs: expect.stringContaining('settings.security.manage') })
    } finally { __codeRuleTest.reset() }
    expect(raise.preview.raises[0]).toBe('"test term two": target share 20 → 30 %, so the engine may raise its bid further')
    expect(raise.preview.raises[1]).toMatch(/^"test term three": it is active again, so the engine may raise its bid toward 15 % share/)
    expect(judge('set-coverage-set', raise.preview, { maxItems: 250, allowEngineOwned: true })).toMatch(/allowRaise is off/)
    const lower = await preview('set-coverage-set', { op: 'edit-terms', setId: ids.set, terms: [{ termId: ids.t2, status: 'PAUSED', leadAsin: 'B0TESTLEAD' }] })
    expect(lower.preview).toMatchObject({ raises: [], totals: { termsEdited: 1, values: 2 } })
    expect(lower.preview.stepUp).toBeUndefined()
    expect((await preview('set-coverage-set', { op: 'edit-terms', setId: ids.set, terms: [{ termId: ids.t1, leadAsin: 'B0NOTOURS1' }] })).error).toMatch(/B0NOTOURS1 is not advertised by this family/)
  })

  it('approved, a term edit is written by the cockpit’s service; undo puts the values back', async () => {
    const { answer } = await call('set-coverage-set', { op: 'edit-terms', setId: ids.set, terms: [{ termId: ids.t1, isControl: true }] })
    expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await inside(() => db().keywordCoverageTerm.findUniqueOrThrow({ where: { id: ids.t1 } }))).isControl).toBe(true)
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: answer.approvalId } }))
    expect(tool('set-coverage-set').undo!.request({ before: change.before, after: change.after })).toMatchObject({ tool: 'set-coverage-set', args: { op: 'edit-terms', terms: [{ termId: ids.t1, isControl: false }] } })
  })

  it('an unmeasured seed creates a switched-off draft and adds no term', async () => {
    await inside(() => db().campaign.update({ where: { id: ids.fr1 }, data: { portfolioId: 'TEST-PF-2' } }))
    const r = await preview('set-coverage-set', { op: 'seed', portfolioId: 'TEST-PF-2' })
    expect(r.preview).toMatchObject({ op: 'seed', set: { id: null, marketplace: 'FR', enabled: false }, totals: { termsAdded: 0, setCreated: 1 }, raises: [] })
    expect(r.preview.effect).toMatch(/^Creates the coverage set ".*" \(FR\) as a draft, switched off, and adds no term yet/)
  })
})

describe('W4-8 run-ad-engine-now — the Control Room’s Run now', { timeout: TIMEOUT }, () => {
  it('says when the engine last ran and that a second run on the same data takes one more step', async () => {
    const r = await preview('run-ad-engine-now', { engine: 'rules' })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'run-ad-engine-now', engine: 'rules', job: 'advertising-rule-evaluator', schedule: 'every 15 min',
      lastRun: { status: 'SUCCESS', by: 'schedule', summary: 'rules=2 matched=1 (earlier)', minutes: 2 },
      basis: { lastRunAt: null },
    })
    expect(r.preview.effect).toMatch(/It last ran 3 h ago, at .* UTC \(on its schedule, success: rules=2 matched=1 \(earlier\)\)\. It runs on its own every 15 min\./)
    expect(r.preview).toMatchObject({ steps: true, warning: expect.stringMatching(/^A second run on the same data acts again: each rule acts on what matches it now/) })
    expect(r.preview.warnings).toContain('Amazon ads rules (the rules evaluator, harvesting included): it has no lock: a scheduled run that starts in the same moment can overlap it; each rule\'s own daily caps still hold across both.')
  })

  it('refuses while the engine runs, with when it should end: an open run row, or its lock held', async () => {
    const open = await inside(() => db().cronRun.create({ data: { jobName: 'advertising-rule-evaluator', status: 'RUNNING', triggeredBy: 'cron', startedAt: new Date(Date.now() - 60_000) } }))
    try {
      expect((await preview('run-ad-engine-now', { engine: 'rules' })).error).toMatch(/^Not queued: .* is running now: a run started at .* UTC and its record is still open\. Its runs usually take about 2 min, so it should end around .* UTC\. If that run died, its record stays open until the stale-run sweep closes it, by .* UTC at the latest\. Ask again after that\.$/)
    } finally { await inside(() => db().cronRun.delete({ where: { id: open.id } })) }
    setEngineLockStoreForTests({ status: 'ready', eval: async () => 45_000 })
    expect((await preview('run-ad-engine-now', { engine: 'auto-bid' })).error).toBe('Not queued: Bid optimiser (auto-bid) is running now: its lock is held by a run in progress. The lock lets go when that run ends — or, if the run died, about 90 seconds after it stopped renewing it. Ask again after that.')
  })

  it('refuses where the Control Room does not offer Run now', async () => {
    lever.available = false
    lever.why = 'Not offered while this engine is off: switched off for this business'
    expect((await preview('run-ad-engine-now', { engine: 'auto-bid' })).error).toBe('Not queued: the Ads Control Room does not offer Run now for Bid optimiser (auto-bid) — while this engine is off: switched off for this business.')
  })

  it('at Auto it raises (listed and said, no code: day-to-day); a plain approve starts the registry’s job by hand, and approval-status reads the run', async () => {
    setEngineLockStoreForTests({ status: 'ready', eval: async () => -2 })
    const { answer } = await call('run-ad-engine-now', { engine: 'auto-bid', why: 'test: run now' })
    expect(answer, JSON.stringify(answer)).toMatchObject({
      status: 'waiting_for_approval', consequences: { reversibility: 'none' },
      preview: { level: 'AUTO', raises: [expect.stringMatching(/runs at Auto: it may raise bids or budgets on this run/)], noCode: expect.stringMatching(/day-to-day/), effect: expect.stringMatching(/It ADDS SPEND \(.* runs at Auto/) },
    })
    expect(answer.preview.stepUp).toBeUndefined()
    // The code table decides the code: its line flipped ('run-ad-engine-now'), the card asks for it.
    __codeRuleTest.flip('run-ad-engine-now')
    try {
      expect(((await preview('run-ad-engine-now', { engine: 'auto-bid' })).preview).stepUp, 'run-ad-engine-now').toMatchObject({ needs: expect.stringContaining('settings.security.manage') })
    } finally { __codeRuleTest.reset() }
    expect(jobs.ran).not.toContain('ads-auto-bid')
    expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    await vi.waitFor(async () => {
      const row = await inside(() => db().cronRun.findFirst({ where: { jobName: 'ads-auto-bid', triggeredBy: 'manual' } }))
      expect(row?.status).toBe('SUCCESS')
    })
    expect(jobs.ran).toContain('ads-auto-bid')
    const status = (await call('approval-status', { approvalId: answer.approvalId })).answer
    expect(status).toMatchObject({ engineRun: { job: 'ads-auto-bid', run: { status: 'SUCCESS', runSummary: 'proposed=0 applied=0 (test)' } } })
    expect(status.meaning).toMatch(/^The engine ran \(success\)/)
  })

  it('below Auto no code is needed; by rule only with maxItems 1, a listed engine, and long enough after its last run', async () => {
    lever.mode = 'PROPOSE'
    const r = await preview('run-ad-engine-now', { engine: 'rules' })
    expect(r.preview.level).toBe('PROPOSE')
    expect(r.preview.raises).toEqual([])
    expect(r.preview.stepUp).toBeUndefined()
    expect(judge('run-ad-engine-now', r.preview)).toMatch(/maxItems 0: every run waits for a person/)
    expect(judge('run-ad-engine-now', r.preview, { maxItems: 1 })).toMatch(/is not on the engines Claude may run now by rule \(engines is empty\)/)
    expect(judge('run-ad-engine-now', r.preview, { maxItems: 1, engines: ['auto-bid'] })).toMatch(/is not on the engines Claude may run now by rule/)
    expect(judge('run-ad-engine-now', r.preview, { maxItems: 1, engines: ['rules'], minHoursSinceLastRun: 2 })).toBeNull()
    expect(judge('run-ad-engine-now', r.preview, { maxItems: 1, engines: ['rules'], minHoursSinceLastRun: 12 })).toMatch(/last ran 3 h ago, less than the 12 h/)
  })

  it('per engine: the hourly bid plans set the same values again; a pool in its cool-down is skipped and has no lock', async () => {
    const rank = await preview('run-ad-engine-now', { engine: 'rank-defend' })
    expect(rank.preview).toMatchObject({ steps: false, schedule: 'every 15 min', basis: { lastRunAt: null }, warning: expect.stringMatching(/^A second run in the same hour sets the same values again/) })
    expect(rank.preview.raises).toEqual(['Hourly bid plans (rank-defend) runs at Auto: it may raise bids or budgets on this run, as on any of its runs'])
    expect(rank.preview.warnings.join(' ')).not.toMatch(/no lock/)
    const pool = await preview('run-ad-engine-now', { engine: 'pool' })
    expect(pool.preview).toMatchObject({ steps: true, warning: expect.stringMatching(/^A pool inside its cool-down is skipped\. A pool past it rebalances again on the same data: one more shift/) })
    expect(pool.preview.warnings[1]).toMatch(/it has no lock: a scheduled run that starts in the same moment can overlap it/)
  })

  it('a change plan with the run (day-to-day): no code on the plan; a plain approve, and the plan starts the engine', async () => {
    setEngineLockStoreForTests({ status: 'ready', eval: async () => -2 })
    const { answer } = await call('submit-change-plan', { title: 'Test run plan', steps: [{ tool: 'run-ad-engine-now', args: { engine: 'auto-bid' } }] })
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 'waiting_for_approval' })
    expect(answer.preview?.stepUp).toBeUndefined()
    const before = jobs.ran.filter((j) => j === 'ads-auto-bid').length
    expect((await decide('owner', answer.approvalId, {})).statusCode).toBe(200)
    expect(await commit(answer.approvalId)).toMatchObject({ ok: true })
    expect(await inside(() => runPlan(answer.approvalId))).toMatchObject({ finished: true, counts: { done: 1 } })
    await vi.waitFor(() => expect(jobs.ran.filter((j) => j === 'ads-auto-bid').length).toBe(before + 1))
  })

  it('by rule through the real commit: only for an engine the limits list, and then it starts', async () => {
    const owner = { userId: people.owner.id, label: 'Olga Owner', canManage: true }
    // It cannot be undone: its level and its limits are raised one at a time, each with its own code.
    expect(await inside(() => setClaudeRule(owner, 'run-ad-engine-now', { level: 'auto', code: codeOf() }))).toMatchObject({ ok: true })
    try {
      __stepUpTest.reset()
      expect(await inside(() => setClaudeRule(owner, 'run-ad-engine-now', { limits: { maxItems: 1, engines: ['auto-bid'], minHoursSinceLastRun: 2 }, code: codeOf() }))).toMatchObject({ ok: true })
      const waits = await call('run-ad-engine-now', { engine: 'rules' })
      expect(waits.answer, JSON.stringify(waits.answer)).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining('is not on the engines Claude may run now by rule') } })
      __stepUpTest.reset()
      expect(await inside(() => setClaudeRule(owner, 'run-ad-engine-now', { limits: { maxItems: 1, engines: ['rules'], minHoursSinceLastRun: 2 }, code: codeOf() }))).toMatchObject({ ok: true })
      const runs = await call('run-ad-engine-now', { engine: 'rules' })
      expect(runs.answer, JSON.stringify(runs.answer)).toMatchObject({ status: 'runs_by_rule', preview: { level: 'PROPOSE', raises: [] } })
      expect(await commit(runs.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
      await vi.waitFor(async () => {
        const row = await inside(() => db().cronRun.findFirst({ where: { jobName: 'advertising-rule-evaluator', triggeredBy: 'manual' } }))
        expect(row?.status).toBe('SUCCESS')
      })
      expect(jobs.ran).toContain('advertising-rule-evaluator')
    } finally {
      __stepUpTest.reset()
      expect(await inside(() => setClaudeRule(owner, 'run-ad-engine-now', { level: 'ask', limits: null, code: codeOf() }))).toMatchObject({ ok: true })
    }
  })
})
