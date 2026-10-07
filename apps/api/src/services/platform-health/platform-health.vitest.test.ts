/**
 * Platform health watchdog — on PGlite with the production schema and the business policies (no mocked query):
 *
 *   gathers    every check of the registry measures against the real schema (none throws); the cron history's own
 *              SQL finds a daily job that did not run, a 5-minute job's 2-hour hole and runs that never ended; the ad
 *              writes' settled states split applied / refused by the gate / stuck
 *   store      one row per check per run, in the business that ran it only
 *   alerts     one AlertRule per check (created on the first run, with the default channels); a failing check opens
 *              ONE alert event and one e-mail in plain words; it stays one while it fails, is raised again when it gets
 *              worse (warn → fail), is left alone while the check cannot measure, and is resolved automatically when
 *              the check passes (an acknowledged one too); a disabled rule raises nothing; the minute evaluator leaves
 *              these rules alone
 *   inbox      alerts-inbox shows the check's own words, critical for a fail
 *   tool       platform-health-checks: the newest run worst first with evidence and since when it is not ok, the open
 *              alerts, the problems filter, a stale run said as a failure, live measuring that stores nothing
 *   cron       registered through lib/cron/clustered.ts at 06:20 UTC; "Run now" is in the cron registry
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
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
// No Redis in this suite: the registry's other tools import the queue module.
vi.mock('../../lib/queue.js', () => ({
  redis: null, outboundSyncQueue: null, channelSyncQueue: null, readCacheQueue: null, readinessQueue: null, searchIndexQueue: null,
  bulkJobQueue: null, adsSyncQueue: null, queueEvents: null, channelSyncQueueEvents: null, addJobSafely: vi.fn(),
  getRedisRuntimeStatus: () => ({ configured: false, status: 'off' }),
}))
const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string | string[]; subject: string; text?: string }> }))
vi.mock('../email/transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../email/transport.js')>()),
  sendEmail: vi.fn(async (message: { to: string | string[]; subject: string; text?: string }) => {
    mail.sent.push(message)
    return { ok: true, provider: 'resend', dryRun: false, messageId: `test-${mail.sent.length}` }
  }),
}))
const clocks = vi.hoisted(() => ({ armed: [] as Array<{ expression: string }> }))
vi.mock('node-cron', async (importOriginal) => {
  const real = await importOriginal<{ default: { validate: (e: string) => boolean } }>()
  return {
    default: {
      validate: real.default.validate,
      schedule: (expression: string) => {
        clocks.armed.push({ expression })
        return { stop: () => {}, start: () => {} }
      },
    },
  }
})

import { callTool, type UserPrincipal } from '../agents/call-tool.js'
import { runAlertEvaluator } from '../alert-evaluator.service.js'
import { cronRunsCheck } from './checks/scheduler.checks.js'
import { adWritesCheck } from './checks/writes.checks.js'
import { HEALTH_CHECKS } from './registry.js'
import { measurePlatformHealth, metricOf, readPlatformHealth, runPlatformHealthWatchdog, watchdogSummary } from './platform-health.service.js'
import type { HealthCheck, Verdict } from './types.js'
import { PLATFORM_HEALTH_JOB, startPlatformHealthWatchdogCron } from '../../jobs/platform-health-watchdog.job.js'
import { isKnownCron } from '../../jobs/cron-registry.js'

const A = LEGACY_WORKSPACE_ID
const B = 'platform_health_bravo'
const ON = process.env.NEXUS_WORKSPACES_ENABLED === '1'
const TIMEOUT = 120_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client

const NOW = new Date()
const MIN = 60_000
const HOUR = 60 * MIN
const ago = (ms: number) => new Date(NOW.getTime() - ms)

function principal(workspaceId = A): UserPrincipal {
  return {
    kind: 'user', userId: 'u-health', label: 'Health test',
    permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
    ...(ON || workspaceId !== A ? { workspace: business(workspaceId) } : {}),
    via: 'claude',
  }
}
type Answer = { ok: boolean; error?: string; data?: any }
const call = async (tool: string, args: Record<string, unknown>, who = principal()) => (await callTool(who, tool, args)).visible as Answer

/** A check whose verdict the test sets. */
let next: Verdict
const verdict = (status: Verdict['status'], message = `the test check is ${status}`): Verdict =>
  ({ status, message, likelyCause: status === 'ok' ? null : 'the test made it so', nextStep: status === 'ok' ? null : 'change the test', evidence: { status } })
