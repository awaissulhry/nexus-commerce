/**
 * ADS AUTONOMY W2 (AA-W2-11) — what Claude's rule may do with the automations themselves, pure (automation-limits.ts,
 * automation-levels.ts gateOfCounts). Values and names are made up (public repo). The reads (each switch's evidence, a
 * rule's scope in the strategy) run on PGlite in turn-automation, save-ad-rule and tune-ad-engine's own tests.
 *
 *   turn-up    the level ladder, the list, the gate, a rule's own caps; an env engine and a kind with no gate never
 *   gate       14 days, 10 runs, 1 match or decision, each said with what it counts
 *   save       where a rule's scope lands; a scope Nexus cannot place, a missing or too large cap, a level left at AUTO
 *   tune       no raise runs; a raise with a percent runs up to the limit; one without, or an older preview, never
 *   limits     every default runs nothing new alone, and tightening stays a free brake
 */
import { describe, expect, it } from 'vitest'
import { limitsTighten } from '../claude-trust.service.js'
import { gateOfCounts } from '../../automation/automation-levels.js'
import { SAVE_RULE_LIMITS, TUNE_LIMITS, TURN_UP_LIMITS, ruleSaveRefusal, ruleScopeItem, tuneRefusal, turnUpRefusal } from './automation-limits.js'

const DAY = 86_400_000
const NOW = new Date('2026-10-06T12:00:00Z')

describe('the graduation gate from counts', () => {
  it('14 days, 10 runs, 1 match or decision — each check says what it counts', () => {
    const open = gateOfCounts({ createdAt: new Date(NOW.getTime() - 15 * DAY), runs: 10, matches: 1, runsAre: 'rebalances', matchesAre: 'that would move budget', from: 'TEST', now: NOW })
    expect(open).toEqual({ open: true, from: 'TEST', checks: [
      { check: '14 days watched', passed: true, detail: '15/14 days since it was made' },
      { check: '10 runs', passed: true, detail: '10/10 rebalances' },
      { check: '1 match or decision', passed: true, detail: '1 that would move budget' },
    ] })
    expect(gateOfCounts({ createdAt: new Date(NOW.getTime() - 13 * DAY), runs: 10, matches: 1, runsAre: 'x', matchesAre: 'y', from: 'TEST', now: NOW }).open).toBe(false)
    expect(gateOfCounts({ createdAt: new Date(NOW.getTime() - 30 * DAY), runs: 9, matches: 1, runsAre: 'x', matchesAre: 'y', from: 'TEST', now: NOW }).open).toBe(false)
    expect(gateOfCounts({ createdAt: new Date(NOW.getTime() - 30 * DAY), runs: 10, matches: 0, runsAre: 'x', matchesAre: 'y', from: 'TEST', now: NOW }).open).toBe(false)
  })
})

describe('turn-up-automation by rule', () => {
  const gate = (open: boolean, caps?: { maxWritesPerDay: number | null; maxValueCentsEur: number | null }) =>
    ({ open, from: 'TEST counts', checks: [{ check: '10 runs', passed: open, detail: open ? '12/10 runs' : '3/10 runs' }], ...(caps ? { caps } : {}) })
  const move = (to: string, extra: Record<string, unknown> = {}) => ({ to, automation: { id: 'A9', key: 'ads-budget-pools', name: 'Budget pools' }, row: { name: 'TEST pool' }, ...extra })
  const defaults = TURN_UP_LIMITS.parse({}) as Record<string, unknown>
  const listed = { ...defaults, maxLevel: 'AUTO', automations: ['A9'] }

  it('up to PROPOSE by default; AUTO needs maxLevel AUTO, the automation listed (number or key) and its gate open', () => {
    expect(turnUpRefusal(move('PROPOSE'), defaults)).toBeNull()
    expect(turnUpRefusal(move('AUTO', { gate: gate(true) }), defaults)).toBe('AUTO is above PROPOSE, the highest level allowed without a person')
    expect(turnUpRefusal(move('AUTO', { gate: gate(true) }), { ...listed, automations: [] })).toContain('Budget pools is not on the automations Claude may take to AUTO')
    expect(turnUpRefusal(move('AUTO', { gate: gate(true) }), listed)).toBeNull()
    expect(turnUpRefusal(move('AUTO', { gate: gate(true) }), { ...listed, automations: ['ads-budget-pools'] })).toBeNull()
    expect(turnUpRefusal(move('AUTO', { gate: gate(false) }), listed)).toBe('the graduation gate of TEST pool is not open (10 runs: 3/10 runs; from TEST counts); a person decides')
  })

  it('never: an env engine, a kind with no gate Nexus can check, no preview', () => {
    expect(turnUpRefusal(move('PROPOSE', { env: { ceiling: 'AUTO' } }), listed)).toBe('an engine switched up is never inside the limits: a person clicks it')
    expect(turnUpRefusal(move('AUTO', { gate: null }), listed)).toBe("TEST pool has no graduation gate Nexus can check (Budget pools), so AUTO stays a person's click")
    expect(turnUpRefusal(move('AUTO'), listed)).toContain('has no graduation gate Nexus can check')
    expect(turnUpRefusal(null, listed)).toBe('there is no preview of this move to check')
  })

  it('a rule goes to AUTO by rule only with its own caps set and within the limits', () => {
    const rule = (caps: { maxWritesPerDay: number | null; maxValueCentsEur: number | null }) => move('AUTO', { gate: gate(true, caps) })
    const roomy = { ...listed, maxRuleWritesPerDay: 50, maxRuleValueCentsEur: 2000 }
    expect(turnUpRefusal(rule({ maxWritesPerDay: 20, maxValueCentsEur: 500 }), roomy)).toBeNull()
    expect(turnUpRefusal(rule({ maxWritesPerDay: 20, maxValueCentsEur: 500 }), listed)).toContain('TEST pool may make up to 20 writes a day, more than the 0 this tool\'s limits allow a rule taken to AUTO without a person (0: none goes without a person)')
    expect(turnUpRefusal(rule({ maxWritesPerDay: null, maxValueCentsEur: 500 }), roomy)).toContain('TEST pool has no daily writes cap of its own')
    expect(turnUpRefusal(rule({ maxWritesPerDay: 20, maxValueCentsEur: 0 }), roomy)).toContain('has no cap on what one run may commit of its own')
  })
})

