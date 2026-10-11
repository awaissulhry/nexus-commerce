import { describe, expect, it } from 'vitest'
import { clauseWords, runRollbackable, runSummary, runWord, settingGroups, thenWords, type RunRow } from './ruleSettings'

describe('a rule’s settings, grouped', () => {
  const stored = {
    id: 'r1', name: 'Rule A', trigger: 'TARGET_PERFORMANCE', enabled: true, autonomyLevel: 'PROPOSE', priority: 100,
    maxExecutionsPerDay: 10, maxWritesPerDay: null, maxValueCentsEur: null, maxDailyAdSpendCentsEur: 10000, scopeMarketplace: 'IT',
    createdAt: '2026-10-10T08:00:00Z', createdBy: 'user', evaluationCount: 0,
    conditions: [{ conditions: [{ metric: 'ACOS', op: 'gt', value: '35' }, { metric: 'Clicks', op: 'gte', value: '10' }], action: { op: 'decPct', value: '15' } }],
    actions: [{ type: 'bid', control: 'manual', bidFloor: 0.05, bidCeiling: null, windowDays: 30, campaigns: [], schedule: { frequency: 'Daily', time: '06:00', timezone: 'cet' } }],
  }

  it('a builder rule: its blocks, bids, scope, runs, limits, mode — in the page’s plain words', () => {
    const groups = settingGroups(stored)
    const get = (id: string) => Object.fromEntries((groups.find((g) => g.id === id)?.items ?? []).map((i) => [i.label, i.value]))
    expect(get('when')).toEqual({ 'If → then': 'If ACoS > 35 % and clicks ≥ 10 → bid −15 %' })
    expect(get('bids')).toEqual({ Lowest: '€0.05', Highest: 'No max', Over: '30 d' })
    expect(get('scope')).toMatchObject({ Market: 'IT', Campaigns: 'Whole market' })
    expect(get('runs')).toMatchObject({ When: 'Daily · 06:00 · Rome' })
    // The engine never reads a bid rule's `dedupe`, so Settings never shows it.
    expect(get('runs')).not.toHaveProperty('Once a day')
    expect(get('caps')).toEqual({ 'Keywords a day': '10', 'Changes a day': 'No max', 'Most per run': 'No max', 'Ad spend a day': '€100.00' })
    // One group, and no heading that repeats its own label; a person is "You".
    expect(get('mode')).toEqual({ Mode: 'Ask me', Order: '100', Created: '10 Oct · You', Runs: '0' })
    expect(groups.map((g) => g.title)).not.toContain('Created')
  })

  it('one block’s line is not repeated (the subtitle says it); bids are in the rule’s money', () => {
    const groups = settingGroups(stored, { sentence: 'If ACoS > 35 % and clicks ≥ 10 over 30 d → bid −15 %', currency: 'GBP' })
    // One block: its line is the detail's subtitle, so Settings does not repeat it.
    expect(groups.find((g) => g.id === 'when')).toBeUndefined()
    expect(groups.find((g) => g.id === 'bids')!.items[0]).toEqual({ label: 'Lowest', value: '£0.05' })
    // The engine's own schedule words win over a reading of the stored fields.
    expect(settingGroups(stored, { schedule: 'Every 15 min' }).find((g) => g.id === 'runs')!.items[0]).toEqual({ label: 'When', value: 'Every 15 min' })
  })

  it('the words of a condition and of its THEN', () => {
    expect(clauseWords({ metric: 'Spend', op: 'gt', value: '5' })).toBe('spend > €5')
    expect(clauseWords({ field: 'metrics.CTR', op: 'lt', value: '0.3' })).toBe('CTR < 0.3 %')
    expect(thenWords({ op: 'targetAcos', value: '25' })).toBe('bid toward 25 %')
    expect(thenWords({ op: 'decAbs', value: '0.05' }, 'GBP')).toBe('bid −£0.05')
    expect(thenWords({ op: 'revPerClick' })).toBe('bid = sales/click')
    expect(thenWords({ op: 'mystery' })).toBe('mystery')
  })

  it('an engine rule: trigger, conditions and actions as stored; switched off reads Off', () => {
    const groups = settingGroups({ id: 'r2', name: 'Rule B', trigger: 'KEYWORD_HIGH_ACOS', enabled: false, autonomyLevel: 'AUTO', conditions: [], actions: [{ type: 'bid_down', percent: 20 }] })
    const when = groups.find((g) => g.id === 'when')!.items
    expect(when).toEqual([{ label: 'Trigger', value: 'keyword high acos' }, { label: 'Then', value: 'bid down 20 %' }])
    expect(groups.find((g) => g.id === 'mode')!.items[0]).toEqual({ label: 'Mode', value: 'Off' })
  })
})

describe('runs', () => {
  const now = Date.parse('2026-10-10T12:00:00Z')
  const run = (over: Partial<RunRow>): RunRow => ({ id: 'e1', status: 'SUCCESS', dryRun: false, startedAt: '2026-10-10T08:00:00Z', errorMessage: null, actionResults: [], ...over })

  it('what a run did, in a word and a line', () => {
    expect(runWord(run({}))).toEqual({ text: 'Applied', tone: 'success' })
    expect(runWord(run({ dryRun: true, status: 'DRY_RUN' }))).toEqual({ text: 'Asked', tone: 'info' })
    expect(runWord(run({ status: 'NO_MATCH' })).text).toBe('No match')
    expect(runSummary(run({ actionResults: [{ type: 'bid_apply', ok: true, output: { wouldChange: '38¢ → 30¢' } }, { type: 'bid_apply', ok: true, output: { skipped: 'held' } }] }))).toBe('38¢ → 30¢')
    expect(runSummary(run({ errorMessage: 'Cap reached' }))).toBe('Cap reached')
  })

  it('a whole run rolls back only when it wrote, inside 24 h', () => {
    expect(runRollbackable(run({}), now)).toBe(true)
    expect(runRollbackable(run({ dryRun: true }), now)).toBe(false)
    expect(runRollbackable(run({ startedAt: '2026-10-09T08:00:00Z' }), now)).toBe(false)
  })
})