const testCheck: HealthCheck<null> = {
  id: 'test-check', subsystem: 'queues', title: 'Test check', watches: 'Whatever the test sets.',
  gather: async () => null,
  judge: () => next,
}

beforeAll(async () => {
  process.env.NEXUS_ALERT_EMAIL = 'alerts@example.test'
  database = await formulaDatabase()
  const owner = await db().userProfile.create({ data: { email: 'health-owner@example.test', status: 'active', displayName: 'Health owner' } })
  await db().workspace.create({ data: { id: B, name: 'Health bravo', createdByUserId: owner.id, creationKey: 'health-bravo' } })
  await inside(async () => {
    const runs: Array<{ jobName: string; startedAt: Date; finishedAt: Date | null; status: string }> = []
    // An hourly job, healthy.
    for (let h = 0; h < 72; h++) runs.push({ jobName: 'hourly-ok', startedAt: ago(10 * MIN + h * HOUR), finishedAt: ago(9 * MIN + h * HOUR), status: 'SUCCESS' })
    // A daily job whose last start was 26.5 h ago: today's run never came.
    for (let d = 0; d < 10; d++) runs.push({ jobName: 'daily-silent', startedAt: ago(26.5 * HOUR + d * 24 * HOUR), finishedAt: ago(26.4 * HOUR + d * 24 * HOUR), status: 'SUCCESS' })
    // A 5-minute job with a 2-hour hole 5 to 3 hours ago.
    for (let m = 1; m < 12 * 48; m++) {
      const t = m * 5 * MIN
      if (t > 3 * HOUR && t < 5 * HOUR) continue
      runs.push({ jobName: 'five-minute-gap', startedAt: ago(t), finishedAt: ago(t - 10_000), status: 'SUCCESS' })
    }
    await db().cronRun.createMany({ data: runs })
    // Three runs that started 4 hours ago and never ended: the process died.
    for (const jobName of ['died-a', 'died-b', 'died-c']) await db().cronRun.create({ data: { jobName, startedAt: ago(4 * HOUR), status: 'RUNNING' } })

    // Ad writes: two applied, three refused by the write gate, one stuck 3 hours.
    const write = (state: string, extra: Record<string, unknown> = {}) =>
      db().adMutation.create({ data: { entityType: 'AD_TARGET', entityId: `t-${Math.random()}`, field: 'bid', actor: 'automation:auto-bid', state, createdAt: ago(2 * HOUR), ...extra } })
    await write('APPLIED')
    await write('APPLIED')
    for (let i = 0; i < 3; i++) await write('CANCELLED', { lastError: 'allowlist: campaign 1234 is not on the live-write allowlist (bid 0.75)' })
    await write('PENDING', { createdAt: ago(3 * HOUR) })
  })
}, TIMEOUT)

afterAll(async () => {
  delete process.env.NEXUS_ALERT_EMAIL
  await database?.close()
}, 30_000)

describe('gathers — every check measures against the real schema', () => {
  it('no check throws: each is ok, warn, fail or an honest "could not measure" that is not a read error', async () => {
    const results = await inside(() => measurePlatformHealth(NOW))
    expect(results.map((r) => r.id)).toEqual(HEALTH_CHECKS.map((c) => c.id))
    for (const r of results) {
      expect(['ok', 'warn', 'fail', 'unknown'], r.id).toContain(r.status)
      expect(r.message, r.id).not.toMatch(/the check failed while reading/)
    }
  }, TIMEOUT)

  it('cron-runs: the silent daily job, the 5-minute job\'s hole and the runs that never ended, from CronRun\'s own SQL', async () => {
    const facts = await inside(() => cronRunsCheck.gather({ now: NOW, memo: (_k, read) => read() }))
    const v = cronRunsCheck.judge(facts, NOW)
    expect(v.status).toBe('fail')
    const missed = (v.evidence.missed as Array<{ job: string; endedAt: string | null }>)
    expect(missed.find((m) => m.job === 'daily-silent')?.endedAt).toBeNull()
    expect(missed.find((m) => m.job === 'five-minute-gap')?.endedAt).not.toBeNull()
    expect(missed.some((m) => m.job === 'hourly-ok')).toBe(false)
    expect(v.message).toMatch(/3 runs started and never finished/)
  }, TIMEOUT)

  it('ads-writes: applied, refused by the gate (by its stage only — no bid, no id) and stuck past the hold', async () => {
    const facts = await inside(() => adWritesCheck.gather({ now: NOW, memo: (_k, read) => read() }))
    expect(facts).toMatchObject({ applied: 2, refusedByGate: 3, stuckTotal: 1, gateStages: [{ stage: 'allowlist', count: 3 }] })
    const v = adWritesCheck.judge(facts, NOW)
    expect(v.status).toBe('fail')
    expect(JSON.stringify(v.evidence)).not.toMatch(/0\.75|1234/)
  }, TIMEOUT)
})

