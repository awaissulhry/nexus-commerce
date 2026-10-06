/**
 * ADS AUTONOMY W4-1 — report-ads-run and ads-manager-runs, through Claude's own door (runToolForClaude, the gate) on a
 * watch-week connection (nexus.read + nexus.write, no nexus.run), on PGlite with the production schema and business
 * policies. The ads-overview builder is a stand-in with made-up figures: a report's numbers must be exactly the
 * builder's, whatever Claude writes.
 *
 *   contract   a journal (runs at once, never a request), ceiling ask (offered or not), partial (an e-mail stays sent),
 *              Nexus only, Claude's door only
 *   start      at once, no nexus.run needed: one AgentRun (claude-ads-manager, schedule, mode and via null), its runId
 *   finish     Nexus's figures and Nexus's reading of each named approval; one bell notice; one e-mail
 *   door       runs during a Pause; off for Claude, refused
 *   words      a line with an amount or a percentage is refused; nothing is recorded
 *   one a day  a second report the same day sends no second e-mail
 *   problems   a danger notice, never deduped
 *   withdraw   the notice taken back, the run withdrawn, no e-mail sent again
 *   recipients the digest list, else this business's own people who may see its ad money (never another business's)
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

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { ADS_MANAGER_AGENT_KEY, ADS_RUN_NOTICE_TYPE, reportRecipients } from '../ads-manager-run.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'w4_ads_report_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { approver: '', noMoney: '', bOnly: '', ranAuto: '', waiting: '', declined: '', watched: '', bApproval: '', bRun: '' }
const names = { A: '', B: 'Bravo report business' }
/** The scheduled run's connection in the watch week: it may read and write, never run by rule (no nexus.run). */
const WATCH_WEEK = ['nexus.read', 'nexus.write']

const person = (permissions: Set<string>, workspaceId = A): UserPrincipal => ({
  kind: 'user', userId: ids.approver, label: 'Rita Report', permissions: { isOwner: false, permissions }, workspace: business(workspaceId), via: 'claude', oauthGrantId: 'grant-w4',
})
const claude = (workspaceId = A, scopes = WATCH_WEEK): McpPrincipal => ({
  ...person(EVERYTHING, workspaceId), business: { id: workspaceId, name: workspaceId === A ? names.A : names.B }, scopes,
}) as McpPrincipal
const db = () => database.client

/** One tools/call of report-ads-run as Claude makes it (the real door), and the JSON Claude reads. */
async function report(args: Record<string, unknown>, who = claude()) {
  const result = await runToolForClaude(who, getTool('report-ads-run')!, { ...args, business: who.business.name })
  const answer = JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
  return { isError: !!result.isError, answer }
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
/** Only a withdraw of a report waits as a request: start, finish and fail are journal entries. */
const reportRequests = () => inside(() => db().agentApproval.count({ where: { toolName: 'report-ads-run' } }))
/** A person approves a request in Nexus and the sweep runs it. */
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: { ...person(EVERYTHING), via: 'app' } }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}
/** This business's runs (and their reports) move 26 hours back: a new operator day, the day's caps start again. */
async function anotherDay() {
  await inside(async () => {
    const back = (at: Date | string) => new Date(new Date(at).getTime() - 26 * 3600_000)
    for (const row of await db().agentRun.findMany({ where: { agentKey: ADS_MANAGER_AGENT_KEY } })) {
      const out = row.output as Record<string, unknown> | null
      await db().agentRun.update({
        where: { id: row.id },
        data: { createdAt: back(row.createdAt), ...(out && typeof out.reportedAt === 'string' ? { output: { ...out, reportedAt: back(out.reportedAt).toISOString() } as never } : {}) },
      })
    }
  })
}
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
  names.A = (await client.workspace.findUniqueOrThrow({ where: { id: A }, select: { name: true } })).name
  // E-mail fallback: one who may see ads but not their money (in A), and one of B only (who may see both).
  const adsOnly = await client.role.create({ data: { key: `W4_1_ADS_${randomUUID().slice(0, 8)}`, name: 'Ads only', description: 'test', isSystem: false, permissions: [F.adsView] } })
  const noMoney = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'No Money' } })
  ids.noMoney = noMoney.id
  await client.userRole.create({ data: { userId: noMoney.id, roleId: adsOnly.id } })
  const noMoneyIn = await client.workspaceMembership.create({ data: { workspaceId: A, userId: noMoney.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: noMoneyIn.id, roleId: adsOnly.id } })
  const bOnly = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Bravo Only' } })
  ids.bOnly = bOnly.id
  const bOnlyIn = await client.workspaceMembership.create({ data: { workspaceId: B, userId: bOnly.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: bOnlyIn.id, roleId: role.id } })
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
  it('report-ads-run: a journal (it runs at once, no request), Claude\'s door only, Nexus only, partly undoable', () => {
    const tool = getTool('report-ads-run')!
    expect(tool).toMatchObject({
      readOnly: false, openWorld: false, journal: true, reversibility: 'partial', maxClaudeTrust: 'ask', surfaces: ['mcp'],
      requires: [F.adsView, FIELDS.financialsAdspendView],
    })
    expect(tool.limits).toBeUndefined()
    expect(getTool('ads-manager-runs')).toMatchObject({ readOnly: true, requires: [F.adsView] })
  })

  it('a person without the ad-spend money permission cannot report (its figures are money)', async () => {
    const without = new Set([...EVERYTHING].filter((p) => p !== FIELDS.financialsAdspendView))
    expect((await dryRun(person(without), 'report-ads-run', { op: 'start' })).refused?.code).toBe('forbidden')
  })
})

