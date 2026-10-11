import { describe, expect, it } from 'vitest'
import {
  AUTO_HELD_AT_CREATE, AUTO_HELD_PAUSING, BID_ACTION_ORDER, BID_ACTION_WORDS, BID_STARTS, EVERY_TICK, MAX_BID_FALLBACK_CENTS, NEW_BID_MODE,
  bidModeHeld, bidPreviewBlockers, bidPreviewBody, centsToInput, countWords, defaultMaxBidCents, isTimedFrequency, lookbackNote,
  nameOrSentence, readBidPreview, scheduleAsRun,
} from './bidRuleBuilder'
import { LEVEL_OF_MODE, bidModeOf, beltForMode, modeRefusedNotice, modeSavePlan } from './ruleBuilderSave'
import { readRuleNumbers } from './ruleBuilderValues'

const ACTIONS = [{ type: 'bid', control: 'manual', campaigns: [], bidFloor: 0.05, bidCeiling: 0.9, windowDays: 14 }]
const CONDITIONS = [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'gt', value: '35' }], action: { op: 'decPct', value: '15' } }]

describe('the preview body', () => {
  it('sends the unsaved rule as Save would, all markets as null', () => {
    expect(bidPreviewBody({ ruleId: null, locked: false, actions: ACTIONS, conditions: CONDITIONS, scopeMarket: 'all' })).toEqual({
      actions: ACTIONS, conditions: CONDITIONS, scopeMarketplace: null, limit: 8,
    })
    expect(bidPreviewBody({ ruleId: null, locked: false, actions: ACTIONS, conditions: CONDITIONS, scopeMarket: 'IT', limit: 5 }).scopeMarketplace).toBe('IT')
  })
  it('an edit sends its id with the unsaved body, so the server keeps the rule’s own scope', () => {
    const body = bidPreviewBody({ ruleId: 'r1', locked: false, actions: ACTIONS, conditions: CONDITIONS, scopeMarket: 'DE' })
    expect(body).toMatchObject({ ruleId: 'r1', actions: ACTIONS, conditions: CONDITIONS, scopeMarketplace: 'DE' })
  })
  it('a rule the builder cannot fully draw previews as saved (the server refuses its unsaved edits)', () => {
    expect(bidPreviewBody({ ruleId: 'r2', locked: true, actions: ACTIONS, conditions: CONDITIONS, scopeMarket: 'IT' })).toEqual({ ruleId: 'r2', limit: 8 })
  })
  it('says what keeps it from running, one chip each', () => {
    const ok = { conditionsFilled: true, thenFilled: true, numbersValid: true, campaigns: 0, scopeMarket: 'IT', locked: false }
    expect(bidPreviewBlockers(ok)).toEqual([])
    expect(bidPreviewBlockers({ ...ok, scopeMarket: 'all' })).toEqual(['Pick a market or campaigns'])
    expect(bidPreviewBlockers({ ...ok, scopeMarket: 'all', campaigns: 2 })).toEqual([])
    expect(bidPreviewBlockers({ ...ok, conditionsFilled: false, thenFilled: false, numbersValid: false })).toEqual(['Fill every condition', 'Fill the action', 'Fix the numbers'])
    expect(bidPreviewBlockers({ ...ok, conditionsFilled: false, scopeMarket: 'all', locked: true })).toEqual([])
  })
})

