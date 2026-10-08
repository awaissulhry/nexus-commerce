/**
 * BB-13 — which days a nightly report pull covers so every ad day settles, and which days have settled (pure).
 */
import { describe, expect, it } from 'vitest'
import {
  ageDays,
  chunkRange,
  contiguousRuns,
  perDaySettleDays,
  pullSettles,
  settleRange,
  settleSpanDays,
  settledThrough,
  unsettledDays,
  MAX_FAILED_SETTLE_ATTEMPTS,
  type PullJob,
} from './ads-report-settle.js'

const NOW = new Date('2026-10-08T01:15:00.000Z')
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const KEY = { profileId: 'p-it', adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns' }

function job(over: Partial<PullJob> & { startDate: Date; endDate: Date; createdAt: Date }): PullJob {
  return { profileId: 'p-it', adProduct: 'SPONSORED_PRODUCTS', reportTypeId: 'spCampaigns', status: 'COMPLETED', ingestedAt: over.createdAt, ...over }
}

describe('nightly span', () => {
  it('Sponsored Products re-reads 8 days ending yesterday, Brands and Display 15', () => {
    expect(settleSpanDays('SPONSORED_PRODUCTS')).toBe(8)
    expect(settleSpanDays('SPONSORED_BRANDS')).toBe(15)
    expect(settleSpanDays('SPONSORED_DISPLAY')).toBe(15)
    expect(settleRange('SPONSORED_PRODUCTS', NOW)).toEqual({ startDate: '2026-09-30', endDate: '2026-10-07' })
    expect(settleRange('SPONSORED_BRANDS', NOW)).toEqual({ startDate: '2026-09-23', endDate: '2026-10-07' })
  })

  it('a per-day report asks yesterday (first copy) and the day that completes tonight (settled copy)', () => {
    expect(perDaySettleDays('SPONSORED_PRODUCTS', NOW)).toEqual(['2026-10-07', '2026-09-30'])
  })

  it('the oldest day of tonight\'s span is complete; the next one is not yet', () => {
    expect(ageDays('2026-09-30', NOW)).toBe(7)
    expect(pullSettles('2026-09-30', NOW, 'SPONSORED_PRODUCTS')).toBe(true)
    expect(pullSettles('2026-10-01', NOW, 'SPONSORED_PRODUCTS')).toBe(false)
    // Brands needs 14 days.
    expect(pullSettles('2026-09-30', NOW, 'SPONSORED_BRANDS')).toBe(false)
    expect(pullSettles('2026-09-23', NOW, 'SPONSORED_BRANDS')).toBe(true)
    // The morning-after pull is age 0, never negative.
    expect(ageDays('2026-10-07', NOW)).toBe(0)
    expect(ageDays('2026-10-08', NOW)).toBe(0)
  })
})

describe('ranges Amazon accepts', () => {
  it('chunks a range into at most 30 days, newest first', () => {
    expect(chunkRange('2026-08-09', '2026-09-30')).toEqual([
      { startDate: '2026-09-01', endDate: '2026-09-30' },
      { startDate: '2026-08-09', endDate: '2026-08-31' },
    ])
    expect(chunkRange('2026-09-30', '2026-09-01')).toEqual([])
  })

  it('groups loose days into contiguous runs of at most 30', () => {
    expect(contiguousRuns(['2026-09-01', '2026-09-03', '2026-09-02', '2026-09-10'])).toEqual([
      { startDate: '2026-09-10', endDate: '2026-09-10' },
      { startDate: '2026-09-01', endDate: '2026-09-03' },
    ])
    const many = Array.from({ length: 45 }, (_, i) => new Date(d('2026-08-01').getTime() + i * 86_400_000).toISOString().slice(0, 10))
    const runs = contiguousRuns(many)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual({ startDate: '2026-08-16', endDate: '2026-09-14' })
  })
})

describe('settledThrough', () => {
  it('is the newest day a settling pull of that report has ingested', () => {
    const jobs = [
      // The morning-after pull of 10-06: young, settles nothing.
      job({ startDate: d('2026-10-06'), endDate: d('2026-10-06'), createdAt: new Date('2026-10-07T01:15:00Z') }),
      // Last night's ranged pull: settles 09-29 (the oldest day of its span).
      job({ startDate: d('2026-09-29'), endDate: d('2026-10-06'), createdAt: new Date('2026-10-07T01:15:00Z') }),
      // Another market's job never counts.
      job({ profileId: 'p-de', startDate: d('2026-09-30'), endDate: d('2026-10-07'), createdAt: NOW }),
    ]
    expect(settledThrough(jobs, KEY)?.toISOString().slice(0, 10)).toBe('2026-09-29')
  })

  it('a job not yet ingested, or failed, settles nothing', () => {
    const jobs = [
      job({ startDate: d('2026-09-30'), endDate: d('2026-10-07'), createdAt: NOW, ingestedAt: null }),
      job({ startDate: d('2026-09-30'), endDate: d('2026-10-07'), createdAt: NOW, status: 'FAILED', ingestedAt: null }),
    ]
    expect(settledThrough(jobs, KEY)).toBeNull()
  })
})

describe('unsettledDays', () => {
  const from = d('2026-09-25')
  const to = d('2026-09-30')

  it('lists every day with no settling pull, newest first', () => {
    const jobs = [job({ startDate: d('2026-09-25'), endDate: d('2026-09-25'), createdAt: new Date('2026-09-26T01:15:00Z') })]
    expect(unsettledDays(jobs, KEY, from, to, NOW).days).toEqual(['2026-09-30', '2026-09-29', '2026-09-28', '2026-09-27', '2026-09-26', '2026-09-25'])
  })

  it('skips days a settling pull covers, ingested or still in flight', () => {
    const jobs = [
      job({ startDate: d('2026-09-28'), endDate: d('2026-09-30'), createdAt: NOW }),
      job({ startDate: d('2026-09-25'), endDate: d('2026-09-26'), createdAt: NOW, status: 'PENDING', ingestedAt: null }),
    ]
    expect(unsettledDays(jobs, KEY, from, to, NOW).days).toEqual(['2026-09-27'])
  })

  it(`gives a day up after ${MAX_FAILED_SETTLE_ATTEMPTS} failed settling pulls (a lost download link counts as failed)`, () => {
    const failed = (at: string) => job({ startDate: d('2026-09-27'), endDate: d('2026-09-27'), createdAt: new Date(at), status: 'FAILED', ingestedAt: null })
    const stranded = job({ startDate: d('2026-09-26'), endDate: d('2026-09-26'), createdAt: new Date('2026-10-05T01:00:00Z'), ingestedAt: null })
    const r = unsettledDays([failed('2026-10-05T01:00:00Z'), failed('2026-10-06T01:00:00Z'), stranded], KEY, d('2026-09-26'), d('2026-09-27'), NOW)
    expect(r.givenUp).toEqual(['2026-09-27'])
    expect(r.days).toEqual(['2026-09-26'])
  })
})