describe('W4-1 — a run, start to finish, on a watch-week connection (no nexus.run)', { timeout: TIMEOUT }, () => {
  let runId = ''

  it('start runs at once: one AgentRun of its own, its runId in the answer, no request waiting', async () => {
    const { isError, answer } = await report({ op: 'start' })
    expect(isError, JSON.stringify(answer)).toBe(false)
    expect(answer).toMatchObject({ status: 'running', recorded: true, mode: 'ask', facts: { paused: false, levels: { ask: expect.arrayContaining(['set-target-bid']) } } })
    runId = answer.runId
    const row = await record(runId)
    expect(row).toMatchObject({ id: runId, agentKey: ADS_MANAGER_AGENT_KEY, trigger: 'schedule', status: 'running', mode: null, via: null, userId: ids.approver })
    expect((row!.input as { start: { mode: string } }).start.mode).toBe('ask')
    expect(await reportRequests()).toBe(0)
    // The call itself is on record as every Claude call is; a start sends nothing.
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

    const { isError, answer } = await report(args)
    expect(isError, JSON.stringify(answer)).toBe(false)
    expect(answer).toMatchObject({ runId, status: 'done', counts: { ranByRule: 1, waitingForYou: 2 }, email: { status: 'sent', recipients: 1 } })
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
    expect(await reportRequests()).toBe(0)
  })

  it('a run reports its end once', async () => {
    const again = await report({ op: 'finish', runId })
    expect(again.isError).toBe(true)
    expect(again.answer.error).toMatch(/already finished/)
  })

  it('history: ads-manager-runs reads each named approval again now', async () => {
    await inside(() => db().agentApproval.update({ where: { id: ids.waiting }, data: { status: 'expired' } }))
    const read = await dryRun(person(EVERYTHING), 'ads-manager-runs', { days: 7 })
    const data = (read.result as { data: Record<string, any> }).data
    const run = data.runs.find((r: { runId: string }) => r.runId === runId)
    expect(run).toMatchObject({ status: 'done', mode: 'ask', counts: { ranByRule: 1 } })
    expect(run.approvals.find((a: { approvalId: string }) => a.approvalId === ids.waiting)).toMatchObject({ fate: 'expired', whenReported: 'waiting' })
    expect(data.fatesNow).toMatchObject({ ran: 1, expired: 1, declined: 1, waiting: 1 })
    // W4-5 — the watch week: the request asked at watch is read back with its verdict (its preview names no entity).
    expect(data.watchWeek).toMatchObject({
      label: 'observed, not proof of cause', totalSteps: 1,
      steps: [{ approvalId: ids.watched, tool: 'bulk-ad-bid-change', verdict: { wouldRun: true, meaning: 'would have run by rule' }, items: [] }],
      table: [{ action: 'bid', steps: 1, wouldRun: 1 }],
    })
    // A person without the money permissions reads the same runs without the figures.
    const without = new Set([...EVERYTHING].filter((p) => !p.startsWith('financials.')))
    const plain = ((await dryRun(person(without), 'ads-manager-runs', { days: 7 })).result as { data: Record<string, any> }).data
    const figures = plain.runs.find((r: { runId: string }) => r.runId === runId).markets[0].figures
    expect(figures.last7Days.spendCents).toBeUndefined()
    expect(figures.last7Days.orders).toBe(7)
  })

  it('withdraw is a request a person approves: then the notice is taken back and the run marked withdrawn; no e-mail goes again', async () => {
    const bell = (await notices(runId)).length
    expect(bell).toBeGreaterThan(0)
    const { isError, answer } = await report({ op: 'withdraw', runId })
    expect(isError, JSON.stringify(answer)).toBe(false)
    expect(answer).toMatchObject({ status: 'waiting_for_approval', approvalId: expect.any(String) })
    expect(await reportRequests()).toBe(1)
    expect(await notices(runId)).toHaveLength(bell)
    const ran = await approveAndRun(answer.approvalId)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    expect(await notices(runId)).toEqual([])
    const row = await record(runId)
    expect(row).toMatchObject({ status: 'cancelled' })
    expect((row!.output as { withdrawnAt?: string }).withdrawnAt).toEqual(expect.any(String))
    expect(mail.sent).toHaveLength(1)
    expect((await report({ op: 'withdraw', runId })).answer.error).toMatch(/already withdrawn/)
  })
})