describe('the preview answer', () => {
  it('reads the sentence, the count, the holds and the rows', () => {
    const p = readBidPreview({
      sentence: 'If ACoS > 35 % over 14 d → bid −15 %', wouldChange: 2, unsampled: 1, note: null, windowDays: 14,
      holds: [{ kind: 'brain', label: 'Brain decides', reason: 'The brain sets the bids there.', held: 'brain', count: 1, campaigns: [] }, { label: 'Locked', held: 'locked', count: 0 }],
      sample: [
        { target: { id: 't1', name: 'winter gloves' }, adGroup: { id: 'g1', name: 'G' }, campaign: { id: 'c1', name: 'Gloves | IT', href: '/marketing/ads/campaigns/c1' }, field: 'bid', fromCents: 40, toCents: 34, held: null, heldBy: null },
        { target: { id: 't2', name: 'racing jacket' }, adGroup: null, campaign: null, field: 'bid', fromCents: 60, toCents: 51, held: 'brain', heldBy: { kind: 'brain', label: 'Brain decides', reason: 'Goes to the brain.' } },
      ],
    })
    expect(p).not.toBeNull()
    expect(p!.sentence).toBe('If ACoS > 35 % over 14 d → bid −15 %')
    expect(p!.wouldChange).toBe(2)
    expect(p!.holds).toEqual([{ held: 'brain', label: 'Brain decides', reason: 'The brain sets the bids there.', count: 1 }])
    expect(p!.rows.map((r) => [r.keyword, r.fromCents, r.toCents, r.hold?.label ?? null])).toEqual([['winter gloves', 40, 34, null], ['racing jacket', 60, 51, 'Brain decides']])
    expect(p!.rows[0].campaign).toEqual({ id: 'c1', name: 'Gloves | IT', href: '/marketing/ads/campaigns/c1' })
    expect(p!.noun).toBe('bid')
  })
  it('an older answer without sentence, heldBy or holds still reads, in the page’s words', () => {
    const p = readBidPreview({ wouldChange: 0, brainInputs: 2, locked: 1, sample: [{ target: { id: 't', name: 'k' }, field: 'bid', fromCents: 10, toCents: 20, held: 'market' }] })
    expect(p!.sentence).toBeNull()
    expect(p!.holds.map((h) => [h.label, h.count])).toEqual([['Brain decides', 2], ['Locked', 1]])
    expect(p!.rows[0].hold?.label).toBe('Market not set up')
  })
  it('hidden money stays hidden (undefined), a missing one is null', () => {
    const p = readBidPreview({ wouldChange: 1, sample: [{ target: { id: 't', name: 'k' }, field: 'bid', toCents: null }] })
    expect(p!.rows[0].fromCents).toBeUndefined()
    expect(p!.rows[0].toCents).toBeNull()
  })
  it('pauses count keywords; nonsense reads as no answer', () => {
    expect(readBidPreview({ wouldChange: 1, sample: [{ target: { id: 't', name: 'k' }, field: 'state', from: 'ENABLED', to: 'PAUSED' }] })!.noun).toBe('keyword')
    expect(readBidPreview(null)).toBeNull()
    expect(readBidPreview({ error: 'x' })).toBeNull()
    expect(countWords(1, 'bid')).toBe('1 bid')
    expect(countWords(3, 'bid')).toBe('3 bids')
  })
  it('a rule with no typed name saves with its sentence', () => {
    expect(nameOrSentence('  Mine ', 'If x → y')).toBe('Mine')
    expect(nameOrSentence('', 'If x → y')).toBe('If x → y')
    expect(nameOrSentence('', null)).toBe('')
    expect(nameOrSentence('', 'a'.repeat(200))).toHaveLength(120)
  })
})

describe('the default highest bid', () => {
  it('is 1.5 × the highest bid today, rounded up to 10 cents', () => {
    expect(defaultMaxBidCents([40, 60, 25])).toBe(90)
    expect(defaultMaxBidCents([61])).toBe(100)
    expect(centsToInput(defaultMaxBidCents([40, 60]))).toBe('0.9')
  })
  it('is never under a bid of today, so the ceiling never lowers a keyword', () => {
    for (const top of [3, 17, 99, 250, 1234]) expect(defaultMaxBidCents([top])).toBeGreaterThan(top)
  })
  it('never below twice the lowest bid; €2.00 when no bid can be read', () => {
    expect(defaultMaxBidCents([2], 5)).toBe(10)
    expect(defaultMaxBidCents([])).toBe(MAX_BID_FALLBACK_CENTS)
    expect(defaultMaxBidCents([Number.NaN, -3, 0])).toBe(MAX_BID_FALLBACK_CENTS)
    expect(centsToInput(MAX_BID_FALLBACK_CENTS)).toBe('2')
  })
})

