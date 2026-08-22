/** AX-ZD.2 — dataset taxonomy, routing, and honest latency labelling. */
import { describe, it, expect } from 'vitest'
import {
  familyOf, isRealTime, maxLatencyHours, adProductOf, routeRecords,
  readBudgetUsage, readEntityChange,
  AMS_ALL_DATASETS, AMS_CHANGE_DATASETS, AMS_PERFORMANCE_DATASETS,
} from './ams-dataset.js'

describe('familyOf', () => {
  it('classifies all three families', () => {
    expect(familyOf('sp-traffic')).toBe('PERFORMANCE')
    expect(familyOf('sb-conversion')).toBe('PERFORMANCE')
    expect(familyOf('campaigns')).toBe('CHANGE')
    expect(familyOf('targets')).toBe('CHANGE')
    expect(familyOf('budget-usage')).toBe('BUDGET')
  })
  it('an unrecognised dataset is UNKNOWN, not silently PERFORMANCE', () => {
    expect(familyOf('some-new-stream')).toBe('UNKNOWN')
    expect(familyOf(null)).toBe('UNKNOWN')
    expect(familyOf('')).toBe('UNKNOWN')
  })
  it('tolerates a variant of a known performance id', () => {
    expect(familyOf('sp-traffic-v2')).toBe('PERFORMANCE')
  })
})

describe('latency honesty — the claim we must not overstate', () => {
  it('only CHANGE and BUDGET are genuinely event-driven', () => {
    for (const d of AMS_CHANGE_DATASETS) expect(isRealTime(d)).toBe(true)
    expect(isRealTime('budget-usage')).toBe(true)
  })
  it('performance datasets are NOT real-time — hourly rollups up to ~4h late', () => {
    for (const d of AMS_PERFORMANCE_DATASETS) {
      expect(isRealTime(d), `${d} must not be labelled real-time`).toBe(false)
      expect(maxLatencyHours(d)).toBe(4)
    }
  })
  it('event-driven families advertise zero latency', () => {
    expect(maxLatencyHours('campaigns')).toBe(0)
    expect(maxLatencyHours('budget-usage')).toBe(0)
    expect(maxLatencyHours('nope')).toBeNull()
  })
})

describe('the change stream — the only Seller Central edit signal', () => {
  it('subscribing it is what makes external edits observable at all', () => {
    // Without these four, the system cannot distinguish an operator's Seller
    // Central edit from a write of ours that has not landed yet.
    expect([...AMS_ALL_DATASETS]).toEqual(expect.arrayContaining(['campaigns', 'adgroups', 'ads', 'targets']))
  })
  it('reads a campaign change with its tracked fields', () => {
    const e = readEntityChange('campaigns', { campaignId: '123', state: 'paused', budget: 25, noise: 'x' })!
    expect(e.entityType).toBe('CAMPAIGN')
    expect(e.externalId).toBe('123')
    expect(e.changes).toEqual({ state: 'paused', budget: 25 })
    expect(e.changes.noise).toBeUndefined()
  })
  it('handles snake_case and numeric ids', () => {
    expect(readEntityChange('adgroups', { ad_group_id: 77, bid: 1.2 })!.externalId).toBe('77')
    expect(readEntityChange('targets', { keyword_id: 'kw1' })!.entityType).toBe('TARGET')
  })
  it('returns null rather than inventing an id', () => {
    expect(readEntityChange('campaigns', { state: 'paused' })).toBeNull()
    expect(readEntityChange('not-a-change-stream', { campaignId: '1' })).toBeNull()
  })
})