describe('W4-1 — the journal\'s door: Pause, off, refusals', { timeout: TIMEOUT }, () => {
  it('it runs during a Pause (nothing of the business changes); turned off for Claude, it is refused', async () => {
    await inside(() => db().agentAutonomy.create({ data: { autoPausedAt: new Date(), autoPausedBy: 'Rita Report', pauseReason: 'test' } }))
    const paused = await report({ op: 'start' })
    expect(paused.isError, JSON.stringify(paused.answer)).toBe(false)
    expect(paused.answer).toMatchObject({ status: 'running', mode: 'paused' })
    await inside(() => db().agentAutonomy.deleteMany({}))
    await inside(() => db().agentRun.update({ where: { id: paused.answer.runId }, data: { status: 'done', endedAt: new Date() } }))
    await inside(() => db().agentTool.create({ data: { name: 'report-ads-run', claudeTrust: 'off' } }))
    const off = await report({ op: 'start' })
    expect(off.isError).toBe(true)
    expect(off.answer.error).toMatch(/turned off for Claude/)
    await inside(() => db().agentTool.deleteMany({ where: { name: 'report-ads-run' } }))
  })

  it('a number next to a money or metric word, or a link, is refused; nothing is recorded; counts of other things are words', async () => {
    const runs = await inside(() => db().agentRun.count({ where: { agentKey: ADS_MANAGER_AGENT_KEY } }))
    const figures = [
      'Spend was €40 yesterday', 'ACoS moved to 31%', 'cut 12.50 EUR of waste', 'spent 12 euros on one term', 'ACoS 31 in IT',
      'saved 45 cents a click', 'spend 1,200 this week', 'ACoS was 31 today', 'ROAS of about 3.5', '3 orders came in', 'bids at 0.80',
    ]
    for (const line of figures) {
      const refused = await report({ op: 'finish', markets: [{ market: 'IT', lines: [line] }] })
      expect(refused.isError, line).toBe(true)
      expect(refused.answer.error, line).toMatch(/amount or a percentage/)
    }
    for (const line of ['see https://example.test/x', 'details on www.example.test', 'look at example.com']) {
      expect((await report({ op: 'finish', markets: [{ market: 'IT', lines: [line] }] })).answer.error, line).toMatch(/holds a link/)
    }
    expect((await report({ op: 'finish', problems: ['ACoS above 40 % in IT'] })).answer.error).toMatch(/amount or a percentage/)
    expect((await report({ op: 'finish', nextFocus: 'Check budget 25 again' })).answer.error).toMatch(/amount or a percentage/)
    expect(await inside(() => db().agentRun.count({ where: { agentKey: ADS_MANAGER_AGENT_KEY } }))).toBe(runs)
    // The control: counts of other things are words, and the same report passes.
    const plain = await dryRun(person(EVERYTHING), 'report-ads-run', { op: 'finish', markets: [{ market: 'IT', lines: ['Lowered bids on 2 terms', '3 campaigns hit their budget early'] }] })
    expect(plain.result).toMatchObject({ ok: true })
  })

  it('a market, a run or an approval this business does not have is not found', async () => {
    expect((await report({ op: 'finish', markets: [{ market: 'SE', lines: [] }] })).answer.error).toMatch(/Amazon market SE not found in this business \(its Amazon ad markets: IT\)/)
    expect((await report({ op: 'finish', runId: ids.bRun })).answer.error).toMatch(/not found in this business/)
    expect((await report({ op: 'finish', waiting: [ids.bApproval] })).answer.error).toMatch(/not found in this business/)
    expect((await report({ op: 'withdraw', runId: ids.bRun })).answer.error).toMatch(/not found in this business/)
    expect((await report({ op: 'start', runId: 'x' })).answer.error).toMatch(/start takes no runId/)
    // B's run is untouched.
    expect(await record(ids.bRun, B)).toMatchObject({ status: 'running' })
  })
})