describe('the mode', () => {
  it('a new rule starts on Ask me and can never be picked Auto', () => {
    expect(NEW_BID_MODE).toBe('ASK')
    const create = { isEdit: false, initial: null, ops: ['decPct'], autoLocked: null }
    expect(bidModeHeld('AUTO', create)).toBe(AUTO_HELD_AT_CREATE)
    expect(AUTO_HELD_AT_CREATE).toContain('14 days')
    for (const step of ['OFF', 'WATCH', 'ASK']) expect(bidModeHeld(step, create)).toBeNull()
  })
  it('an edit: Auto is held for pausing rules and for what the server says; a rule on Auto keeps it', () => {
    const edit = { isEdit: true, initial: 'ASK' as const, ops: ['decPct'], autoLocked: null }
    expect(bidModeHeld('AUTO', edit)).toBeNull()
    expect(bidModeHeld('AUTO', { ...edit, ops: ['pauseTarget'] })).toBe(AUTO_HELD_PAUSING)
    expect(bidModeHeld('AUTO', { ...edit, autoLocked: { label: 'Auto from 24 Oct', reason: 'Needs 10 runs first.' } })).toBe('Needs 10 runs first.')
    expect(bidModeHeld('AUTO', { ...edit, autoLocked: { label: 'Auto from 24 Oct' } })).toBe('Auto from 24 Oct')
    expect(bidModeHeld('AUTO', { ...edit, initial: 'AUTO', ops: ['pauseTarget'] })).toBeNull()
  })
  it('reads a stored rule as set and as it acts (Auto with the Manual belt asks)', () => {
    expect(bidModeOf({ enabled: false, autonomyLevel: 'AUTO' })).toEqual({ set: 'OFF', acts: 'OFF' })
    expect(bidModeOf({ enabled: true, autonomyLevel: 'OBSERVE' })).toEqual({ set: 'WATCH', acts: 'WATCH' })
    expect(bidModeOf({ enabled: true, autonomyLevel: 'AUTO', actions: [{ control: 'manual' }] })).toEqual({ set: 'AUTO', acts: 'ASK' })
    expect(bidModeOf({ enabled: true, autonomyLevel: 'AUTO', actions: [{ control: 'automate' }] })).toEqual({ set: 'AUTO', acts: 'AUTO' })
  })
  it('the belt: Ask me asks, Watch and Auto do not, Off keeps what is stored', () => {
    expect(beltForMode('ASK', 'automate')).toBe('manual')
    expect(beltForMode('WATCH', 'manual')).toBe('automate')
    expect(beltForMode('AUTO', null)).toBe('automate')
    expect(beltForMode('OFF', 'automate')).toBe('automate')
    expect(beltForMode('OFF', null)).toBe('manual')
  })
  it('create: Ask me and Watch get their level after the rule exists; Off none; never Auto', () => {
    expect(modeSavePlan({ isEdit: false, initial: null, chosen: 'ASK', stored: null })).toEqual({ level: 'PROPOSE', belt: 'manual', levelFirst: false })
    expect(modeSavePlan({ isEdit: false, initial: null, chosen: 'WATCH', stored: null })).toEqual({ level: 'OBSERVE', belt: 'automate', levelFirst: false })
    expect(modeSavePlan({ isEdit: false, initial: null, chosen: 'OFF', stored: null }).level).toBeNull()
    expect(modeSavePlan({ isEdit: false, initial: null, chosen: 'AUTO', stored: null })).toEqual({ level: 'PROPOSE', belt: 'manual', levelFirst: false })
  })
  it('edit: an unchanged step sets nothing and keeps the belt; down sets the level first; up after', () => {
    expect(modeSavePlan({ isEdit: true, initial: 'AUTO', chosen: 'AUTO', stored: 'manual' })).toEqual({ level: null, belt: 'manual', levelFirst: false })
    // Auto that asks → Watch: the belt loosens to Automate, so OBSERVE lands before the rule saves.
    expect(modeSavePlan({ isEdit: true, initial: 'AUTO', chosen: 'WATCH', stored: 'manual' })).toEqual({ level: 'OBSERVE', belt: 'automate', levelFirst: true })
    expect(modeSavePlan({ isEdit: true, initial: 'ASK', chosen: 'AUTO', stored: 'manual' })).toEqual({ level: 'AUTO', belt: 'automate', levelFirst: false })
    expect(modeSavePlan({ isEdit: true, initial: 'WATCH', chosen: 'OFF', stored: 'automate' })).toEqual({ level: 'OFF', belt: 'automate', levelFirst: true })
    expect(LEVEL_OF_MODE.WATCH).toBe('OBSERVE')
  })
  it('a refused step says which step stays', () => {
    const n = modeRefusedNotice({ isEdit: true, stays: 'ASK', status: 409, body: { message: 'The rule has not passed the gate yet.' } })
    expect(n.title).toBe('Saved, but the mode is still Ask me')
    expect(n.sentence).toBe('The rule has not passed the gate yet.')
  })
})

