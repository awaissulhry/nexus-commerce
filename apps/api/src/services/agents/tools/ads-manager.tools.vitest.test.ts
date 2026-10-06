/**
 * ADS AUTONOMY W4-1 — report-ads-run and ads-manager-runs, through the doors Claude and a person use (runOrQueueTool,
 * then scheduleApproval + commitScheduledApproval as the Approvals page and the sweep run them), on PGlite with the
 * production schema and business policies. The ads-overview builder is a stand-in with made-up figures: a report's
 * numbers must be exactly the builder's, whatever Claude writes.
 *
 *   contract   ceiling auto, limits allowEmail, partial (an e-mail stays sent), Nexus only, Claude's door only
 *   start      the record is one AgentRun (id = the start's approvalId, claude-ads-manager, schedule, mode and via null)
 *   finish     Nexus's figures and Nexus's reading of each named approval; one bell notice; one e-mail
 *   words      a line with an amount or a percentage is refused; nothing is queued
 *   one a day  a second report the same day sends no second e-mail
 *   problems   a danger notice, never deduped
 *   undo       the notice taken back, the run withdrawn, no e-mail sent again
 *   business   another business's run and approvals are not found; its runs are not listed
 *   history    ads-manager-runs reads each named approval's fate again now
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, adsSyncQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))

/** The ads-overview builder, with made-up figures (no business numbers in this public repo). */
const OVERVIEW = {
  channel: 'amazon',
  dataAsOf: '2026-10-05',
  window: { from: '2026-09-29', to: '2026-10-05', days: 7, provisionalFrom: '2026-10-03', note: 'test' },
  markets: [{
    market: 'IT',
    currency: 'EUR',
    dataAsOf: '2026-10-05',
    connection: null,
    campaigns: { total: 3, enabled: 2, liveWritesAllowed: 1, bidsSuppressed: 0 },
    totals: { impressions: 1000, clicks: 70, orders: 7, spendCents: 7000, salesCents: 28000, acos: 0.25, roas: 4 },
    previous: { from: '2026-09-22', to: '2026-09-28', impressions: 900, clicks: 60, orders: 5, spendCents: 6000, salesCents: 20000, acos: 0.3, roas: 3.3 },
    days: [
      { date: '2026-10-04', provisional: true, impressions: 100, clicks: 10, orders: 1, spendCents: 1000, salesCents: 4000 },
      { date: '2026-10-05', provisional: true, impressions: 120, clicks: 12, orders: 2, spendCents: 1234, salesCents: 5678 },
    ],
    topCampaigns: [],
  }],
  automation: {},
  pipeline: {},
}
const overview = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./ads-read.tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ads-read.tools.js')>()),
  amazonOverview: vi.fn(async () => {
    overview.calls += 1
    return OVERVIEW
  }),
}))
const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string | string[]; subject: string; html: string; text?: string }> }))
vi.mock('../../email/transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../email/transport.js')>()),
  sendEmail: vi.fn(async (message: { to: string | string[]; subject: string; html: string; text?: string }) => {
    mail.sent.push(message)
    return { ok: true, provider: 'resend', dryRun: false, messageId: `test-${mail.sent.length}` }
  }),
}))

import { runOrQueueTool } from '../approval-gate.service.js'
import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'
import { ADS_MANAGER_AGENT_KEY, ADS_RUN_NOTICE_TYPE } from '../ads-manager-run.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'w4_ads_report_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { approver: '', ranAuto: '', waiting: '', declined: '', watched: '', bApproval: '', bRun: '' }

const person = (permissions: Set<string>, workspaceId = A): UserPrincipal => ({
  kind: 'user', userId: ids.approver, label: 'Rita Report', permissions: { isOwner: false, permissions }, workspace: business(workspaceId), via: 'claude', oauthGrantId: 'grant-w4',
})
const db = () => database.client