describe('store and alert — one row per check, one alert per failing check, resolved when it passes', () => {
  const run = (now = new Date()) => inside(() => runPlatformHealthWatchdog({ now, checks: [testCheck] }))
  const events = () => inside(() => db().alertEvent.findMany({ where: { rule: { metric: metricOf('test-check') } }, orderBy: { triggeredAt: 'asc' } }))

  it('warn opens ONE alert with its words; fail raises it again; still failing stays one; could-not-measure leaves it; ok resolves it', async () => {
    mail.sent.length = 0
    next = verdict('warn', 'the test check is slipping')
    const first = await run()
    expect(first.alerts.fired).toEqual(['test-check'])
    const rule = await inside(() => db().alertRule.findFirst({ where: { metric: metricOf('test-check') } }))
    expect(rule).toMatchObject({ name: 'Platform health: Test check', operator: 'gte', threshold: 1, enabled: true })
    expect(rule!.notificationChannels).toEqual(['log', 'email:alerts@example.test'])
    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0].subject).toBe('[Nexus alert] Platform health: Test check: warn')
    expect(mail.sent[0].text).toMatch(/WARN: the test check is slipping/)
    expect(mail.sent[0].text).toMatch(/Likely cause: the test made it so/)

    next = verdict('fail', 'the test check broke')
    expect((await run()).alerts.escalated).toEqual(['test-check'])
    expect(mail.sent).toHaveLength(2)
    expect(mail.sent[1].subject).toMatch(/now: fail/)
    let open = await events()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ status: 'TRIGGERED', value: 2 })

    expect((await run()).alerts).toEqual({ fired: [], resolved: [], escalated: [] })
    next = verdict('unknown', 'Could not measure: the test cannot see')
    expect((await run()).alerts).toEqual({ fired: [], resolved: [], escalated: [] })
    expect(mail.sent).toHaveLength(2)
    open = await events()
    expect(open.map((e) => e.status)).toEqual(['TRIGGERED'])

    // Acknowledged by a person, then the check passes: resolved anyway.
    await inside(() => db().alertEvent.update({ where: { id: open[0].id }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() } }))
    next = verdict('ok')
    expect((await run()).alerts.resolved).toEqual(['test-check'])
    const after = await events()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ status: 'RESOLVED', resolvedBy: 'auto' })

    // Failing again is a new alert.
    next = verdict('fail')
    expect((await run()).alerts.fired).toEqual(['test-check'])
    expect((await events()).map((e) => e.status)).toEqual(['RESOLVED', 'TRIGGERED'])
    // Each run stored one row for its one check.
    const rows = await inside(() => db().platformHealthCheck.count({ where: { checkId: 'test-check' } }))
    expect(rows).toBe(6)
  }, TIMEOUT)

  it('a rule a person disabled raises nothing; the minute evaluator leaves the watchdog\'s rules alone', async () => {
    await inside(() => db().alertRule.updateMany({ where: { metric: metricOf('test-check') }, data: { enabled: false, lastFired: false } }))
    next = verdict('fail')
    expect((await run()).alerts).toEqual({ fired: [], resolved: [], escalated: [] })
    await inside(() => db().alertRule.updateMany({ where: { metric: metricOf('test-check') }, data: { enabled: true } }))
    const evaluated = await inside(() => runAlertEvaluator())
    expect(evaluated.errors).toBe(0)
    expect(evaluated.rulesEvaluated).toBe(0)
  }, TIMEOUT)

  it('alerts-inbox shows the check\'s own words, critical for a fail', async () => {
    await inside(() => db().alertRule.updateMany({ where: { metric: metricOf('test-check') }, data: { lastFired: true, lastValue: 2 } }))
    const inbox = await call('alerts-inbox', { source: 'alert' })
    const item = inbox.data.items.find((i: { title: string }) => i.title === 'Alert fired: Platform health: Test check')
    expect(item).toMatchObject({ severity: 'critical', body: 'the test check is fail' })
  }, TIMEOUT)

  it('rows and alerts stay in their business', async () => {
    next = verdict('fail', 'BRAVO is broken')
    await inside(() => runPlatformHealthWatchdog({ checks: [testCheck] }), B)
    const seenByA = await inside(() => db().platformHealthCheck.findMany({ where: { message: 'BRAVO is broken' } }))
    expect(seenByA).toHaveLength(0)
    const inB = await inside(() => db().alertRule.count({ where: { metric: metricOf('test-check') } }), B)
    expect(inB).toBe(1)
  }, TIMEOUT)
})