describe('the schedule the evaluator runs', () => {
  it('no or an unknown frequency runs every 15 minutes; an unknown zone runs on Rome', () => {
    expect(scheduleAsRun(null)).toEqual({ frequency: EVERY_TICK, timezone: 'cet' })
    expect(scheduleAsRun({})).toEqual({ frequency: EVERY_TICK, timezone: 'cet' })
    expect(scheduleAsRun({ frequency: 'Fortnightly', timezone: 'gmt' })).toEqual({ frequency: EVERY_TICK, timezone: 'cet' })
    expect(scheduleAsRun({ frequency: 'Weekly', timezone: 'utc' })).toEqual({ frequency: 'Weekly', timezone: 'utc' })
    expect(scheduleAsRun({ frequency: EVERY_TICK })).toEqual({ frequency: EVERY_TICK, timezone: 'cet' })
  })
  it('only the timed frequencies read a time and a zone', () => {
    expect(['Daily', 'Weekly', 'Monthly', 'Custom'].every(isTimedFrequency)).toBe(true)
    expect(isTimedFrequency('Hourly')).toBe(false)
    expect(isTimedFrequency(EVERY_TICK)).toBe(false)
  })
})

describe('words', () => {
  it('every bid action has plain words, the common ones first', () => {
    expect(BID_ACTION_ORDER.every((op) => BID_ACTION_WORDS[op])).toBe(true)
    expect(BID_ACTION_ORDER[0]).toBe('targetAcos')
    expect(Object.values(BID_ACTION_WORDS).some((w) => /\(|€\)|Target ACoS \//.test(w))).toBe(false)
  })
  it('the starts are complete rules', () => {
    for (const st of BID_STARTS) {
      expect(st.conditions.length).toBeGreaterThan(0)
      expect(st.conditions.every((c) => c.value !== '')).toBe(true)
      expect(st.line.startsWith('If ')).toBe(true)
    }
  })
  it('the lookback note says the newest days are left out', () => {
    const n = lookbackNote(Date.parse('2026-10-11T10:00:00Z'))
    expect(n.tag).toMatch(/^Data to \d{1,2} (Sept?|Oct)$/)
    expect(n.tip).toContain('late sales')
  })
  it('the bid surface names its fields in the Bid page’s words and reads "Most per run"', () => {
    const inputs = { budgetFloor: '1', budgetCeiling: '', placeFloor: '0', placeCeiling: '900', bidFloor: '0.05', bidCeiling: '0,02', maxAdSpend: '100', maxWrites: '', maxExecs: '10', protectDays: '30', everyN: '', harvestBid: '', maxValue: '2,5' }
    const shape = { locked: false, budget: false, placement: false, bidLike: true, negative: false, harvest: false, harvestBidMode: 'cpc', customFrequency: false, bidWords: true }
    const r = readRuleNumbers(inputs, shape)
    expect(r.errors.bidCeiling).toContain('Highest bid')
    expect(r.errors.bidCeiling).toContain('lowest bid')
    expect(r.caps.maxValueCentsEur).toBe(250)
    expect(readRuleNumbers({ ...inputs, maxValue: '' }, shape).clearsMaxValue).toBe(true)
    // Other rule types: unchanged words, no value cap sent.
    const shared = readRuleNumbers(inputs, { ...shape, bidWords: false })
    expect(shared.errors.bidCeiling).toContain('Max bid')
    expect(shared.caps.maxValueCentsEur).toBeUndefined()
    expect(shared.clearsMaxValue).toBe(false)
  })
})
