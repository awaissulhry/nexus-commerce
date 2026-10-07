/**
 * ADS AUTONOMY W4-3 — ad-portfolios and set-portfolio, run for real through the door and the approval gate (PGlite,
 * production schema; the ads write gate the real one, sandbox unless a test goes live). Made-up names and ids.
 *
 * Proven: the read lists each portfolio with its market, cap, campaigns and spend; a create, a rename, a cap and an
 * archive go through the Portfolios page's own services (createPortfolio, updatePortfolioById) as the approver, each on
 * the ads audit with the approval as change set; a raised cap and an archive that frees a capped portfolio's campaigns
 * are day-to-day under the Owner's code rule A (listed in raises, said in the effect, a plain approve runs them, no
 * code); a taken name, a portfolio made in Nexus only, an archived one and a bad cap are refused and
 * not queued; undo archives a new portfolio and puts an old name and cap back (never a cap removed); the default limits
 * let nothing run alone.
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

// Amazon's answer to a portfolio create, in live mode: a name with REFUSED is refused (no id, Amazon's words).
vi.mock('../../advertising/ads-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../advertising/ads-api-client.js')>()
  return {
    ...actual,
    createPortfolio: async (ctx: unknown, input: { name: string }) => (/REFUSED/.test(input.name)
      ? { ok: true, mode: 'live', externalId: null, error: 'Amazon says: a test refusal' }
      : actual.createPortfolio(ctx as never, input)),
  }
})

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'
import { ruleFrom } from '../claude-trust.service.js'
import { capMove, capOf } from './ads-portfolio.tools.js'
import { capPolicyOf } from '../../advertising/ads-portfolio.service.js'

const TOOL = 'set-portfolio'
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
const call = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw as Row
const preview = (args: Record<string, unknown>) => call(TOOL, args)
async function ask(args: Record<string, unknown>) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(TOOL, args, claude, run.id, { forceAsk: true })
  })
}
async function approve(approvalId: string, via: 'nexus' | 'nexus-step-up' | 'auto' = 'nexus') {
  if (via !== 'nexus') await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { decisionVia: via } }))
  return inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
}
const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
  const t = getTool(TOOL)!
  return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
}
const portfolio = (externalPortfolioId: string) => inside(() => db().amazonAdsPortfolio.findFirst({ where: { externalPortfolioId } })) as Promise<Row | null>
const inAYear = (days = 365) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    const pf = (externalPortfolioId: string, name: string, extra: Record<string, unknown> = {}) =>
      db().amazonAdsPortfolio.create({ data: { profileId: 'P-IT-TEST', externalPortfolioId, name, state: 'ENABLED', ...extra } })
    await pf('PF-CAP', 'Test capped', { budgetAmount: '500.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'MONTHLY_RECURRING' })
    await pf('PF-OPEN', 'Test open')
    await pf('PF-REN', 'Test rename')
    await pf('PF-ARCHME', 'Test to archive', { budgetAmount: '300.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'MONTHLY_RECURRING' })
    await pf('PF-EMPTY', 'Test empty')
    await pf('PF-ARCH', 'Test archived', { state: 'ARCHIVED' })
    await pf('PF-LIM', 'Test limits')
    // Caps as the other writers store them: the bulk sheet (as typed), a sync of a camelCase answer, an unknown policy.
    await pf('PF-BULK', 'Test bulk sheet', { budgetAmount: '500.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'dateRange', startDate: new Date('2026-01-01T00:00:00Z'), endDate: new Date(`${inAYear(200)}T00:00:00Z`) })
    await pf('PF-SYNC', 'Test synced', { budgetAmount: '400.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'MONTHLYRECURRING' })
    await pf('PF-ODD', 'Test odd', { budgetAmount: '400.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'weekly' })
    await db().amazonAdsPortfolio.create({ data: { profileId: 'local-IT', externalPortfolioId: 'local-pf-local-IT-test-local', name: 'Test local', state: 'ENABLED' } })
    // The fixture's IT campaign sits in the capped portfolio; another in the one to archive.
    await db().campaign.update({ where: { id: 'c-it' }, data: { portfolioId: 'PF-CAP' } })
    await db().campaign.update({ where: { id: 'c-pin' }, data: { portfolioId: 'PF-ARCHME' } })
    await db().campaign.update({ where: { id: 'c-off' }, data: { portfolioId: 'PF-SYNC' } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

describe('the tools as the contract holds them', () => {
  it('set-portfolio: strategy-bound, alwaysAsk, ceiling auto, partly undoable; at ask by default, nothing runs alone by default', () => {
    const tool = getTool(TOOL)!
    expect(tool).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', reversibility: 'partial', openWorld: true, requires: ['ads.campaigns.manage', 'ads.budgets.edit', 'financials.adspend.view'] })
    expect(ruleFrom(tool, null).level).toBe('ask')
    expect(tool.limits!.parse({})).toMatchObject({ maxItems: 1, markets: [], allowCreate: false, allowRename: false, allowArchive: false, maxCapCents: 0 })
    expect(getTool('ad-portfolios')).toMatchObject({ readOnly: true, requires: ['ads.view'], restrictedFields: { capCents: 'financials.adspend.view' } })
  })

  it('pure: a cap raised, its policy changed or its dates widened can add spend; set where none, or lowered, holds it back', () => {
    const cap = (amountCents: number, extra: Record<string, unknown> = {}) => ({ amountCents, currency: 'EUR', policy: 'monthly' as const, startDate: null, endDate: null, ...extra })
    expect(capMove(null, cap(100)).direction).toBe('cut')
    expect(capMove(cap(100), cap(200)).direction).toBe('raise')
    expect(capMove(cap(200), cap(100)).direction).toBe('cut')
    expect(capMove(cap(100), cap(100)).direction).toBe('same')
    expect(capMove(cap(100), cap(50, { policy: 'dateRange', startDate: '2027-01-01', endDate: '2027-01-31' })).direction).toBe('raise')
    expect(capMove(cap(100, { policy: 'dateRange', startDate: '2027-01-01', endDate: '2027-01-31' }), cap(100, { policy: 'dateRange', startDate: '2027-01-01', endDate: '2027-02-28' })).direction).toBe('raise')
    expect(capMove(cap(100), null).direction).toBe('raise')
  })

  it('every stored spelling of a cap policy reads as that policy; anything else, or a cap missing its amount or currency, fails closed', () => {
    for (const raw of ['MONTHLY_RECURRING', 'monthlyRecurring', 'MONTHLYRECURRING', 'monthly_recurring']) expect(capPolicyOf(raw), raw).toBe('MONTHLY_RECURRING')
    for (const raw of ['DATE_RANGE', 'dateRange', 'DATERANGE', 'date range']) expect(capPolicyOf(raw), raw).toBe('DATE_RANGE')
    expect(capPolicyOf('noCap')).toBe('NO_CAP')
    expect(capPolicyOf('weekly')).toBe('weekly')
    expect(capPolicyOf(null)).toBeNull()
    const held = (cap: Record<string, unknown>, fallback: string | null = null) => capOf({ cap: { amountCents: 1000, currency: 'EUR', policy: 'MONTHLY_RECURRING', startDate: null, endDate: null, inBudget: true, ...cap } as never }, fallback)
    expect(held({})).toEqual({ amountCents: 1000, currency: 'EUR', policy: 'monthly', startDate: null, endDate: null })
    expect(held({ currency: null }, 'EUR')).toMatchObject({ policy: 'monthly', currency: 'EUR' })
    for (const [cap, why] of [
      [{ policy: 'weekly' }, /its policy "weekly" is not one Nexus knows/],
      [{ policy: null }, /an amount and no policy/],
      [{ amountCents: null }, /a policy and no amount/],
      [{ currency: null }, /Nexus does not know its currency/],
      [{ policy: 'DATE_RANGE' }, /a date range without its dates/],
    ] as const) {
      const unread = held(cap)
      expect(unread, JSON.stringify(cap)).toMatchObject({ unread: true, why: expect.stringMatching(why) })
      // Fail closed: any change of it, letting it go, or a move to it counts as a raise.
      expect(capMove(unread, { amountCents: 1, currency: 'EUR', policy: 'monthly', startDate: null, endDate: null }).direction).toBe('raise')
      expect(capMove(unread, null).direction).toBe('raise')
      expect(capMove(null, unread).direction).toBe('raise')
      expect(capMove(unread, unread).direction).toBe('same')
    }
  })
})

describe('ad-portfolios', () => {
  it('each portfolio with its market, cap, campaigns and spend; filters; not found', async () => {
    const r = await call('ad-portfolios', { market: 'IT' })
    expect(r.ok, r.error).toBe(true)
    const capped = r.data.items.find((i: Row) => i.portfolioId === 'PF-CAP')
    expect(capped).toMatchObject({
      name: 'Test capped', market: 'IT', state: 'ENABLED', atAmazon: true, currency: 'EUR',
      cap: { capCents: 50000, policy: 'monthly', startDate: null, endDate: null },
      campaigns: { counted: 1, enabled: 1, archived: 0, named: [{ campaignId: 'c-it', name: 'Italy exact', status: 'ENABLED' }] },
      metrics: { spendCents: 0, salesCents: 0, acos: null },
    })
    expect(r.data.items.find((i: Row) => i.portfolioId === 'local-pf-local-IT-test-local')).toMatchObject({ atAmazon: false, market: 'IT' })
    expect((await call('ad-portfolios', { search: 'open' })).data.items.map((i: Row) => i.portfolioId)).toEqual(['PF-OPEN'])
    expect((await call('ad-portfolios', { portfolioId: 'PF-NOPE' })).data).toMatchObject({ items: [], empty: 'Portfolio PF-NOPE not found in this business.' })
  })
})

describe('set-portfolio — create', () => {
  it('previews a new portfolio where it lands; approved, the page\'s own create makes it, on the ads audit; undo archives it', async () => {
    const r = await preview({ op: 'create', market: 'IT', name: 'Test new', why: 'a home for the gloves' })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: TOOL, op: 'create', market: 'IT', currency: 'EUR', raises: [], noCode: expect.any(String), reach: { reach: 'sandbox' },
      changes: [{ label: 'Portfolio', from: null, to: '"Test new" in IT' }],
      limitFacts: { tool: TOOL, action: 'portfolio', this: { items: 1, writes: 1, raises: 0 } },
    })
    // Sandbox: recorded in Nexus only — never "sent to Amazon".
    expect(r.preview.reachNote).toMatch(/^sandbox: /)
    expect(r.preview.reachNote).not.toMatch(/Sent to Amazon/)
    const asked = await ask({ op: 'create', market: 'IT', name: 'Test new', why: 'a home for the gloves' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { name: 'Test new', market: 'IT', mode: 'sandbox', atAmazon: true, changeSetId: asked.approvalId } })
    const made = await portfolio(done.result.portfolioId)
    expect(made).toMatchObject({ name: 'Test new', profileId: 'P-IT-TEST', state: 'ENABLED' })
    const [log] = await inside(() => db().advertisingActionLog.findMany({ where: { executionId: asked.approvalId } })) as Row[]
    expect(log).toMatchObject({ userId: 'user:u-approver', actionType: 'AD_PORTFOLIO_CREATE', entityType: 'PORTFOLIO', entityId: made!.id, amazonResponseStatus: 'SUCCESS' })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: TOOL, args: { op: 'archive', portfolioId: done.result.portfolioId } } })
    // The name is taken in the market now.
    expect((await preview({ op: 'create', market: 'IT', name: 'test NEW' })).error).toMatch(/IT already has a portfolio named "Test new" .*one portfolio per name/)
  })

  it('a cap set with a new one; a bad cap is refused', async () => {
    const r = await preview({ op: 'create', market: 'IT', name: 'Test with cap', cap: { amountCents: 25000, policy: 'monthly' } })
    expect(r.preview).toMatchObject({ changes: [{ label: 'Portfolio' }, { label: 'Budget cap', from: 'no cap', to: 'EUR 250.00 a month' }], capChange: { fromCents: null, toCents: 25000 } })
    expect((await preview({ op: 'create', market: 'IT', name: 'Test bad', cap: { amountCents: 100, policy: 'dateRange', startDate: inAYear() } })).error).toMatch(/a dateRange cap needs both startDate and endDate/)
    expect((await preview({ op: 'create', market: 'IT', name: 'Test bad', cap: { amountCents: 100, policy: 'dateRange', startDate: inAYear(20), endDate: inAYear(10) } })).error).toMatch(/is before its startDate/)
    expect((await preview({ op: 'create', market: 'IT', name: 'Test bad', cap: { amountCents: 100, policy: 'monthly', endDate: inAYear() } })).error).toMatch(/a monthly cap takes no dates/)
    expect((await preview({ op: 'create', market: 'IT', name: 'Test bad', portfolioId: 'PF-OPEN' })).error).toMatch(/names no portfolioId/)
  })
})

describe('set-portfolio — update', () => {
  it('a raised cap is day-to-day (code rule A): listed and said, no code; a plain approve runs the page\'s own push; undo puts the old cap back', async () => {
    const r = await preview({ op: 'update', portfolioId: 'PF-CAP', cap: { amountCents: 80000, policy: 'monthly' } })
    expect(r.preview).toMatchObject({
      changes: [{ label: 'Budget cap', from: 'EUR 500.00 a month', to: 'EUR 800.00 a month' }],
      raises: [{ what: 'Budget cap', why: 'its cap rises from EUR 500.00 a month to EUR 800.00 a month' }],
      noCode: expect.stringMatching(/^It can add spend \(listed in raises\), as a day-to-day change/), portfolio: { portfolioId: 'PF-CAP', campaigns: 1 },
      effect: expect.stringMatching(/It ADDS SPEND \(its cap rises from EUR 500\.00 a month to EUR 800\.00 a month\): a day-to-day change — a person's approval sends it, with no authenticator code\.$/),
    })
    expect(r.preview.stepUp).toBeUndefined()
    // Its limits still judge a run by rule: none by default.
    expect(judge(r.preview)).toBeTypeOf('string')
    const asked = await ask({ op: 'update', portfolioId: 'PF-CAP', cap: { amountCents: 80000, policy: 'monthly' } })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await portfolio('PF-CAP')).toMatchObject({ budgetPolicy: 'MONTHLY_RECURRING', budgetCurrencyCode: 'EUR' })
    expect(Number((await portfolio('PF-CAP'))!.budgetAmount)).toBe(800)
    const [log] = await inside(() => db().advertisingActionLog.findMany({ where: { executionId: asked.approvalId } })) as Row[]
    expect(log).toMatchObject({ actionType: 'AD_PORTFOLIO_UPDATE', entityType: 'PORTFOLIO', payloadBefore: { budgetAmount: 500 }, payloadAfter: { budgetAmount: 800 } })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: TOOL, args: { op: 'update', portfolioId: 'PF-CAP', cap: { amountCents: 50000, policy: 'monthly' } } },
    })
    // Lower again: it holds spend back, no code.
    expect((await preview({ op: 'update', portfolioId: 'PF-CAP', cap: { amountCents: 40000, policy: 'monthly' } })).preview).toMatchObject({ raises: [], noCode: expect.any(String) })
  })

  it('a rename; a cap where there was none (its undo cannot remove the cap); nothing to change; a taken name', async () => {
    const asked = await ask({ op: 'update', portfolioId: 'PF-REN', name: 'Test renamed', cap: { amountCents: 10000, policy: 'monthly' } })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await portfolio('PF-REN')).toMatchObject({ name: 'Test renamed', budgetPolicy: 'MONTHLY_RECURRING' })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: TOOL, args: { op: 'update', portfolioId: 'PF-REN', name: 'Test rename' } } })
    const capOnly = await ask({ op: 'update', portfolioId: 'PF-EMPTY', cap: { amountCents: 10000, policy: 'monthly' } })
    await approve(capOnly.approvalId!)
    expect(await inside(() => undoRequestFor({ approvalId: capOnly.approvalId! }))).toMatchObject({ error: expect.stringMatching(/had no budget cap before, and Nexus cannot remove a cap/) })
    expect((await preview({ op: 'update', portfolioId: 'PF-OPEN' })).error).toMatch(/^Nothing to change for portfolio "Test open"/)
    expect((await preview({ op: 'update', portfolioId: 'PF-OPEN', name: 'Test open' })).error).toMatch(/^Nothing would change: portfolio "Test open" already has the name/)
    expect((await preview({ op: 'update', portfolioId: 'PF-OPEN', name: 'test capped' })).error).toMatch(/IT already has a portfolio named "Test capped"/)
  })

  it('refused, and not queued: not found, archived, made in Nexus only', async () => {
    expect((await preview({ op: 'update', portfolioId: 'PF-NOPE', name: 'x' })).error).toBe('Not queued: portfolio PF-NOPE not found in this business.')
    expect((await preview({ op: 'update', portfolioId: 'PF-ARCH', name: 'x' })).error).toMatch(/is archived: Amazon does not change an archived portfolio/)
    expect((await preview({ op: 'update', portfolioId: 'local-pf-local-IT-test-local', name: 'x' })).error).toMatch(/made in Nexus while writes were closed and Amazon has never seen it/)
  })

  it('a change after approval is not run (stale)', async () => {
    const asked = await ask({ op: 'update', portfolioId: 'PF-OPEN', name: 'Test open stale' })
    await inside(() => db().amazonAdsPortfolio.updateMany({ where: { externalPortfolioId: 'PF-OPEN' }, data: { name: 'Test open moved' } }))
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false })
    expect((await portfolio('PF-OPEN'))!.name).toBe('Test open moved')
  })
})

describe('set-portfolio — archive', () => {
  it('a capped portfolio with campaigns: its campaigns leave the cap (a raise, day-to-day: no code); permanent; no undo', async () => {
    const r = await preview({ op: 'archive', portfolioId: 'PF-ARCHME' })
    expect(r.preview).toMatchObject({
      op: 'archive', changes: [{ label: 'State', from: 'ENABLED', to: 'ARCHIVED' }], permanent: expect.stringMatching(/^PERMANENT/),
      raises: [{ why: 'archiving it lets its 1 campaign spend without its cap (EUR 300.00 a month)' }], noCode: expect.stringMatching(/day-to-day/),
      effect: expect.stringMatching(/It ADDS SPEND \(archiving it lets its 1 campaign spend without its cap/),
    })
    expect(r.preview.stepUp).toBeUndefined()
    expect(judge(r.preview, { markets: ['IT'] })).toBeTypeOf('string')
    const asked = await ask({ op: 'archive', portfolioId: 'PF-ARCHME' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect((await portfolio('PF-ARCHME'))!.state).toBe('ARCHIVED')
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ error: expect.stringMatching(/cannot be brought back/) })
    expect((await preview({ op: 'archive', portfolioId: 'PF-ARCHME' })).error).toMatch(/^Nothing would change: portfolio "Test to archive" is archived already/)
  })
})

describe('a stored cap in another spelling, or one Nexus cannot read: never read as no cap', () => {
  it('the bulk sheet\'s dateRange: a raise is a raise (listed; day-to-day, no code)', async () => {
    const end = (await portfolio('PF-BULK'))!.endDate.toISOString().slice(0, 10)
    const r = await preview({ op: 'update', portfolioId: 'PF-BULK', cap: { amountCents: 80000, policy: 'dateRange', startDate: '2026-01-01', endDate: end } })
    expect(r.preview).toMatchObject({
      changes: [{ label: 'Budget cap', from: `EUR 500.00 from 2026-01-01 to ${end}`, to: `EUR 800.00 from 2026-01-01 to ${end}` }],
      raises: [{ why: expect.stringMatching(/its cap rises/) }], noCode: expect.stringMatching(/day-to-day/),
    })
    expect(r.preview.stepUp).toBeUndefined()
  })

  it('a synced MONTHLYRECURRING cap holding a campaign: archiving it is a raise; so is any change of an unknown policy', async () => {
    expect((await preview({ op: 'archive', portfolioId: 'PF-SYNC' })).preview).toMatchObject({ raises: [{ why: 'archiving it lets its 1 campaign spend without its cap (EUR 400.00 a month)' }], noCode: expect.stringMatching(/day-to-day/) })
    const odd = await preview({ op: 'update', portfolioId: 'PF-ODD', cap: { amountCents: 100, policy: 'monthly' } })
    expect(odd.preview).toMatchObject({
      changes: [{ label: 'Budget cap', from: 'a cap Nexus cannot read (its policy "weekly" is not one Nexus knows)', to: 'EUR 1.00 a month' }],
      raises: [{ why: expect.stringMatching(/Nexus cannot tell whether it lets more spend: it counts as a raise/) }], noCode: expect.stringMatching(/day-to-day/),
    })
    // Its limits still judge it as a raise: it never runs by rule with the defaults.
    expect(judge(odd.preview, { markets: ['IT'] })).toBeTypeOf('string')
    const read = (await call('ad-portfolios', { portfolioId: 'PF-ODD' })).data.items[0]
    expect(read.cap).toMatchObject({ capCents: 40000, policy: 'unreadable', storedPolicy: 'weekly', note: expect.stringMatching(/counts as a raise/) })
  })
})

describe('a create Amazon refused', () => {
  it('is said so, in Amazon\'s words; its audit row is FAILED (approval-status: not sent); it exists in Nexus only and its undo says so', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const asked = await ask({ op: 'create', market: 'IT', name: 'Test REFUSED', cap: { amountCents: 10000, policy: 'monthly' } })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { atAmazon: false, note: expect.stringMatching(/^Amazon refused it \(Amazon says: a test refusal\)/), capNote: expect.stringMatching(/not set: the portfolio is not at Amazon/) } })
    const logs = await inside(() => db().advertisingActionLog.findMany({ where: { executionId: asked.approvalId } })) as Row[]
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ actionType: 'AD_PORTFOLIO_CREATE', amazonResponseStatus: 'FAILED', evidence: { note: 'Amazon refused it: Amazon says: a test refusal' } })
    // approval-status: one write, failed (not sent), and created in Nexus but not at Amazon.
    const { adDeliveryOf } = await import('./approval.tools.js')
    const row = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: asked.approvalId } })) as Row
    expect(await inside(() => adDeliveryOf(asked.approvalId!, TOOL, row.preview))).toMatchObject({ reach: 'live', writes: 1, sent: 0, failed: 1, created: { total: 1, atAmazon: 0 } })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ error: expect.stringMatching(/made in Nexus only; there is nothing at Amazon to archive/) })
  })
})

describe('the other doors: undo-ad-change is no way around set-portfolio', () => {
  it('refuses a portfolio change set and points to undo-change', async () => {
    const asked = await ask({ op: 'update', portfolioId: 'PF-LIM', name: 'Test limits undo' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect((await call('undo-ad-change', { changeSetId: asked.approvalId })).error).toMatch(/^Not undone: it holds a portfolio change \(set-portfolio\), which undo-ad-change cannot put back/)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: TOOL, args: { op: 'update', portfolioId: 'PF-LIM', name: 'Test limits' } } })
  })
})

describe('the limits: nothing runs alone by default; inside the strategy and the limits, it may', () => {
  it('markets, create, rename, archive and the cap each wait for a person unless the limits allow them', async () => {
    const row = await inside(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 0 } }))
    try {
      const create = (await preview({ op: 'create', market: 'IT', name: 'Test by rule' })).preview
      expect(judge(create)).toMatch(/names no market where a portfolio change may run by rule/)
      expect(judge(create, { markets: ['IT'] })).toMatch(/runs by rule only with allowCreate/)
      expect(judge(create, { markets: ['IT'], allowCreate: true })).toBeNull()
      const rename = (await preview({ op: 'update', portfolioId: 'PF-LIM', name: 'Test limits 2' })).preview
      expect(judge(rename, { markets: ['IT'] })).toMatch(/runs by rule only with allowRename/)
      expect(judge(rename, { markets: ['IT'], allowRename: true })).toBeNull()
      const cap = (await preview({ op: 'update', portfolioId: 'PF-LIM', cap: { amountCents: 20000, policy: 'monthly' } })).preview
      expect(judge(cap, { markets: ['IT'] })).toMatch(/above the EUR 0.00 this tool's limits allow by rule \(0: every cap change waits for a person\)/)
      expect(judge(cap, { markets: ['IT'], maxCapCents: 20000 })).toBeNull()
      const archive = (await preview({ op: 'archive', portfolioId: 'PF-LIM' })).preview
      expect(judge(archive, { markets: ['IT'] })).toMatch(/runs by rule only with allowArchive/)
      // The strategy narrows the kind: portfolio held at ask in the market.
      await inside(() => db().adsStrategy.update({ where: { id: row.id }, data: { claudeAutonomy: { portfolio: 'ask' }, version: 2 } }))
      expect(judge((await preview({ op: 'update', portfolioId: 'PF-LIM', name: 'Test limits 3' })).preview, { markets: ['IT'], allowRename: true })).toMatch(/lets Claude only ask for creating and changing portfolios/)
    } finally {
      await inside(() => db().adsStrategy.delete({ where: { id: row.id } }))
    }
  })

  it('live: lands on the market\'s profile', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview({ op: 'update', portfolioId: 'PF-LIM', name: 'Test live' })).preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' } })
    expect((await preview({ op: 'create', market: 'IT', name: 'Test live new' })).preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' } })
  })
})
