/**
 * P2.7 — the AMS subscription check.
 *
 * The plan's own row says these were "not checked today", and they were not: the only
 * thing that lists them is an operator-pressed route. The failure is silent by nature —
 * a subscription never created, or dropped by Amazon, produces no error anywhere, just
 * an hour of advertising data that never arrives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let connections: Array<{ marketplace: string; profileId: string }> = []
let listResponse: any = { subscriptions: [] }
let listThrows: string | null = null

vi.mock('../db.js', () => ({
  default: { amazonAdsConnection: { findMany: async () => connections } },
}))
vi.mock('../services/advertising/ads-marketing-stream.service.js', () => ({
  AMS_DATASETS: ['sp-traffic', 'sp-conversion'],
  amsRegionFor: (m?: string | null) => (m === 'US' ? 'NA' : 'EU'),
  listAmsSubscriptions: async () => {
    if (listThrows) throw new Error(listThrows)
    return listResponse
  },
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_n: string, f: any) => f() }))

const { runAmsSubscriptionCheck } = await import('./ams-subscription-check.job.js')

beforeEach(() => {
  connections = [{ marketplace: 'IT', profileId: '111' }]
  listResponse = { subscriptions: [{ dataSetId: 'sp-traffic', status: 'ACTIVE' }, { dataSetId: 'sp-conversion', status: 'ACTIVE' }] }
  listThrows = null
})

describe('what the check reports', () => {
  it('reports a profile with every dataset as complete', async () => {
    const result = await runAmsSubscriptionCheck()
    expect(result).toMatchObject({ profiles: 1, fullySubscribed: 1, withGaps: 0, unreadable: 0 })
  })

  it('names the datasets a profile is missing', async () => {
    listResponse = { subscriptions: [{ dataSetId: 'sp-traffic', status: 'ACTIVE' }] }
    const result = await runAmsSubscriptionCheck()
    expect(result.withGaps).toBe(1)
    expect(result.detail[0].missing).toEqual(['sp-conversion'])
  })

  it('counts an ARCHIVED subscription as missing, because it delivers nothing', async () => {
    // Present in the list and silent: the most misleading of the three states, because
    // a count of subscriptions would call this profile healthy.
    listResponse = { subscriptions: [{ dataSetId: 'sp-traffic', status: 'ACTIVE' }, { dataSetId: 'sp-conversion', status: 'ARCHIVED' }] }
    const result = await runAmsSubscriptionCheck()
    expect(result.detail[0].missing).toEqual(['sp-conversion'])
  })

  it('reports a profile it COULD NOT ASK as unknown — never as missing', async () => {
    listThrows = 'Amazon Ads returned 502'
    const result = await runAmsSubscriptionCheck()
    // The distinction this check exists to preserve. `/advertising/ams/subscribe`
    // swallows a failed list and then tries to create EVERY dataset, treating "could
    // not read" as "nothing subscribed" — opposite facts.
    expect(result.unreadable).toBe(1)
    expect(result.withGaps).toBe(0)
    expect(result.detail[0].status).toBe('unknown')
    expect(result.detail[0].missing).toEqual([])
    expect(result.detail[0].error).toContain('502')
  })

  it('does not report an empty sweep as healthy', async () => {
    connections = []
    const result = await runAmsSubscriptionCheck()
    // A green with an empty denominator is the most reassuring wrong answer there is.
    expect(result.profiles).toBe(0)
    expect(result.fullySubscribed).toBe(0)
  })

  it('asks each marketplace in its own region', async () => {
    connections = [{ marketplace: 'US', profileId: '1' }, { marketplace: 'IT', profileId: '2' }]
    const result = await runAmsSubscriptionCheck()
    // A wrong region makes every list fail and every profile read as unreadable,
    // which looks like an Amazon outage rather than a mapping bug.
    expect(result.profiles).toBe(2)
    expect(result.fullySubscribed).toBe(2)
  })
})