describe('W4-1 — the day\'s caps', { timeout: TIMEOUT }, () => {
  it(`no start while a run started in the last 2 hours is open; at most ${3} runs a day, with or without a start`, async () => {
    await anotherDay()
    const first = await report({ op: 'start' })
    expect(first.answer, JSON.stringify(first.answer)).toMatchObject({ status: 'running' })
    const second = await report({ op: 'start' })
    expect(second.isError).toBe(true)
    expect(second.answer.error).toMatch(new RegExp(`Run ${first.answer.runId} started at .* and is still open`))
    expect((await report({ op: 'finish', runId: first.answer.runId })).answer).toMatchObject({ status: 'done' })
    for (let i = 0; i < 2; i++) {
      const next = await report({ op: 'start' })
      expect(next.answer, JSON.stringify(next.answer)).toMatchObject({ status: 'running' })
      expect((await report({ op: 'finish', runId: next.answer.runId })).answer).toMatchObject({ status: 'done' })
    }
    const fourth = await report({ op: 'start' })
    expect(fourth.isError).toBe(true)
    expect(fourth.answer.error).toMatch(/recorded 3 daily Claude ads runs today, the most a day \(3\)/)
    expect((await report({ op: 'finish', markets: [] })).answer.error).toMatch(/the most a day/)
  })

  it('a problem makes it a danger notice, never deduped, at most 2 a day; then a warning', async () => {
    await anotherDay()
    const danger = () => inside(() => db().notification.count({ where: { type: ADS_RUN_NOTICE_TYPE, severity: 'danger', userId: ids.approver } }))
    const before = await danger()
    const args = { op: 'fail', problems: ['The search-term report was too old to judge'] }
    const first = await report(args)
    const second = await report(args)
    expect(first.answer.runId).not.toBe(second.answer.runId)
    expect(await danger()).toBe(before + 2)
    const third = await report(args)
    expect(third.answer).toMatchObject({ status: 'failed', notice: { severity: 'warn' } })
    expect(await danger()).toBe(before + 2)
    const warned = await inside(() => db().notification.findMany({ where: { type: ADS_RUN_NOTICE_TYPE, severity: 'warn', userId: ids.approver } }))
    expect(warned).toEqual([expect.objectContaining({ title: 'Claude ads run failed · 1 problem · 0 ran by rule · 0 wait for you' })])
    const failed = await inside(() => db().agentRun.findMany({ where: { agentKey: ADS_MANAGER_AGENT_KEY, status: 'failed' } }))
    expect(failed.find((r) => r.id === third.answer.runId)).toMatchObject({ ok: false, errorMessage: 'The search-term report was too old to judge' })
  })
})