async function ask(tool: string, args: Record<string, unknown>, workspaceId = A) {
  const who = person(EVERYTHING, workspaceId)
  const run = await inside(() => db().agentRun.create({
    data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: 'claude', oauthGrantId: 'grant-w4' },
  }), workspaceId)
  return inside(() => runOrQueueTool(tool, args, who, run.id, { forceAsk: true }), workspaceId)
}
async function approveAndRun(approvalId: string, workspaceId = A) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: { ...person(EVERYTHING, workspaceId), via: 'app' } }), workspaceId)
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }), workspaceId)
  return inside(() => commitScheduledApproval(approvalId), workspaceId)
}
async function askAndRun(tool: string, args: Record<string, unknown>, workspaceId = A) {
  const queued = await ask(tool, args, workspaceId)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(queued.approvalId!, workspaceId)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return queued
}
async function dryRun(who: UserPrincipal, tool: string, args: Record<string, unknown>) {
  try {
    return { result: (await callTool(who, tool, args)).visible, refused: null as ToolAccessError | null }
  } catch (error) {
    if (error instanceof ToolAccessError) return { result: null, refused: error }
    throw error
  }
}
const record = (id: string, workspaceId = A) => inside(() => db().agentRun.findUnique({ where: { id } }), workspaceId)
const notices = (runId: string) => inside(() => db().notification.findMany({ where: { type: ADS_RUN_NOTICE_TYPE, meta: { path: ['runId'], equals: runId } } }))
const pendingCount = () => inside(() => db().agentApproval.count({ where: { status: 'pending' } }))
/** An approval of this business in a given state, hanging off a Claude call. */
async function approvalOf(data: { toolName: string; status: string; decisionVia?: string; ruleVerdict?: unknown; reason?: string }, workspaceId = A) {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'done', userId: ids.approver, via: 'claude' } })
    const row = await db().agentApproval.create({
      data: { agentRunId: run.id, toolName: data.toolName, riskTier: 'high', args: {}, status: data.status, decisionVia: data.decisionVia ?? null, reason: data.reason ?? null, ruleVerdict: (data.ruleVerdict ?? undefined) as never },
    })
    return row.id
  }, workspaceId)
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('NEXUS_ADS_DIGEST_RECIPIENTS', 'owner@example.test')
  const client = database.client
  const role = await client.role.create({
    data: { key: `W4_1_${randomUUID().slice(0, 8)}`, name: 'Reporter', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Rita Report' } })
  ids.approver = approver.id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo report business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  ids.ranAuto = await approvalOf({ toolName: 'set-target-bid', status: 'executed', decisionVia: 'auto' })
  ids.waiting = await approvalOf({ toolName: 'submit-change-plan', status: 'pending' })
  ids.declined = await approvalOf({ toolName: 'set-campaign-budget', status: 'rejected', decisionVia: 'nexus' })
  ids.watched = await approvalOf({ toolName: 'bulk-ad-bid-change', status: 'pending', ruleVerdict: { wouldRun: true, check: null, why: 'inside every limit' } })
  ids.bApproval = await approvalOf({ toolName: 'set-target-bid', status: 'pending' }, B)
  ids.bRun = await inside(async () => (await db().agentRun.create({ data: { agentKey: ADS_MANAGER_AGENT_KEY, trigger: 'schedule', status: 'running' } })).id, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => {
  overview.calls = 0
})

describe('W4-1 — the tool contract', () => {
  it('report-ads-run: Claude\'s door only, Nexus only, ceiling auto inside allowEmail, partly undoable', () => {
    const tool = getTool('report-ads-run')!
    expect(tool).toMatchObject({
      readOnly: false, openWorld: false, reversibility: 'partial', maxClaudeTrust: 'auto', surfaces: ['mcp'],
      requires: [F.adsView, FIELDS.financialsAdspendView],
    })
    expect(tool.limits!.parse({})).toEqual({ allowEmail: true })
    const withEmail = { action: 'report-ads-run', op: 'finish', email: { send: true } }
    expect(tool.withinLimits!(withEmail, { allowEmail: true })).toBeNull()
    expect(tool.withinLimits!(withEmail, { allowEmail: false })).toMatch(/e-mail/)
    expect(tool.withinLimits!({ ...withEmail, email: { send: false } }, { allowEmail: false })).toBeNull()
    expect(tool.withinLimits!(null, { allowEmail: true })).toMatch(/no preview/)
    expect(getTool('ads-manager-runs')).toMatchObject({ readOnly: true, requires: [F.adsView] })
  })

  it('a person without the ad-spend money permission cannot report (its figures are money)', async () => {
    const without = new Set([...EVERYTHING].filter((p) => p !== FIELDS.financialsAdspendView))
    expect((await dryRun(person(without), 'report-ads-run', { op: 'start' })).refused?.code).toBe('forbidden')
  })
})

describe('W4-1 — a run, start to finish', { timeout: TIMEOUT }, () => {
  let runId = ''

  it('start: the dry run says what the business set and writes nothing; run, it is one AgentRun of its own', async () => {
    const preview = await dryRun(person(EVERYTHING), 'report-ads-run', { op: 'start' })
    expect(preview.result).toMatchObject({ ok: true, preview: { op: 'start', run: null, mode: 'ask', facts: { paused: false, levels: { ask: expect.arrayContaining(['set-target-bid']) } } } })
    const queued = await askAndRun('report-ads-run', { op: 'start' })
    runId = queued.approvalId!
    const row = await record(runId)
    expect(row).toMatchObject({ id: runId, agentKey: ADS_MANAGER_AGENT_KEY, trigger: 'schedule', status: 'running', mode: null, via: null, userId: ids.approver })
    expect((row!.input as { start: { mode: string } }).start.mode).toBe('ask')
    // A start sends nothing.
    expect(await notices(runId)).toEqual([])
    expect(mail.sent).toHaveLength(0)
  })

  it('finish: every figure is the builder\'s and every count is Nexus\'s reading of the approvals, not Claude\'s lists', async () => {
    const args = {
      op: 'finish', runId,
      markets: [{ market: 'it', lines: ['Lowered bids on two wasteful terms', 'Three campaigns hit their budget early'] }],
      // Claude lists the waiting plan as "ran by rule": Nexus says otherwise.
      ranByRule: [ids.ranAuto, ids.waiting], waiting: [ids.declined], wouldDo: [ids.watched],
      nextFocus: 'Check the new exact keywords after three days',
    }
    const dry = await dryRun(person(EVERYTHING), 'report-ads-run', args)
    const preview = (dry.result as { preview: Record<string, any> }).preview
    expect(preview.markets).toEqual([{ market: 'IT', lines: args.markets[0].lines, figures: expect.objectContaining({
      currency: 'EUR', dataAsOf: '2026-10-05',
      lastDay: { date: '2026-10-05', provisional: true, spendCents: 1234, salesCents: 5678, orders: 2, clicks: 12, acos: 1234 / 5678 },
      last7Days: expect.objectContaining({ spendCents: 7000, salesCents: 28000, acos: 0.25 }),
      previous7Days: expect.objectContaining({ spendCents: 6000, salesCents: 20000, acos: 0.3 }),
    }) }])
    expect(preview.counts).toEqual({ ranByRule: 1, waitingForYou: 2, wouldHaveRun: 1, declined: 1, expired: 0 })
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`${ids.waiting}: listed as run by rule`)), expect.stringMatching(new RegExp(`${ids.declined}: listed as waiting`))]))
    expect(preview.email).toEqual({ send: true, recipients: 1, why: null })
    expect(preview.notice).toEqual({ severity: 'info', title: 'Claude ads run · 1 ran by rule · 2 wait for you' })
    expect(await record(runId)).toMatchObject({ status: 'running' })

    await askAndRun('report-ads-run', args)
    const row = await record(runId)
    expect(row).toMatchObject({ status: 'done', ok: true })
    const output = row!.output as Record<string, any>
    expect(output.markets[0].figures.last7Days.spendCents).toBe(7000)
    expect(output.notice).toMatchObject({ severity: 'info' })
    expect(output.email).toMatchObject({ status: 'sent', recipients: 1 })
    const bell = await notices(runId)
    expect(bell.filter((n) => n.userId === ids.approver)).toHaveLength(1)
    expect(bell[0]).toMatchObject({ severity: 'info', title: 'Claude ads run · 1 ran by rule · 2 wait for you', href: '/fleet/approvals' })
    // The bell and the e-mail say the builder's figures in money words.
    expect(bell[0].body).toContain('€12.34 spend')
    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0].to).toEqual(['owner@example.test'])
    expect(mail.sent[0].subject).toMatch(/^Claude ads · .+ — 1 ran, 2 wait for you$/)
    expect(mail.sent[0].html).toContain('€70.00 spend')
    expect(mail.sent[0].html).toMatch(new RegExp(`https://web\\.example\\.test/(w/[^/]+/)?fleet/approvals\\?item=${ids.waiting}`))
    // Every approval the report names is in the e-mail, the declined one too.
    expect(mail.sent[0].html).toContain('a person declined it')
  })

  it('a run reports its end once', async () => {
    const again = await ask('report-ads-run', { op: 'finish', runId })
    expect(again).toMatchObject({ ok: false })
    expect(again.error).toMatch(/already finished/)
  })

  it('history: ads-manager-runs reads each named approval again now', async () => {
    await inside(() => db().agentApproval.update({ where: { id: ids.waiting }, data: { status: 'expired' } }))
    const read = await dryRun(person(EVERYTHING), 'ads-manager-runs', { days: 7 })
    const data = (read.result as { data: Record<string, any> }).data
    const run = data.runs.find((r: { runId: string }) => r.runId === runId)
    expect(run).toMatchObject({ status: 'done', mode: 'ask', counts: { ranByRule: 1 } })
    expect(run.approvals.find((a: { approvalId: string }) => a.approvalId === ids.waiting)).toMatchObject({ fate: 'expired', whenReported: 'waiting' })
    expect(data.fatesNow).toMatchObject({ ran: 1, expired: 1, declined: 1, waiting: 1 })
    expect(data.watchWeek).toMatchObject({ comparison: null })
    // A person without the money permissions reads the same runs without the figures.
    const without = new Set([...EVERYTHING].filter((p) => !p.startsWith('financials.')))
    const plain = ((await dryRun(person(without), 'ads-manager-runs', { days: 7 })).result as { data: Record<string, any> }).data
    const figures = plain.runs.find((r: { runId: string }) => r.runId === runId).markets[0].figures
    expect(figures.last7Days.spendCents).toBeUndefined()
    expect(figures.last7Days.orders).toBe(7)
  })

  it('undo: the notice is taken back and the run withdrawn; no e-mail goes again', async () => {
    const finish = await inside(() => db().agentApproval.findFirstOrThrow({ where: { toolName: 'report-ads-run', status: 'executed', args: { path: ['op'], equals: 'finish' } } }))
    const asked = await ask('undo-change', { approvalId: finish.id })
    expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued' })
    const ran = await approveAndRun(asked.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    expect(await notices(runId)).toEqual([])
    const row = await record(runId)
    expect(row).toMatchObject({ status: 'cancelled' })
    expect((row!.output as { withdrawnAt?: string }).withdrawnAt).toEqual(expect.any(String))
    expect(mail.sent).toHaveLength(1)
  })
})

