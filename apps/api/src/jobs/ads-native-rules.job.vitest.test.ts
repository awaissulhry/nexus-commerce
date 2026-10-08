/**
 * ONE BRAIN AB-4 — the daily read's cron (jobs/ads-native-rules.job.ts): registered through lib/cron/clustered.ts at
 * 04:35 UTC; a tick with the bid brain not live and no product enrolled asks Amazon nothing, writes nothing and records
 * no run; a due tick runs the read once inside a recorded run; a failure is logged, never thrown into the scheduler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  due: { due: false, why: 'the bid brain is not live and no product is enrolled: nothing to read, Amazon is not asked' },
  read: vi.fn(async () => ({ ran: true, why: 'NEXUS_BID_BRAIN_MODE is live', campaigns: 12, read: 11, couldNotRead: 1, calls: 12, acting: 0, dropped: 0 })),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  schedules: [] as Array<{ expr: string; options: unknown }>,
}))
vi.mock('../services/advertising/brain/native-rules.js', () => ({
  nativeReadDue: vi.fn(async () => h.due),
  readNativeRulesOnce: h.read,
  nativeReadSummaryLine: (s: { campaigns: number }) => `campaigns=${s.campaigns}`,
}))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { schedule: vi.fn((expr: string, _fn: unknown, options: unknown) => { h.schedules.push({ expr, options }); return { stop: vi.fn() } }) },
}))

import { NATIVE_RULES_JOB, NATIVE_RULES_SCHEDULE, runNativeRulesTick, startNativeRulesCron } from './ads-native-rules.job.js'

beforeEach(() => { h.read.mockClear(); h.recorded = [] })
afterEach(() => { vi.unstubAllEnvs() })

describe('AB-4 — the daily read of Amazon\'s own rules (cron)', () => {
  it('is registered through the clustered cron, daily at 04:35 UTC, with a lock that outlives a slow read', () => {
    startNativeRulesCron()
    startNativeRulesCron()
    expect(h.schedules).toEqual([{ expr: '35 4 * * *', options: { lockTtlMs: 600_000 } }])
    expect(NATIVE_RULES_SCHEDULE).toBe('35 4 * * *')
  })

  it('no-op: not due — no read, no Amazon call, no run recorded', async () => {
    h.due = { due: false, why: 'the bid brain is not live and no product is enrolled: nothing to read, Amazon is not asked' }
    expect(await runNativeRulesTick()).toEqual({ ran: false, why: h.due.why, campaigns: 0, read: 0, couldNotRead: 0, calls: 0, acting: 0, dropped: 0 })
    expect(h.read).not.toHaveBeenCalled()
    expect(h.recorded).toEqual([])
  })

  it('due: the read runs once inside a recorded run', async () => {
    h.due = { due: true, why: 'NEXUS_BID_BRAIN_MODE is live' }
    const at = new Date('2026-10-09T04:35:00Z')
    expect(await runNativeRulesTick(at)).toMatchObject({ ran: true, campaigns: 12 })
    expect(h.read).toHaveBeenCalledWith({ now: at })
    expect(h.recorded).toEqual([{ job: NATIVE_RULES_JOB, summary: 'campaigns=12' }])
  })

  it('a failed read is logged and answers null: the scheduler never sees it throw', async () => {
    h.due = { due: true, why: 'NEXUS_BID_BRAIN_MODE is live' }
    h.read.mockRejectedValueOnce(new Error('database away'))
    expect(await runNativeRulesTick()).toBeNull()
  })
})