describe('W4-1 — the day\'s one e-mail, the bell\'s figures, other businesses', { timeout: TIMEOUT }, () => {
  it('a report without a start is recorded too; the day\'s e-mail went already, so this one sends none', async () => {
    await anotherDay()
    const sent = mail.sent.length
    const dry = await dryRun(person(EVERYTHING), 'report-ads-run', { op: 'finish', markets: [{ market: 'IT', lines: ['Nothing to change'] }] })
    expect((dry.result as { preview: { email: unknown } }).preview.email).toEqual({ send: false, recipients: 1, why: 'today\'s report e-mail already went (one a day)' })
    const { answer } = await report({ op: 'finish', markets: [{ market: 'IT', lines: ['Nothing to change'] }] })
    expect(answer).toMatchObject({ status: 'done', email: { status: 'skipped' } })
    expect(await record(answer.runId)).toMatchObject({ agentKey: ADS_MANAGER_AGENT_KEY, status: 'done' })
    expect(mail.sent).toHaveLength(sent)
  })

  it('two reports at once send one e-mail: the day\'s e-mail is taken once', async () => {
    await anotherDay()
    await inside(() => db().agentMemory.deleteMany({ where: { entityType: 'report-email' } }))
    const sent = mail.sent.length
    const both = await Promise.all([1, 2].map(() => report({ op: 'finish', markets: [{ market: 'IT', lines: ['Nothing to change'] }] })))
    expect(both.map((b) => b.answer.status)).toEqual(['done', 'done'])
    expect(both.map((b) => b.answer.email.status).sort()).toEqual(['sent', 'skipped'])
    expect(mail.sent).toHaveLength(sent + 1)
  })

  it('the bell shows the figures only to people who may see the ad money', async () => {
    const run = (await inside(() => db().agentRun.findMany({ where: { agentKey: ADS_MANAGER_AGENT_KEY, status: 'done' }, orderBy: { createdAt: 'desc' }, take: 1 })))[0]
    const bell = await notices(run.id)
    const mine = bell.find((n) => n.userId === ids.approver)!
    const theirs = bell.find((n) => n.userId === ids.noMoney)!
    expect(mine.body).toContain('€')
    expect(theirs.body).not.toMatch(/€|\d/)
    expect(theirs.body).toContain('The figures are shown to people who may see the ad spend.')
    expect(theirs).toMatchObject({ title: mine.title, severity: mine.severity })
  })

  it('no digest list: the e-mail goes to this business\'s own people who may see its ad money, never another business\'s', async () => {
    vi.stubEnv('NEXUS_ADS_DIGEST_RECIPIENTS', '')
    try {
      const emails = async (userId: string) => (await db().userProfile.findUniqueOrThrow({ where: { id: userId } })).email
      const inA = await inside(() => reportRecipients())
      expect(inA.source).toBe('business')
      expect(inA.to).toContain(await emails(ids.approver))
      expect(inA.to).not.toContain(await emails(ids.noMoney))
      const inB = await inside(() => reportRecipients(), B)
      if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
        // With business profiles on, each business's own members: B's person never gets A's report, nor A's B's.
        expect(inA.to).not.toContain(await emails(ids.bOnly))
        expect(inB.to.sort()).toEqual([await emails(ids.approver), await emails(ids.bOnly)].sort())
      }
    } finally {
      vi.stubEnv('NEXUS_ADS_DIGEST_RECIPIENTS', 'owner@example.test')
    }
  })

  it('another business\'s runs are not listed', async () => {
    const read = await dryRun(person(EVERYTHING), 'ads-manager-runs', { days: 30 })
    const runIds = ((read.result as { data: { runs: Array<{ runId: string }> } }).data.runs).map((r) => r.runId)
    expect(runIds).not.toContain(ids.bRun)
    const inB = await inside(() => callTool(person(EVERYTHING, B), 'ads-manager-runs', { days: 30 }), B)
    expect(((inB.visible as { data: { runs: Array<{ runId: string }> } }).data.runs).map((r) => r.runId)).toEqual([ids.bRun])
  })
})
