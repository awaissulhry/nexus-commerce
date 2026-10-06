/**
 * ADS AUTONOMY W4-2 — the daily Claude ads run's watchdog, on PGlite with the production schema and business policies.
 *
 *   clock       the expected moment on the business's own clock (DST included) and the last deadline that passed
 *   missing     no report by the expected time + 30 min → one danger notice and one e-mail, once; a report that ran,
 *               or that waits for a person, is no miss; a setting newer than the deadline does not look back
 *   started     a run that started 2 hours ago and reported no end → one danger notice and one e-mail, once
 *   setting     set-ads-report-time: a person approves it (ceiling ask); a bad zone is refused; undo puts it back
 *   cron        registered through lib/cron/clustered.ts (the real wrapper; node-cron only records) at :40, off with
 *               the switch; with business profiles ON a tick runs inside EACH business: B's stuck run alerts in B only
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, adsSyncQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
  redis: { connection: { status: 'ready', set: async () => 'OK' } },
}))
// The Redis lease (proven in workspace-lease.vitest.test.ts) always grants the tick.
vi.mock('../../lib/cron/workspace-lease.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runWorkspaceTick: async (_store: unknown, _jobId: string, _at: number, work: () => Promise<void>) => { await work(); return true },
}))
const clocks = vi.hoisted(() => ({ armed: [] as Array<{ expression: string; tick: () => Promise<void> }> }))
vi.mock('node-cron', async (importOriginal) => {
  const real = await importOriginal<{ default: { validate: (e: string) => boolean } }>()
  return {
    default: {
      validate: real.default.validate,
      schedule: (expression: string, tick: () => Promise<void>) => {
        clocks.armed.push({ expression, tick })
        return { stop: () => {}, start: () => {} }
      },
    },
  }
})
const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string | string[]; subject: string; text?: string }> }))
vi.mock('../email/transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../email/transport.js')>()),
  sendEmail: vi.fn(async (message: { to: string | string[]; subject: string; text?: string }) => {
    mail.sent.push(message)
    return { ok: true, provider: 'resend', dryRun: false, messageId: `test-${mail.sent.length}` }
  }),
}))

import { runOrQueueTool } from './approval-gate.service.js'
import { callTool, ToolAccessError, type UserPrincipal } from './call-tool.js'
import { getTool } from './tool-registry.js'
import { commitScheduledApproval, scheduleApproval } from '../agent-fleet/approval-inbox.service.js'
import { ADS_MANAGER_AGENT_KEY } from './ads-manager-run.service.js'
import { lastDeadline, readExpectedReport, runWatchdogOnce, WATCHDOG_NOTICE_TYPE, writeExpectedReport, zonedMoment } from './ads-manager-watchdog.service.js'
import { startAdsRunWatchdogCron, WATCHDOG_SCHEDULE } from '../../jobs/claude-ads-run-watchdog.job.js'

const A = LEGACY_WORKSPACE_ID
const B = 'w4_watchdog_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { person: '' }
const ROME = { time: '08:00', timeZone: 'Europe/Rome' }
const at = (iso: string) => new Date(iso)
const db = () => database.client

const person = (workspaceId = A): UserPrincipal => ({
  kind: 'user', userId: ids.person, label: 'Willa Watch', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business(workspaceId), via: 'claude', oauthGrantId: 'grant-w4-2',
})
const watchdogNotices = (workspaceId = A) => inside(() => db().notification.findMany({ where: { type: WATCHDOG_NOTICE_TYPE }, orderBy: { createdAt: 'asc' } }), workspaceId)
/** The setting, as if set long ago (a setting newer than a deadline does not look back at it). */
async function setLongAgo(value: { time: string; timeZone: string } | null, workspaceId = A) {
  await inside(() => writeExpectedReport(value, 'test'), workspaceId)
  await inside(() => db().agentMemory.updateMany({ where: { key: 'expectedReport' }, data: { updatedAt: at('2026-09-01T00:00:00Z') } }), workspaceId)
}
const runRow = (data: { status: string; createdAt: Date; endedAt?: Date }, workspaceId = A) =>
  inside(() => db().agentRun.create({ data: { agentKey: ADS_MANAGER_AGENT_KEY, trigger: 'schedule', ...data } }), workspaceId)