describe('W4-1 — refusals, the day\'s one e-mail, problems', { timeout: TIMEOUT }, () => {
  it('a line with an amount or a percentage is refused, and nothing is queued', async () => {
    const before = await pendingCount()
    for (const line of ['Spend was €40 yesterday', 'ACoS moved to 31%', 'cut 12.50 EUR of waste']) {
      const refused = await ask('report-ads-run', { op: 'finish', markets: [{ market: 'IT', lines: [line] }] })
      expect(refused, line).toMatchObject({ ok: false })
      expect(refused.error).toMatch(/amount or a percentage/)
    }
    expect((await ask('report-ads-run', { op: 'finish', problems: ['ACoS above 40 % in IT'] })).error).toMatch(/amount or a percentage/)
    expect(await pendingCount()).toBe(before)
  })

  it('a market, a run or an approval this business does not have is not found', async () => {
    expect((await ask('report-ads-run', { op: 'finish', markets: [{ market: 'SE', lines: [] }] })).error).toMatch(/Amazon market SE not found in this business \(its Amazon ad markets: IT\)/)
    expect((await ask('report-ads-run', { op: 'finish', runId: ids.bRun })).error).toMatch(/not found in this business/)
    expect((await ask('report-ads-run', { op: 'finish', waiting: [ids.bApproval] })).error).toMatch(/not found in this business/)
    expect((await ask('report-ads-run', { op: 'withdraw', runId: ids.bRun })).error).toMatch(/not found in this business/)
    expect((await ask('report-ads-run', { op: 'start', runId: 'x' })).error).toMatch(/start takes no runId/)
  })

  it('a report without a start is recorded too; the day\'s e-mail went already, so this one sends none', async () => {
    const sent = mail.sent.length
    const dry = await dryRun(person(EVERYTHING), 'report-ads-run', { op: 'finish', markets: [{ market: 'IT', lines: ['Nothing to change'] }] })
    expect((dry.result as { preview: { email: unknown } }).preview.email).toEqual({ send: false, recipients: 1, why: 'today\'s report e-mail already went (one a day)' })
    const queued = await askAndRun('report-ads-run', { op: 'finish', markets: [{ market: 'IT', lines: ['Nothing to change'] }] })
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: queued.approvalId! } }))
    const runId = (change.after as { runId: string }).runId
    expect(runId).not.toBe(queued.approvalId)
    const row = await record(runId)
    expect(row).toMatchObject({ agentKey: ADS_MANAGER_AGENT_KEY, status: 'done' })
    expect((row!.output as { email: { status: string } }).email.status).toBe('skipped')
    expect(mail.sent).toHaveLength(sent)
  })

  it('a problem makes it a danger notice, and a danger notice is never deduped', async () => {
    const args = { op: 'fail', problems: ['The search-term report was too old to judge'] }
    const first = await askAndRun('report-ads-run', args)
    const second = await askAndRun('report-ads-run', args)
    const rows = await inside(() => db().notification.findMany({ where: { type: ADS_RUN_NOTICE_TYPE, severity: 'danger', userId: ids.approver } }))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ title: 'Claude ads run failed · 1 problem · 0 ran by rule · 0 wait for you' })
    expect(first.approvalId).not.toBe(second.approvalId)
    const failed = await inside(() => db().agentRun.findMany({ where: { agentKey: ADS_MANAGER_AGENT_KEY, status: 'failed' } }))
    expect(failed).toHaveLength(2)
    expect(failed[0]).toMatchObject({ ok: false, errorMessage: 'The search-term report was too old to judge' })
  })

  it('another business\'s runs are not listed', async () => {
    const read = await dryRun(person(EVERYTHING), 'ads-manager-runs', { days: 30 })
    const runIds = ((read.result as { data: { runs: Array<{ runId: string }> } }).data.runs).map((r) => r.runId)
    expect(runIds).not.toContain(ids.bRun)
    const inB = await inside(() => callTool(person(EVERYTHING, B), 'ads-manager-runs', { days: 30 }), B)
    expect(((inB.visible as { data: { runs: Array<{ runId: string }> } }).data.runs).map((r) => r.runId)).toEqual([ids.bRun])
  })
})
