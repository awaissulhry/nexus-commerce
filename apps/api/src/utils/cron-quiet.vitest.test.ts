/**
 * C2 (2026-10-10) — the jobs quiet by design, and the ticks they are due at. Pure, apart from the last test, which loads
 * the jobs' own name constants so a renamed job cannot silently fall off the list.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db.js', () => ({ default: {} }))

import { COVER_FRESH_MS, CRON_QUIET, CYCLE_JOB, cronQuietRule, dueTicks, expectsTick, isWorkOnly, silenceExcused } from './cron-quiet.js'

const MIN = 60_000
const HOUR = 60 * MIN
const at = (iso: string) => new Date(iso)
const t = (iso: string) => Date.parse(iso)

describe('the list', () => {
  it('every entry says why; an expected-ticks entry also says which schedule it assumes', () => {
    for (const [job, rule] of Object.entries(CRON_QUIET)) {
      expect(rule.reason.length, job).toBeGreaterThan(20)
      if (rule.kind === 'expected-ticks') expect(rule.assumes, job).toMatch(/\*/)
    }
  })
  it('an unknown job has no rule and expects every tick', () => {
    expect(cronQuietRule('drain-ads-sync')).toBeNull()
    expect(cronQuietRule('toString')).toBeNull()
    expect(isWorkOnly('drain-ads-sync')).toBe(false)
    expect(expectsTick('drain-ads-sync', at('2026-10-07T23:00:00Z'))).toBe(true)
  })
})

describe('expected ticks', () => {
  it('the settle catch-up runs 03:20–09:20 UTC only', () => {
    expect(expectsTick('ads-report-settle', at('2026-10-07T03:20:00Z'))).toBe(true)
    expect(expectsTick('ads-report-settle', at('2026-10-07T09:20:00Z'))).toBe(true)
    expect(expectsTick('ads-report-settle', at('2026-10-07T10:20:00Z'))).toBe(false)
    expect(expectsTick('ads-report-settle', at('2026-10-07T02:20:00Z'))).toBe(false)
  })
  it('the bid brain\'s and the money writer\'s 15-minute ticks skip the full run at :45 of 00, 06, 12, 18 UTC', () => {
    for (const job of ['ads-bid-brain-live', 'ads-brain-money-live']) {
      expect(expectsTick(job, at('2026-10-07T06:45:03Z'))).toBe(false)
      expect(expectsTick(job, at('2026-10-07T18:45:00Z'))).toBe(false)
      expect(expectsTick(job, at('2026-10-07T07:45:00Z'))).toBe(true)
      expect(expectsTick(job, at('2026-10-07T06:30:00Z'))).toBe(true)
    }
  })
  it('dueTicks counts the ticks after the last start that the job expects', () => {
    // The settle job's night: from 09:20 to 03:00 the next day, nothing was due.
    expect(dueTicks('ads-report-settle', t('2026-10-06T09:20:02Z'), t('2026-10-07T03:00:00Z'), HOUR)).toEqual([])
    // Silent since 04:20: the 05:20 tick was due.
    expect(dueTicks('ads-report-settle', t('2026-10-07T04:20:02Z'), t('2026-10-07T05:50:00Z'), HOUR)).toEqual([t('2026-10-07T05:20:02Z')])
    // A job without a rule: every tick.
    expect(dueTicks('drain-ads-sync', 0, 3 * MIN, MIN)).toEqual([MIN, 2 * MIN, 3 * MIN])
    expect(dueTicks('drain-ads-sync', 0, 3 * MIN, 0)).toEqual([])
  })
})

describe('covered by the product cycle', () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  it('a brain step\'s silence is excused only while the cycle ran in the last two hours', () => {
    const cycleAt = (msAgo: number | null) => (job: string) => (job === CYCLE_JOB && msAgo != null ? now - msAgo : null)
    expect(silenceExcused('ads-brain-state', now, cycleAt(30 * MIN))).toBe(true)
    expect(silenceExcused('ads-brain-state', now, cycleAt(COVER_FRESH_MS + MIN))).toBe(false) // the cycle stopped: judged again
    expect(silenceExcused('ads-brain-state', now, cycleAt(null))).toBe(false) // the cycle never ran (off): judged
    expect(silenceExcused('fulfilment-conversion-confirm', now, cycleAt(null))).toBe(true)
    expect(silenceExcused('drain-ads-sync', now, cycleAt(30 * MIN))).toBe(false)
    expect(silenceExcused(CYCLE_JOB, now, cycleAt(30 * MIN))).toBe(false)
  })
})

describe('the names are the jobs\' own', () => {
  it('each brain step is covered by the cycle; a job on a fixed clock while switched on is not on the list', async () => {
    const steps = await Promise.all([
      import('../jobs/ads-brain-state.job.js').then((m) => m.BRAIN_STATE_JOB),
      import('../jobs/ads-brain-terms.job.js').then((m) => m.BRAIN_TERMS_JOB),
      import('../jobs/ads-brain-negatives.job.js').then((m) => m.BRAIN_NEGATIVES_JOB),
      import('../jobs/ads-brain-harvest.job.js').then((m) => m.BRAIN_HARVEST_JOB),
      import('../jobs/ads-brain-hours.job.js').then((m) => m.BRAIN_HOURS_JOB),
      import('../jobs/ads-brain-structure.job.js').then((m) => m.BRAIN_STRUCTURE_JOB),
    ])
    const fixedClock = await Promise.all([
      import('../jobs/ads-brain-cycle.job.js').then((m) => m.BRAIN_CYCLE_JOB),
      import('../jobs/ads-brain-retire.job.js').then((m) => m.BRAIN_RETIRE_JOB),
      import('../jobs/ads-lag-curve.job.js').then((m) => m.LAG_CURVE_JOB),
      import('../jobs/ads-native-rules.job.js').then((m) => m.NATIVE_RULES_JOB),
    ])
    const bid = await import('../jobs/ads-bid-brain.job.js')
    expect(fixedClock[0]).toBe(CYCLE_JOB)
    for (const name of [...steps, bid.BRAIN_MONEY_JOB]) expect(cronQuietRule(name), name).toMatchObject({ kind: 'covered', by: CYCLE_JOB })
    for (const name of fixedClock) expect(cronQuietRule(name), name).toBeNull()
    for (const name of [bid.BID_BRAIN_LIVE_JOB, bid.BRAIN_MONEY_LIVE_JOB]) expect(cronQuietRule(name)?.kind, name).toBe('expected-ticks')
    expect(Object.values(CRON_QUIET).filter((r) => r.kind === 'work-only')).toHaveLength(1)
    expect(isWorkOnly('fulfilment-conversion-confirm')).toBe(true)
    // The full slot the live ticks skip is the bid brain's own.
    for (const iso of ['2026-10-07T06:45:00Z', '2026-10-07T07:45:00Z', '2026-10-07T12:30:00Z']) {
      expect(expectsTick(bid.BID_BRAIN_LIVE_JOB, at(iso)), iso).toBe(!bid.isFullSlot(at(iso)))
    }
  })
})