async function ask(tool: string, args: Record<string, unknown>) {
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.person, via: 'claude', oauthGrantId: 'grant-w4-2' } }))
  return inside(() => runOrQueueTool(tool, args, person(), run.id, { forceAsk: true }))
}
async function askAndRun(tool: string, args: Record<string, unknown>) {
  const queued = await ask(tool, args)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const parked = await inside(() => scheduleApproval({ id: queued.approvalId!, actor: { ...person(), via: 'app' } }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: queued.approvalId! }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  const ran = await inside(() => commitScheduledApproval(queued.approvalId!))
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return queued.approvalId!
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('NEXUS_ADS_DIGEST_RECIPIENTS', 'owner@example.test')
  const client = database.client
  const role = await client.role.create({ data: { key: `W4_2_${randomUUID().slice(0, 8)}`, name: 'Watcher', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const someone = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Willa Watch' } })
  ids.person = someone.id
  await client.userRole.create({ data: { userId: someone.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo watchdog business', createdByUserId: someone.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: someone.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('W4-2 — the expected moment, on the business\'s own clock', () => {
  it('a wall-clock time in a zone, with daylight saving', () => {
    expect(zonedMoment({ y: 2026, m: 10, d: 6 }, '08:00', 'Europe/Rome').toISOString()).toBe('2026-10-06T06:00:00.000Z')
    expect(zonedMoment({ y: 2026, m: 12, d: 1 }, '08:00', 'Europe/Rome').toISOString()).toBe('2026-12-01T07:00:00.000Z')
    expect(zonedMoment({ y: 2026, m: 10, d: 6 }, '08:00', 'America/New_York').toISOString()).toBe('2026-10-06T12:00:00.000Z')
    // 02:30 does not exist on the spring-forward night: it lands an hour later (03:30 summer time).
    expect(zonedMoment({ y: 2026, m: 3, d: 29 }, '02:30', 'Europe/Rome').toISOString()).toBe('2026-03-29T01:30:00.000Z')
  })

  it('the last deadline that passed: today\'s once 30 minutes are over, else yesterday\'s', () => {
    expect(lastDeadline(at('2026-10-06T06:20:00Z'), ROME)).toEqual({
      due: at('2026-10-05T06:00:00Z'), previous: at('2026-10-04T06:00:00Z'), deadline: at('2026-10-05T06:30:00Z'), since: at('2026-10-04T06:30:00Z'),
    })
    expect(lastDeadline(at('2026-10-06T06:40:00Z'), ROME).due).toEqual(at('2026-10-06T06:00:00Z'))
    // Across the autumn change: 08:00 is 07:00 UTC again, the window is 25 hours long.
    expect(lastDeadline(at('2026-10-26T07:40:00Z'), ROME)).toMatchObject({ due: at('2026-10-26T07:00:00Z'), previous: at('2026-10-25T07:00:00Z') })
  })
})

describe('W4-2 — one tick in one business', { timeout: TIMEOUT }, () => {
  it('no expected time and no started run: nothing at all', async () => {
    const tick = await inside(() => runWatchdogOnce(at('2026-10-06T06:40:00Z')))
    expect(tick).toEqual({ expected: null, missing: null, stuck: [] })
    expect(await watchdogNotices()).toEqual([])
    expect(mail.sent).toHaveLength(0)
  })

  it('no report by the expected time + 30 minutes: one danger notice and one e-mail, once', async () => {
    await setLongAgo(ROME)
    const tick = await inside(() => runWatchdogOnce(at('2026-10-06T06:40:00Z')))
    expect(tick.missing).toMatchObject({ due: '2026-10-06T06:00:00.000Z', alert: { notices: 1, email: 'sent' } })
    const [notice] = await watchdogNotices()
    expect(notice).toMatchObject({ severity: 'danger', title: 'Claude ads: the daily run did not report', userId: ids.person, meta: { check: 'no-report', due: '2026-10-06T06:00:00.000Z' } })
    expect(notice.body).toContain('by 08:00 (Europe/Rome)')
    expect(mail.sent).toEqual([expect.objectContaining({ to: ['owner@example.test'], subject: 'Claude ads: the daily run did not report' })])
    // The next tick, an hour later, says nothing again for the same day.
    expect((await inside(() => runWatchdogOnce(at('2026-10-06T07:40:00Z')))).missing).toBeNull()
    expect(await watchdogNotices()).toHaveLength(1)
    expect(mail.sent).toHaveLength(1)
  })

  it('a report that ran, or that waits for a person, is no miss', async () => {
    await runRow({ status: 'done', createdAt: at('2026-10-07T05:00:00Z'), endedAt: at('2026-10-07T05:20:00Z') })
    expect((await inside(() => runWatchdogOnce(at('2026-10-07T06:40:00Z')))).missing).toBeNull()
    // The next day's finish waits for a person in Approvals: the run did report.
    await inside(async () => {
      const call = await db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval', via: 'claude' } })
      await db().agentApproval.create({ data: { agentRunId: call.id, toolName: 'report-ads-run', riskTier: 'low', args: { op: 'finish' }, status: 'pending', requestedAt: at('2026-10-08T05:50:00Z') } })
    })
    expect((await inside(() => runWatchdogOnce(at('2026-10-08T06:45:00Z')))).missing).toBeNull()
    // A start alone is no report.
    await inside(async () => {
      const call = await db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval', via: 'claude' } })
      await db().agentApproval.create({ data: { agentRunId: call.id, toolName: 'report-ads-run', riskTier: 'low', args: { op: 'start' }, status: 'pending', requestedAt: at('2026-10-09T05:50:00Z') } })
    })
    expect((await inside(() => runWatchdogOnce(at('2026-10-09T06:45:00Z')))).missing).toMatchObject({ due: '2026-10-09T06:00:00.000Z' })
    expect(await watchdogNotices()).toHaveLength(2)
  })

  it('a setting newer than the deadline does not look back at it; switched off, nothing is checked', async () => {
    await inside(() => writeExpectedReport(ROME, 'test'))
    await inside(() => db().agentMemory.updateMany({ where: { key: 'expectedReport' }, data: { updatedAt: at('2026-10-10T07:00:00Z') } }))
    expect((await inside(() => runWatchdogOnce(at('2026-10-10T07:10:00Z')))).missing).toBeNull()
    await inside(() => writeExpectedReport(null, 'test'))
    expect(await inside(() => readExpectedReport())).toBeNull()
    expect((await inside(() => runWatchdogOnce(at('2026-10-12T06:40:00Z')))).missing).toBeNull()
  })

  it('a run that started 2 hours ago and reported no end: one alert, once; one started an hour ago is not late yet', async () => {
    const now = at('2026-10-13T09:00:00Z')
    const late = await runRow({ status: 'running', createdAt: at('2026-10-13T06:30:00Z') })
    const fresh = await runRow({ status: 'running', createdAt: at('2026-10-13T08:00:00Z') })
    const sent = mail.sent.length
    const tick = await inside(() => runWatchdogOnce(now))
    expect(tick.stuck).toEqual([{ runId: late.id, alert: { notices: 1, email: 'sent' } }])
    const notice = (await watchdogNotices()).at(-1)!
    expect(notice).toMatchObject({ severity: 'danger', title: 'Claude ads: a daily run started and did not finish', meta: { check: 'started-no-end', runId: late.id } })
    expect(notice.body).toContain('started at 08:30 (Europe/Rome)')
    expect(mail.sent).toHaveLength(sent + 1)
    expect((await inside(() => runWatchdogOnce(at('2026-10-13T09:30:00Z')))).stuck).toEqual([])
    // Done: no run of this business is left started (the cron test below runs at today's real time).
    await inside(() => db().agentRun.updateMany({ where: { id: { in: [late.id, fresh.id] } }, data: { status: 'done', endedAt: now } }))
  })
})

describe('W4-2 — set-ads-report-time', { timeout: TIMEOUT }, () => {
  it('Nexus only, a person decides (Claude never changes its own watchdog alone), undoable', () => {
    expect(getTool('set-ads-report-time')).toMatchObject({ readOnly: false, openWorld: false, reversibility: 'full', maxClaudeTrust: 'ask', requires: [F.adsAutomationManage] })
  })

  it('approved, the expected time is set; a bad zone or time is refused; undo puts the old one back', async () => {
    const preview = await inside(() => callTool(person(), 'set-ads-report-time', { time: '08:30', timeZone: 'Europe/Rome' }))
    expect(preview.visible).toMatchObject({ ok: true, preview: { changes: { 'expected report time': { from: 'off', to: '08:30 (Europe/Rome)' } } } })
    const approvalId = await askAndRun('set-ads-report-time', { time: '08:30', timeZone: 'Europe/Rome' })
    expect(await inside(() => readExpectedReport())).toMatchObject({ time: '08:30', timeZone: 'Europe/Rome' })
    // ads-manager-runs says it.
    const runs = await inside(() => callTool(person(), 'ads-manager-runs', { days: 1 }))
    expect((runs.visible as { data: { expectedReport: unknown } }).data.expectedReport).toEqual({ time: '08:30', timeZone: 'Europe/Rome' })
    expect((await ask('set-ads-report-time', { time: '08:30', timeZone: 'Mars/Olympus' })).error).toMatch(/not a time zone/)
    await expect(inside(() => callTool(person(), 'set-ads-report-time', { time: '25:00' }))).rejects.toBeInstanceOf(ToolAccessError)
    await askAndRun('undo-change', { approvalId })
    expect(await inside(() => readExpectedReport())).toBeNull()
  })
})

describe('W4-2 — the cron: clustered, hourly, inside each business', { timeout: TIMEOUT }, () => {
  it('the off switch arms nothing; otherwise one clock at :40, through the clustered wrapper', () => {
    vi.stubEnv('NEXUS_ENABLE_ADS_RUN_WATCHDOG_CRON', '0')
    startAdsRunWatchdogCron()
    expect(clocks.armed).toEqual([])
    vi.stubEnv('NEXUS_ENABLE_ADS_RUN_WATCHDOG_CRON', '')
    startAdsRunWatchdogCron()
    startAdsRunWatchdogCron()
    expect(clocks.armed.map((c) => c.expression)).toEqual([WATCHDOG_SCHEDULE])
    expect(WATCHDOG_SCHEDULE).toBe('40 * * * *')
  })

  it('with business profiles ON a tick runs inside each business: B\'s late run alerts in B, never in A', async () => {
    const was = process.env.NEXUS_WORKSPACES_ENABLED ?? '0'
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    try {
      const late = await runRow({ status: 'running', createdAt: new Date(Date.now() - 3 * 3600_000) }, B)
      const before = { a: (await watchdogNotices(A)).length, b: (await watchdogNotices(B)).length }
      await clocks.armed[0].tick()
      const inB = await watchdogNotices(B)
      expect(inB).toHaveLength(before.b + 1)
      expect(inB.at(-1)).toMatchObject({ workspaceId: B, userId: ids.person, meta: { check: 'started-no-end', runId: late.id } })
      expect(await watchdogNotices(A)).toHaveLength(before.a)
      // Its CronRun row is B's (the check found something there).
      expect(await inside(() => db().cronRun.count({ where: { jobName: 'claude-ads-run-watchdog' } }), B)).toBe(1)
    } finally {
      vi.stubEnv('NEXUS_WORKSPACES_ENABLED', was)
    }
  })
})
