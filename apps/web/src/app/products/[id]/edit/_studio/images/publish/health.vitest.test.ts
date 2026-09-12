/**
 * PES.7 — health readings. The fixtures reproduce the two channels measured on GALE-JACKET:
 * eBay records real outcomes and real durations; Amazon records neither.
 */
import { describe, expect, it } from 'vitest'

import { formatDuration, outcomeSentence, summariseHealth } from './health'
import type { PublishJob } from './jobs'

const NOW = new Date('2026-09-01T12:00:00Z')
const line = (sku: string, accepted = true, errors: Array<{ code: string; message: string }> = []) =>
  ({ sku, asin: null, accepted, errors })

/** An Amazon row as prod actually holds it: IN_PROGRESS, receipt, swept completion 26 days later. */
const amazonStranded = (id: string): PublishJob => ({
  id, channel: 'AMAZON', marketplace: 'ES', status: 'IN_PROGRESS',
  submittedAt: '2026-06-10T22:24:32.816Z', completedAt: '2026-07-06T12:06:10.908Z',
  errorMessage: null, perSku: Array.from({ length: 18 }, (_, i) => line(`S${i}`)),
})
const amazonDone = (id: string): PublishJob => ({
  id, channel: 'AMAZON', marketplace: 'IT', status: 'DONE',
  submittedAt: '2026-06-06T10:21:11Z', completedAt: null,
  errorMessage: 'No variants with ASINs + images found.',
})
const ebay = (id: string, status: string, secs: number, error: string | null = null): PublishJob => ({
  id, channel: 'EBAY', marketplace: 'IT', status,
  submittedAt: '2026-07-20T03:09:00.000Z',
  completedAt: new Date(Date.parse('2026-07-20T03:09:00.000Z') + secs * 1000).toISOString(),
  errorMessage: error,
})

describe('summariseHealth — Amazon, where almost nothing is recorded', () => {
  const [amazon] = summariseHealth([amazonStranded('a'), amazonStranded('b'), amazonDone('c')], NOW)

  it('counts the verdict-less attempts rather than dropping them', () => {
    expect(amazon.attempts).toBe(3)
    expect(amazon.recordedSuccess).toBe(1)
    expect(amazon.unrecorded).toBe(2)
  })

  it('never treats "ended, nothing rejected" as a recorded success', () => {
    expect(amazon.recordedSuccess).not.toBe(3)
  })

  it('refuses to time a completion a sweep wrote weeks later', () => {
    // The two stranded rows are 26 days wide. Timing them would report a fortnight-long publish.
    expect(amazon.duration).toBeNull()
    expect(amazon.durationNote).toMatch(/written later by a sweep/)
  })

  it('still totals the SKU lines it does have', () => {
    expect(amazon.skuLines).toBe(36)
    expect(amazon.skuRejected).toBe(0)
  })
})

describe('summariseHealth — eBay, where outcomes and durations are real', () => {
  const jobs = [
    ebay('1', 'DONE', 61), ebay('2', 'DONE', 1), ebay('3', 'DONE', 153),
    ebay('4', 'FATAL', 30, 'inventory_item PUT 400'),
    ebay('5', 'FATAL', 40, 'inventory_item PUT 400'),
  ]
  const [health] = summariseHealth(jobs, NOW)

  it('records both verdicts and leaves nothing unaccounted', () => {
    expect(health).toMatchObject({ attempts: 5, recordedSuccess: 3, recordedFailure: 2, unrecorded: 0 })
  })

  it('times every attempt, because the publisher recorded each finish', () => {
    expect(health.duration).toEqual({ n: 5, medianSeconds: 40, maxSeconds: 153 })
    expect(health.durationNote).toBeNull()
  })

  it('groups the repeated failure', () => {
    expect(health.errors).toEqual([{ message: 'inventory_item PUT 400', count: 2 }])
  })
})

describe('summariseHealth — shape', () => {
  it('orders channels by how busy they are', () => {
    const out = summariseHealth([
      ebay('1', 'DONE', 10),
      amazonStranded('a'), amazonStranded('b'), amazonStranded('c'),
    ], NOW)
    expect(out.map((h) => h.channel)).toEqual(['AMAZON', 'EBAY'])
  })

  it('reports the most recent attempt, not the first seen', () => {
    const [h] = summariseHealth([
      ebay('1', 'DONE', 10),
      { ...ebay('2', 'DONE', 10), submittedAt: '2026-07-28T03:01:36.000Z' },
    ], NOW)
    expect(h.lastAttemptAt).toBe('2026-07-28T03:01:36.000Z')
  })

  it('an empty job list yields no cards rather than an empty card', () => {
    expect(summariseHealth([], NOW)).toEqual([])
  })
})

describe('outcomeSentence — never a bare percentage', () => {
  const base = {
    channel: 'X', attempts: 43, lastAttemptAt: null, duration: null, durationNote: null,
    skuLines: 0, skuRejected: 0, errors: [],
  }

  it('names the attempts a rate would have silently dropped', () => {
    const s = outcomeSentence({ ...base, recordedSuccess: 6, recordedFailure: 0, unrecorded: 37 })
    expect(s).toBe('all 6 recorded outcomes succeeded — the other 37 of 43 attempts record no outcome at all.')
    expect(s).not.toMatch(/%/)
  })

  it('says so plainly when nothing at all is recorded', () => {
    const s = outcomeSentence({ ...base, recordedSuccess: 0, recordedFailure: 0, unrecorded: 43 })
    expect(s).toMatch(/No outcome is recorded for any of the 43 attempts/)
  })

  it('reads cleanly when every attempt is accounted for', () => {
    const s = outcomeSentence({ ...base, attempts: 35, recordedSuccess: 22, recordedFailure: 13, unrecorded: 0 })
    expect(s).toBe('22 of 35 recorded outcomes succeeded, 13 failed.')
  })

  it('never emits a percent sign in any shape', () => {
    for (const [ok, bad, un] of [[6, 0, 37], [0, 0, 43], [22, 13, 0], [1, 1, 1]]) {
      expect(outcomeSentence({ ...base, recordedSuccess: ok, recordedFailure: bad, unrecorded: un }))
        .not.toMatch(/%/)
    }
  })
})

describe('formatDuration', () => {
  it.each([[1, '1s'], [61, '61s'], [90, '2 min'], [3600, '60 min'], [86_400, '24 h'], [2_409_392, '28 days']])(
    '%is → %s', (secs, expected) => { expect(formatDuration(secs)).toBe(expected) },
  )
})
