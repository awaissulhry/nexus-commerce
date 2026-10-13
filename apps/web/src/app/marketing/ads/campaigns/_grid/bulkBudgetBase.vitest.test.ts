/**
 * Editing correctness (group 3) — the Ad Manager's bulk budget is built on the budget it showed, and says which.
 *
 * The Campaigns list comes through the API's 300-s read cache, so "+10 %" could be worked out from a budget up to 5 minutes
 * old and silently overwrite a budget schedule's or an engine's change. Each campaign's write now carries the budget it
 * was worked out from (`expectedDailyBudget`); the server refuses that campaign when its budget moved since
 * (apps/api ads-undo-changed-since.vitest.test.ts). The re-read after a save reads past the cache.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bulkBudgetPatch } from '../../_shared/budgetInput'
import { campaignsListPath, LIST_CACHE_MS, readsFresh } from './campaignsRead'

const grid = readFileSync(join(__dirname, '..', 'CampaignsGrid.tsx'), 'utf8')

describe('a bulk Set / +% / −% sends the budget it was worked out from', () => {
  it('+10 % on €12.34: €13.57, from €12.34', () => {
    expect(bulkBudgetPatch(12.34, 'incPct', 10)).toEqual({ dailyBudget: 13.57, expectedDailyBudget: 12.34 })
  })
  it('−50 % stops at €1.00 and still names the budget it saw', () => {
    expect(bulkBudgetPatch(1.5, 'decPct', 50)).toEqual({ dailyBudget: 1, expectedDailyBudget: 1.5 })
  })
  it('Set to €20.00 names the budget it saw too', () => {
    expect(bulkBudgetPatch(15, 'set', 20)).toEqual({ dailyBudget: 20, expectedDailyBudget: 15 })
  })
  it('the grid\'s bulk budget sends both (never the new budget alone)', () => {
    expect(grid).toContain('const next = bulkBudgetPatch(num(c.dailyBudget), ch.budget.mode, ch.budget.value)')
    expect(grid).toContain("{ applyImmediately: true, reason: 'Ad Manager bulk action', ...next }")
    expect(grid).not.toMatch(/body\.dailyBudget = next\b/)
  })
})

describe('the list is read past the API\'s cache after this screen\'s own write', () => {
  const now = 1_000_000_000
  it('"Refresh view" always; any read within the cache\'s lifetime after a write; otherwise the cache may answer', () => {
    expect(readsFresh(true, null, now)).toBe(true)
    expect(readsFresh(false, now - 1_000, now)).toBe(true)
    expect(readsFresh(false, now - LIST_CACHE_MS + 1, now)).toBe(true)
    expect(readsFresh(false, now - LIST_CACHE_MS, now)).toBe(false)
    expect(readsFresh(false, null, now)).toBe(false)
  })
  it('the path keeps its date range (local days) and asks fresh=1 only when told', () => {
    const range = { start: new Date(2026, 9, 6), end: new Date(2026, 9, 12) }
    expect(campaignsListPath({ range })).toBe('/api/advertising/campaigns?limit=500&startDate=2026-10-06&endDate=2026-10-12')
    expect(campaignsListPath({ range, fresh: true })).toBe('/api/advertising/campaigns?limit=500&startDate=2026-10-06&endDate=2026-10-12&fresh=1')
    expect(campaignsListPath({})).toBe('/api/advertising/campaigns?limit=500')
  })
  it('the grid marks every write and reads through readsFresh; the bulk save reads the list again', () => {
    expect(grid).toMatch(/async function patchWrite[\s\S]{0,200}lastWriteAt = Date\.now\(\)/)
    expect(grid).toContain('campaignsListPath({ range: opts?.range, fresh: readsFresh(!!opts?.sync, lastWriteAt) })')
    expect(grid).toMatch(/setTimeout\(\(\) => setApplyMsg\(''\), 6000\)\n\s+\/\/ Group 3[^\n]*\n\s+void load\(\{ range: dateRange \}\)/)
  })
})
