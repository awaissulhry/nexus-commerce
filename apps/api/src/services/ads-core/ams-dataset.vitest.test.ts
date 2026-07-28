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