describe('save-ad-rule by rule', () => {
  it('where a rule\'s scope lands: a campaign, a product in a market, a market or a portfolio in it; never the whole account', () => {
    expect(ruleScopeItem({ campaignId: 'c1' })).toEqual({ item: { entity: { kind: 'campaign', id: 'c1' }, change: { field: 'rule' }, nexusOnly: true } })
    expect(ruleScopeItem({ marketplace: 'it', productId: 'p1' })).toMatchObject({ item: { entity: { kind: 'products', market: 'IT', productIds: ['p1'], label: 'a rule for one product' } } })
    expect(ruleScopeItem({ marketplace: 'IT' })).toMatchObject({ item: { entity: { kind: 'products', market: 'IT', productIds: [], label: 'a rule for the whole of IT' } } })
    expect(ruleScopeItem({ marketplace: 'IT', portfolioId: 'pf1' })).toMatchObject({ item: { entity: { label: 'a rule for a portfolio in IT' } } })
    expect(ruleScopeItem({ wholeAccount: true })).toEqual({ why: "a rule for the whole account cannot be placed in one market's ads strategy" })
    expect(ruleScopeItem({ productId: 'p1' })).toMatchObject({ why: expect.stringContaining('names no market') })
  })

  it('without the strategy\'s facts, for another kind, or with a scope Nexus cannot place: a person decides', () => {
    const defaults = SAVE_RULE_LIMITS.parse({}) as Record<string, unknown>
    expect(ruleSaveRefusal({ kind: 'marketing' }, defaults)).toBe('only an Amazon ads rule may be saved by rule (the ads strategy covers Amazon); a person decides')
    expect(ruleSaveRefusal({ kind: 'amazon-ads' }, defaults)).toContain('there are no limit facts in this preview')
    expect(ruleSaveRefusal({ kind: 'amazon-ads', ruleFacts: { scope: { placed: false, why: 'TEST why' }, caps: {}, levelAfter: 'OBSERVE' } }, defaults)).toBe('TEST why; a person decides')
  })
})

describe('tune-ad-engine by rule', () => {
  const defaults = TUNE_LIMITS.parse({}) as Record<string, unknown>
  it('no raise runs; a raise with a percent up to the limit; one without, or an older preview that has none, never', () => {
    expect(tuneRefusal({ raises: [], largestRaisePct: 0 }, defaults)).toBeNull()
    expect(tuneRefusal({ raises: ['TEST budget rises'], largestRaisePct: 20 }, defaults)).toBe("it can raise spend by up to 20 % (TEST budget rises), more than the 0 % this tool's limits let run without a person (0: every raise waits for a person); a person decides")
    expect(tuneRefusal({ raises: ['TEST budget rises'], largestRaisePct: 20 }, { maxRaisePct: 20 })).toBeNull()
    expect(tuneRefusal({ raises: ['TEST cap cleared'], largestRaisePct: null }, { maxRaisePct: 1000 })).toBe('it can raise spend in a way that has no percent (TEST cap cleared); a person decides')
    expect(tuneRefusal({ raises: ['TEST budget rises'] }, { maxRaisePct: 1000 })).toContain('has no percent')
    expect(tuneRefusal(null, defaults)).toBe('there is no preview of this setting change to check')
  })
})

describe('the limits', () => {
  it('every default runs nothing new alone; tightening is a free brake, loosening is not', () => {
    expect(TURN_UP_LIMITS.parse({})).toEqual({ maxLevel: 'PROPOSE', automations: [], maxRuleWritesPerDay: 0, maxRuleValueCentsEur: 0 })
    expect(SAVE_RULE_LIMITS.parse({})).toMatchObject({ maxItems: 1, maxWritesPerDay: 0, maxValueCentsEur: 0, maxDailyAdSpendCentsEur: 0, allowEngineOwned: false })
    expect(TUNE_LIMITS.parse({})).toEqual({ maxRaisePct: 0 })
    const up = { limits: TURN_UP_LIMITS }
    const wide = { maxLevel: 'AUTO', automations: ['A1', 'A9'], maxRuleWritesPerDay: 50, maxRuleValueCentsEur: 1000 }
    expect(limitsTighten(up, wide, { ...wide, maxLevel: 'PROPOSE' })).toBe(true)
    expect(limitsTighten(up, wide, { ...wide, automations: ['A1'] })).toBe(true)
    expect(limitsTighten(up, { ...wide, automations: ['A1'] }, wide)).toBe(false)
    expect(limitsTighten(up, { ...wide, maxLevel: 'PROPOSE' }, wide)).toBe(false)
    expect(limitsTighten({ limits: TUNE_LIMITS }, { maxRaisePct: 10 }, { maxRaisePct: 5 })).toBe(true)
    expect(limitsTighten({ limits: TUNE_LIMITS }, { maxRaisePct: 5 }, { maxRaisePct: 10 })).toBe(false)
  })
})