describe('platform-health-checks — Claude\'s read', () => {
  it('the newest run, worst first, with evidence, since when not ok, and the open alerts; problems only on request', async () => {
    const run = await inside(() => runPlatformHealthWatchdog({ now: new Date(), triggeredBy: 'manual' }))
    expect(watchdogSummary(run)).toMatch(/^checks=12 ok=\d+ warn=\d+ fail=\d+ unknown=\d+/)
    const answer = await call('platform-health-checks', {})
    expect(answer.ok).toBe(true)
    expect(answer.data.run).toMatchObject({ runId: run.runId, triggeredBy: 'manual', stale: false })
    const checks = answer.data.checks as Array<{ check: string; status: string; message: string; evidence: unknown; lastOkAt: string | null }>
    expect(checks).toHaveLength(12)
    const rank = { fail: 0, warn: 1, unknown: 2, ok: 3 } as Record<string, number>
    expect(checks.map((c) => rank[c.status])).toEqual([...checks.map((c) => rank[c.status])].sort((a, b) => a - b))
    const cron = checks.find((c) => c.check === 'cron-runs')!
    expect(cron).toMatchObject({ status: 'fail', lastOkAt: null })
    expect(cron.message).toMatch(/daily-silent/)
    expect(answer.data.openAlerts.some((a: { check: string; level: string }) => a.check === 'cron-runs' && a.level === 'fail')).toBe(true)

    const problems = await call('platform-health-checks', { status: 'problems' })
    expect((problems.data.checks as Array<{ status: string }>).every((c) => c.status !== 'ok')).toBe(true)
    const one = await call('platform-health-checks', { check: 'ads-writes' })
    expect(one.data.checks.map((c: { check: string }) => c.check)).toEqual(['ads-writes'])
  }, TIMEOUT)

  it('a run older than 26 hours is stale, and the answer says the watchdog itself did not run', async () => {
    const reading = await inside(() => readPlatformHealth(new Date(Date.now() + 30 * HOUR)))
    expect(reading.run?.stale).toBe(true)
    await inside(() => db().platformHealthCheck.updateMany({ data: { measuredAt: ago(30 * HOUR) } }))
    const answer = await call('platform-health-checks', {})
    expect(answer.data.run.stale).toBe(true)
    expect(answer.data.hint).toMatch(/STALE: .* the daily watchdog did not run/)
  }, TIMEOUT)

  it('live measures now and stores nothing', async () => {
    const before = await inside(() => db().platformHealthCheck.count())
    const answer = await call('platform-health-checks', { live: true, check: 'cron-runs' })
    expect(answer.data).toMatchObject({ measured: 'live' })
    expect(answer.data.checks[0]).toMatchObject({ check: 'cron-runs', status: 'fail' })
    expect(await inside(() => db().platformHealthCheck.count())).toBe(before)
  }, TIMEOUT)

  it('a business where the watchdog never ran says so', async () => {
    const fresh = 'platform_health_charlie'
    const owner = await db().userProfile.create({ data: { email: 'health-charlie@example.test', status: 'active' } })
    await db().workspace.create({ data: { id: fresh, name: 'Health charlie', createdByUserId: owner.id, creationKey: 'health-charlie' } })
    const answer = await call('platform-health-checks', {}, principal(fresh))
    expect(answer.data.run).toBeNull()
    expect(answer.data.hint).toMatch(/has not run in this business yet/)
  }, TIMEOUT)
})

describe('the cron', () => {
  it('is registered through the clustered wrapper at 06:20 UTC, off with its switch, and Run now knows it', () => {
    process.env.NEXUS_ENABLE_PLATFORM_HEALTH_CRON = '0'
    startPlatformHealthWatchdogCron()
    expect(clocks.armed).toHaveLength(0)
    delete process.env.NEXUS_ENABLE_PLATFORM_HEALTH_CRON
    startPlatformHealthWatchdogCron()
    expect(clocks.armed.map((c) => c.expression)).toEqual(['20 6 * * *'])
    expect(isKnownCron(PLATFORM_HEALTH_JOB)).toBe(true)
  })
})