describe('budget-usage — a percentage stream, not a boolean', () => {
  it('derives exhaustion from the crossing of the last bucket', () => {
    // The feed emits at 5% increments, so the exact instant of exhaustion is
    // unobservable. >=100 is the most precise reading available.
    expect(readBudgetUsage({ budgetUsagePercent: 100 })!.exhausted).toBe(true)
    expect(readBudgetUsage({ budgetUsagePercent: 105 })!.exhausted).toBe(true)
    expect(readBudgetUsage({ budgetUsagePercent: 95 })!.exhausted).toBe(false)
  })
  it('warns on the last actionable bucket', () => {
    expect(readBudgetUsage({ budgetUsagePercent: 95 })!.warning).toBe(true)
    expect(readBudgetUsage({ budgetUsagePercent: 90 })!.warning).toBe(false)
    // Exhausted is not also "warning" — they are distinct states.
    expect(readBudgetUsage({ budgetUsagePercent: 100 })!.warning).toBe(false)
  })
  it('accepts snake_case and refuses garbage', () => {
    expect(readBudgetUsage({ budget_usage_percent: 50 })!.budgetUsagePercent).toBe(50)
    expect(readBudgetUsage({})).toBeNull()
    expect(readBudgetUsage({ budgetUsagePercent: 'lots' })).toBeNull()
  })

  /**
   * ADM-P6/B2 — the two fields persistence needs. Until this feed opens, its record shape is a
   * candidate rather than an observation (0 records in 117,802 poll runs), so the parser accepts
   * both conventions Amazon uses elsewhere and the tests pin both.
   */
  describe('the fields persistence needs', () => {
    it('reads the pull API spelling', () => {
      const ev = readBudgetUsage({ budgetUsagePercent: 61, campaignId: 'c1', usageUpdatedTimestamp: '2026-08-22T10:22:53Z', budget: 3.2 })!
      expect(ev.asOf?.toISOString()).toBe('2026-08-22T10:22:53.000Z')
      expect(ev.budgetCents).toBe(320)
    })

    it('reads the performance-dataset spelling', () => {
      const ev = readBudgetUsage({ budget_usage_percent: 61, campaign_id: 'c1', time_window_start: '2026-08-22T10:00:00Z', budget_value: 1.74 })!
      expect(ev.asOf?.toISOString()).toBe('2026-08-22T10:00:00.000Z')
      expect(ev.budgetCents).toBe(174)
    })

    /**
     * 🔴 Null is a real answer, not a parse failure. A reading with no timestamp cannot be placed
     * in a budget day, and the persister must refuse it rather than stamp it with our own clock —
     * the pull API proved what a misplaced reading costs (27.2% stamped the previous evening still
     * read plausible hours after the reset).
     */
    it('returns a null instant rather than inventing one', () => {
      const ev = readBudgetUsage({ budgetUsagePercent: 100, campaignId: 'c1' })!
      expect(ev.asOf).toBeNull()
      expect(ev.budgetUsagePercent).toBe(100)   // the percentage still parsed
      expect(ev.exhausted).toBe(true)
    })

    it('returns a null budget rather than a fabricated zero', () => {
      expect(readBudgetUsage({ budgetUsagePercent: 40, campaignId: 'c1' })!.budgetCents).toBeNull()
      expect(readBudgetUsage({ budgetUsagePercent: 40, campaignId: 'c1', budget: 0 })!.budgetCents).toBe(0)
    })

    it('rejects an unparseable timestamp instead of passing an Invalid Date through', () => {
      expect(readBudgetUsage({ budgetUsagePercent: 40, campaignId: 'c1', usageUpdatedTimestamp: 'yesterday' })!.asOf).toBeNull()
    })
  })

})

describe('routeRecords — three families, three consumers', () => {
  it('splits a mixed batch and loses nothing', () => {
    const r = routeRecords([
      { dataset_id: 'sp-traffic', impressions: 1 },
      { dataset_id: 'campaigns', campaignId: '1' },
      { dataset_id: 'budget-usage', budgetUsagePercent: 100 },
      { dataset_id: 'mystery' },
      { datasetId: 'sb-conversion' },
    ])
    expect(r.performance).toHaveLength(2)
    expect(r.change).toHaveLength(1)
    expect(r.budget).toHaveLength(1)
    expect(r.unknown).toHaveLength(1)
    const total = r.performance.length + r.change.length + r.budget.length + r.unknown.length
    expect(total).toBe(5) // nothing silently dropped
  })
  it('adProductOf maps the performance prefixes', () => {
    expect(adProductOf('sp-traffic')).toBe('SPONSORED_PRODUCTS')
    expect(adProductOf('sb-conversion')).toBe('SPONSORED_BRANDS')
    expect(adProductOf('sd-traffic')).toBe('SPONSORED_DISPLAY')
    expect(adProductOf('campaigns')).toBeNull()
  })
})
