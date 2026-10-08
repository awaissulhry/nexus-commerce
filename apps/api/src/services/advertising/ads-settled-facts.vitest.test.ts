/**
 * BB-14 — the newest settled day per ad product, from the report jobs, and the prime that hands it to the settled window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jobFindMany = vi.fn()
vi.mock('../../db.js', () => ({ default: { amazonAdsReportJob: { findMany: (...a: unknown[]) => jobFindMany(...a) } } }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { settledFactsOf, primeSettledWindow, resetSettledPrime } = await import('./ads-settled-facts.js')
const { clearSettledFacts, settledEnd } = await import('./ads-settled-window.js')

const NOW = new Date('2026-10-08T03:00:00.000Z')
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
/** A ranged settling pull asked at 01:15 on `asked` for [asked − 8, asked − 1]: it settles asked − 8 (SP). */
function pull(profileId: string, reportTypeId: string, asked: string, over: Record<string, unknown> = {}) {
  const at = new Date(`${asked}T01:15:00.000Z`)
  const adProduct = reportTypeId.startsWith('sp') ? 'SPONSORED_PRODUCTS' : reportTypeId.startsWith('sb') ? 'SPONSORED_BRANDS' : 'SPONSORED_DISPLAY'
  const span = adProduct === 'SPONSORED_PRODUCTS' ? 8 : 15
  return { profileId, adProduct, reportTypeId, startDate: new Date(at.getTime() - span * 86_400_000), endDate: new Date(at.getTime() - 86_400_000), createdAt: at, status: 'COMPLETED', ingestedAt: at, ...over }
}

describe('settledFactsOf', () => {
  it('is the oldest newest-settled day over every account and report the decisions read', () => {
    const facts = settledFactsOf([
      pull('p-it', 'spCampaigns', '2026-10-08'),
      pull('p-it', 'spSearchTerm', '2026-10-08'),
      pull('p-de', 'spCampaigns', '2026-10-07'), // DE's settling pull of last night has not landed yet
    ], NOW)
    expect(facts.spThrough).toEqual(d('2026-09-29'))
    expect(facts.otherThrough).toBeNull() // no Brands/Display report ran
  })

  it('a report that ran recently and settled nothing makes the fact unknown (null)', () => {
    const facts = settledFactsOf([
      pull('p-it', 'spCampaigns', '2026-10-08'),
      { ...pull('p-it', 'spTargeting', '2026-10-07'), startDate: d('2026-10-06'), endDate: d('2026-10-06') }, // a morning-after pull only
    ], NOW)
    expect(facts.spThrough).toBeNull()
  })

  it('a report that stopped (dormant ad product) drops out after 14 days', () => {
    const facts = settledFactsOf([
      pull('p-it', 'spCampaigns', '2026-10-08'),
      { ...pull('p-it', 'sbCampaigns', '2026-09-20'), ingestedAt: null, status: 'FAILED' },
    ], NOW)
    expect(facts.spThrough).toEqual(d('2026-09-30'))
    expect(facts.otherThrough).toBeNull()
  })

  it('Brands and Display settle on their own 14-day window', () => {
    const facts = settledFactsOf([pull('p-it', 'sbCampaigns', '2026-10-08'), pull('p-it', 'sdCampaigns', '2026-10-08')], NOW)
    expect(facts.otherThrough).toEqual(d('2026-09-23'))
  })
})

describe('primeSettledWindow', () => {
  beforeEach(() => { resetSettledPrime(); clearSettledFacts(); jobFindMany.mockReset() })
  afterEach(() => { vi.useRealTimers(); clearSettledFacts() })

  it('hands the window the facts, and reads at most once per 15 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    jobFindMany.mockResolvedValue([pull('p-it', 'spCampaigns', '2026-10-08'), pull('p-it', 'spSearchTerm', '2026-10-08'), pull('p-it', 'spTargeting', '2026-10-08')])
    await primeSettledWindow()
    await primeSettledWindow()
    expect(jobFindMany).toHaveBeenCalledTimes(1)
    // The clock rule ends SP on 10-01; the newest settled day is 09-30.
    expect(settledEnd('SPONSORED_PRODUCTS', { now: NOW })).toMatchObject({ settledThrough: d('2026-09-30'), shiftDays: 1, stillFilling: false })
    vi.setSystemTime(new Date(NOW.getTime() + 16 * 60_000))
    await primeSettledWindow()
    expect(jobFindMany).toHaveBeenCalledTimes(2)
  })

  it('never fails its caller: a read error keeps the clock rule', async () => {
    jobFindMany.mockRejectedValue(new Error('db down'))
    await expect(primeSettledWindow()).resolves.toBeUndefined()
    expect(settledEnd('SPONSORED_PRODUCTS', { now: NOW })).toMatchObject({ shiftDays: 0, known: false })
  })
})
