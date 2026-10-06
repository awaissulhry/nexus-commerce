/**
 * ADS PLAYBOOK PB-9 — a phase switch judged by its effect, and the phase check, pure (phase.ts, phase-check.ts; rank.ts
 * classifyRankOff). Values are made up (public repo).
 *
 *   strategy   the new phase's recipe is set; what the last phase set and this one does not name is cleared only where
 *              the row still holds the last phase's value (a person's own number stays); a group the recipe cannot set
 *              whole is left, said; Claude's levels the same way
 *   slots      floor: a lowering, to the stop bid, remembered; active again: a give-back (a raise) only of a floor the last
 *              phase set, once the playbook runs, and only a floor a person's request set — never an engine's
 *   rank       switched on: a raise; switched off: a raise when it gives back the floors it set, else a lowering; light ↔
 *              full by direction while it runs, nothing before START
 *   check      the hold (hysteresis): no proposal until the phase's least days have passed (the design's 14 for a phase
 *              that names none), a question to the Owner never held, an unknown start held; every condition with its
 *              number, an unmeasurable one never met
 *   judge      a playbook edit of the phase table or a product's recipes is judged by what a switch would then write
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

const { claudeValues, isPersonFloor, rankSteps, recipeValues, slotSteps } = await import('./phase.js')
const { evaluatePhaseCheck, measureCondition, windowsOf } = await import('./phase-check.js')
const { classifyRankOff } = await import('./rank.js')
const { judgePhases, judgeRecipe, judgeRecipes } = await import('./judge.js')
const { templateDoc } = await import('../../../test-support/ads-playbook-fixtures.js')
type Facts = import('./phase-check.js').PhaseFacts
type Entry = NonNullable<import('./doc.js').TemplateDoc['phases']['GROW']>

const DAY = 86_400_000
const NOW = new Date('2026-10-06T12:00:00Z')
const doc = templateDoc()

describe('the strategy part: each field by its own rule, the last phase taken back only where it still holds', () => {
  it('sets the new recipe; clears what the last phase set that this one does not name; keeps a person\'s own number', () => {
    const to = { targetAcosPct: 22, harvestMinOrders: 3, harvestMinClicks: 4, harvestWindowDays: 60 as const, negateMinClicks: 18, negateMinSpendCents: 77, negateMaxOrders: 0, negateWindowDays: 30 as const }
    const from = { targetAcosPct: 41, minBidCents: 9, maxBidCents: 88, maxChangePct: 33 }
    // A person moved the highest bid since; the lowest bid and the largest change still hold the last phase's numbers.
    const own = { targetKind: 'ACOS', targetPct: 41, minBidCents: 9, maxBidCents: 70, maxChangePct: 33 }
    const { values, notes } = recipeValues(to, from, own)
    expect(values).toEqual({
      target: { kind: 'ACOS', pct: 22 },
      minBidCents: null,
      maxChangePct: null,
      harvest: { minOrders: 3, minClicks: 4, maxAcosPct: null, windowDays: 60 },
      negate: { minClicks: 18, minSpendCents: 77, maxOrders: 0, windowDays: 30 },
    })
    expect(values).not.toHaveProperty('maxBidCents')
    expect(notes).toEqual([])
  })

  it('a target the last phase set but a person changed stays; a group the recipe cannot set whole is left, said', () => {
    const { values, notes } = recipeValues({ negateMinClicks: 18, negateMaxOrders: 0, negateWindowDays: 30 }, { targetAcosPct: 41 }, { targetKind: 'ACOS', targetPct: 39 })
    expect(values).toEqual({})
    expect(notes).toEqual([expect.stringMatching(/no spend threshold \(the product had no base bid at enrollment\), so the negate group is left as it is/)])
    // The last phase's whole groups come off where the row still holds them.
    const last = { harvestMinOrders: 1, harvestMinClicks: 0, harvestWindowDays: 30 as const, negateMinClicks: 25, negateMinSpendCents: 50, negateMaxOrders: 0, negateWindowDays: 30 as const }
    const row = { harvestMinOrders: 1, harvestMinClicks: 0, harvestMaxAcosPct: null, harvestWindowDays: 30, negateMinClicks: 25, negateMinSpendCents: 50, negateMaxOrders: 0, negateWindowDays: 30 }
    expect(recipeValues({}, last, row).values).toEqual({ harvest: null, negate: null })
    expect(recipeValues({}, last, { ...row, negateMinClicks: 40 }).values).toEqual({ harvest: null })
  })

  it("Claude's levels: the new phase's set, the last phase's taken off where the row still holds them", () => {
    expect(claudeValues({ harvest: 'ask' }, { budget: 'ask' }, { budget: 'ask', bid: 'confirm' })).toEqual({ bid: 'confirm', harvest: 'ask' })
    // A person set the budget level since: it stays.
    expect(claudeValues({}, { budget: 'ask' }, { budget: 'off' })).toBeUndefined()
    expect(claudeValues({}, { budget: 'ask' }, { budget: 'ask' })).toBeNull()
    expect(claudeValues({ budget: 'ask' }, undefined, { budget: 'ask' })).toBeUndefined()
  })
})

describe('the slots', () => {
  const links = new Map([['auto', 'c-auto'], ['broad-category', 'c-broad'], ['exact-category', 'c-exact']])
  const campaign = (id: string, extra: Partial<{ floored: boolean; floorBy: string | null; status: string; phaseFloorBy: string | null }> = {}) => ({
    campaignId: id, name: `Test ${id}`, status: 'ENABLED', marketplace: 'IT', floored: false, floorBy: null, dailyBudgetCents: 500, ...extra,
  })
  const DEFEND = doc.phases.DEFEND!
  const GROW = doc.phases.GROW!

  it('a phase that floors a slot lowers it to the stop bid; one at a floor already stays; a slot with no campaign is said', () => {
    const steps = slotSteps({
      doc, from: GROW, to: DEFEND, running: true,
      links: new Map([['auto', 'c-auto'], ['broad-category', 'c-broad']]),
      campaigns: new Map([['c-auto', campaign('c-auto')], ['c-broad', campaign('c-broad', { floored: true, floorBy: 'automation:budget-engine' })]]),
      stopBids: new Map([['c-auto', 4]]),
    })
    expect(steps.map((s) => [s.slot, s.does, s.direction, s.floorCents ?? null])).toEqual([['auto', 'floor', 'lower', 4], ['broad-category', 'keep', 'same', null]])
    expect(steps[0].summary).toMatch(/never paused/)
  })

  it('leaving a floor the last phase set: a give-back (a raise) only once it runs, and only the phase\'s own floor', () => {
    const run = (running: boolean, floorBy: string, phaseFloorBy: string | null = floorBy) => slotSteps({
      doc, from: DEFEND, to: GROW, running, links,
      campaigns: new Map([['c-auto', campaign('c-auto', { floored: true, floorBy, phaseFloorBy })], ['c-broad', campaign('c-broad')], ['c-exact', campaign('c-exact', { floored: true, floorBy: 'user:u-someone' })]]),
      stopBids: new Map(),
    })
    // c-exact's floor was not the last phase's (DEFEND leaves exact active): it stays.
    expect(run(true, 'user:u-approver').map((s) => [s.slot, s.does, s.direction])).toEqual([['auto', 'restore', 'raise'], ['exact-category', 'keep', 'same']])
    expect(run(false, 'user:u-approver').map((s) => [s.slot, s.does])).toEqual([['auto', 'keep'], ['exact-category', 'keep']])
    expect(run(false, 'user:u-approver')[0].summary).toMatch(/until START/)
    expect(run(true, 'automation:retail-guard').map((s) => [s.slot, s.does, s.direction])).toEqual([['auto', 'report', 'same'], ['exact-category', 'keep', 'same']])
    // A floor a person set by hand (no phase link), or one another person holds now: never the phase's to lift.
    expect(run(true, 'user:u-owner', null)[0]).toMatchObject({ slot: 'auto', does: 'keep', summary: expect.stringMatching(/not the phase's own: it stays/) })
    expect(run(true, 'user:u-owner', 'user:u-approver')[0]).toMatchObject({ does: 'keep' })
    expect(isPersonFloor('user:u-1')).toBe(true)
    expect(isPersonFloor('automation:rank-defend-x')).toBe(false)
    expect(isPersonFloor(null)).toBe(false)
  })
})

describe('the hourly plans, by effect', () => {
  const facts = (floorBy: string | null) => ({
    campaigns: new Map([['c-exact', { id: 'c-exact', name: 'Test exact', status: 'ENABLED' }]]),
    bids: new Map([['c-exact', { floorBy, floored: !!floorBy, flooredBids: 3, deltaUp: 0, deltaDown: 0, topPct: 0 }]]),
  })
  const line = (does: 'enable' | 'disable' | 'update' | 'keep', role = 'performance') => ({ kind: 'rankGroup' as const, key: `rank:${role}`, does, summary: 'x' })

  it('a phase that turns rank off is a RAISE when the floors it set come back, a lowering when they are kept', () => {
    const giveBack = classifyRankOff(facts('automation:rank-defend-g1'), ['c-exact'], 'giveBack')
    const keep = classifyRankOff(facts('automation:rank-defend-g1'), ['c-exact'], 'keep')
    expect(giveBack.direction).toBe('raise')
    expect(keep.direction).toBe('same')
    expect(rankSteps([line('disable')], { performance: 'on' }, { performance: 'off' }, true, new Map([['performance', giveBack]]))[0].direction).toBe('raise')
    expect(rankSteps([line('disable')], { performance: 'on' }, { performance: 'off' }, true, new Map([['performance', keep]]))[0].direction).toBe('lower')
    // A floor another engine set holds the campaign: switching rank off gives nothing back.
    expect(classifyRankOff(facts('automation:budget-engine'), ['c-exact'], 'giveBack').direction).toBe('same')
  })

  it('switched on: a raise; light → full a raise and full → light a lowering while it runs; before START nothing moves', () => {
    const none = new Map()
    expect(rankSteps([line('enable')], {}, { performance: 'on' }, true, none)[0].direction).toBe('raise')
    expect(rankSteps([line('update')], { performance: 'light' }, { performance: 'on' }, true, none)[0].direction).toBe('raise')
    expect(rankSteps([line('update')], { performance: 'on' }, { performance: 'light' }, true, none)[0].direction).toBe('lower')
    expect(rankSteps([line('update')], { performance: 'light' }, { performance: 'on' }, false, none)[0].direction).toBe('same')
    expect(rankSteps([line('keep', 'research')], {}, { research: 'on' }, true, none)[0]).toMatchObject({ role: 'research', direction: 'same' })
  })
})

describe('the phase check', () => {
  const windows = new Map([[14, { days: 14, from: '2026-09-22', to: '2026-10-05', adOrders: 12, spendCents: 3000, salesCents: 10_000, previousAdOrders: 15 }]])
  const facts = (sinceDays: number | null, extra: Partial<Facts> = {}): Facts => ({
    phase: 'GROW', since: sinceDays == null ? null : new Date(NOW.getTime() - sinceDays * DAY), now: NOW, windows, targetAcosPct: 40, sellableUnits: 30, ...extra,
  })

  it('every condition with its number; ACoS against the target and the change in orders measured over the window', () => {
    const GROW = doc.phases.GROW!
    expect(windowsOf(GROW)).toEqual([14])
    const r = evaluatePhaseCheck(GROW, facts(20))
    expect(r.daysInPhase).toBe(20)
    expect(r.exits).toEqual([{
      to: 'PROFIT', met: false,
      conditions: [
        { metric: 'daysInPhase', op: 'gte', value: 14, daysInPhase: 20, met: true },
        // 30 % ACoS against a 40 % target.
        { metric: 'acosToTargetPct', op: 'lte', value: 100, windowDays: 14, acosToTargetPct: 75, met: true },
        // 12 orders against 15 in the 14 days before: −20 %, below the −10 % the rule allows.
        { metric: 'ordersChangePct', op: 'gte', value: -10, windowDays: 14, ordersChangePct: -20, met: false },
      ],
    }])
    expect(r.proposal).toBeNull()
    const steady = evaluatePhaseCheck(GROW, facts(20, { windows: new Map([[14, { ...windows.get(14)!, previousAdOrders: 12 }]]) }))
    expect(steady.proposal).toMatchObject({ to: 'PROFIT', rule: 0 })
  })

  it('the hold (hysteresis): no move is proposed until the least days have passed — the rule met waits, named', () => {
    const entry: Entry = { ...doc.phases.GROW!, minDays: 14, exit: [{ to: 'PROFIT', when: [{ metric: 'adOrders', op: 'gte', value: 10, windowDays: 14 }] }] }
    const held = evaluatePhaseCheck(entry, facts(3))
    expect(held.hold).toMatchObject({ minDays: 14, held: true, daysLeft: 11 })
    expect(held.proposal).toBeNull()
    expect(held.heldProposal).toEqual({ to: 'PROFIT', rule: 0, daysLeft: 11 })
    const passed = evaluatePhaseCheck(entry, facts(14))
    expect(passed.hold).toMatchObject({ held: false, daysLeft: 0 })
    expect(passed.proposal).toMatchObject({ to: 'PROFIT' })
    // A start Nexus cannot read holds (fail closed); a phase of an older template names no hold: the design's 14 days.
    expect(evaluatePhaseCheck(entry, facts(null)).hold).toMatchObject({ held: true, daysLeft: 14 })
    expect(evaluatePhaseCheck({ ...entry, minDays: undefined }, facts(1))).toMatchObject({ hold: { minDays: 14, held: true, daysLeft: 13 }, proposal: null })
    expect(evaluatePhaseCheck({ ...entry, minDays: 0 }, facts(1)).proposal).toMatchObject({ to: 'PROFIT' })
  })

  it('a question to the Owner is never held; it is proposed as soon as its condition holds', () => {
    const CLEAR = doc.phases.CLEAR_STOCK!
    const r = evaluatePhaseCheck(CLEAR, facts(1, { phase: 'CLEAR_STOCK', sellableUnits: 4 }))
    expect(r.hold.held).toBe(true)
    expect(r.proposal).toMatchObject({ to: 'ASK_OWNER', note: expect.stringMatching(/a person decides/) })
    expect(evaluatePhaseCheck(CLEAR, facts(1, { phase: 'CLEAR_STOCK', sellableUnits: 6 })).proposal).toBeNull()
  })

  it('a number Nexus cannot measure is null and never met: no sales, no orders before, no target, no window, no start', () => {
    const c = (metric: 'acosToTargetPct' | 'ordersChangePct' | 'adOrders' | 'daysInPhase', windowDays?: number) => ({ metric, op: 'lte' as const, value: 100, ...(windowDays ? { windowDays } : {}) })
    const noSales = facts(20, { windows: new Map([[14, { ...windows.get(14)!, salesCents: 0 }]]) })
    expect(measureCondition(c('acosToTargetPct', 14), noSales, 20)).toMatchObject({ acosToTargetPct: null, met: null, note: expect.stringMatching(/no ad sales/) })
    expect(measureCondition(c('acosToTargetPct', 14), facts(20, { targetAcosPct: null }), 20)).toMatchObject({ met: null, note: expect.stringMatching(/no target ACoS/) })
    expect(measureCondition(c('ordersChangePct', 14), facts(20, { windows: new Map([[14, { ...windows.get(14)!, previousAdOrders: 0 }]]) }), 20)).toMatchObject({ ordersChangePct: null, met: null })
    expect(measureCondition(c('adOrders'), facts(20), 20)).toMatchObject({ met: null, note: expect.stringMatching(/names no window/) })
    expect(measureCondition(c('daysInPhase'), facts(null), null)).toMatchObject({ daysInPhase: null, met: null })
  })
})

describe('a playbook edit of the phases, judged by what a switch would then write', () => {
  const recipe = { targetAcosPct: 30, minBidCents: 5, maxBidCents: 80, maxChangePct: 20, harvestMinOrders: 2, harvestMinClicks: 5, harvestWindowDays: 30 as const, negateMinClicks: 20, negateMinSpendCents: 100, negateMaxOrders: 0, negateWindowDays: 30 as const }
  it("a product's recipe: a higher target, highest bid or floor, a looser group raise; stricter lowers; a number appearing with nothing to judge by raises", () => {
    expect(judgeRecipe(recipe, { ...recipe })).toBe('same')
    expect(judgeRecipe(recipe, { ...recipe, targetAcosPct: 35 })).toBe('raise')
    expect(judgeRecipe(recipe, { ...recipe, maxBidCents: 90 })).toBe('raise')
    expect(judgeRecipe(recipe, { ...recipe, minBidCents: 8 })).toBe('raise')
    expect(judgeRecipe(recipe, { ...recipe, harvestMinOrders: 1 })).toBe('raise')
    expect(judgeRecipe(recipe, { ...recipe, negateMinClicks: 10 })).toBe('raise')
    expect(judgeRecipe(recipe, { ...recipe, targetAcosPct: 25, harvestMinOrders: 3 })).toBe('lower')
    expect(judgeRecipe({ ...recipe, targetAcosPct: undefined }, recipe)).toBe('raise')
    expect(judgeRecipes({ GROW: recipe }, { GROW: recipe, PROFIT: recipe })).toBe('raise')
    expect(judgeRecipes({ GROW: recipe, PROFIT: recipe }, { GROW: recipe })).toBe('lower')
  })

  it('the phase table: Claude allowed more alone, a slot back from the floor, a plan on, a cadence more often, a shorter hold, an exit rule changed — each a raise', () => {
    const phases = doc.phases
    const edit = (phase: 'LAUNCH' | 'DEFEND' | 'PROFIT', change: Record<string, unknown>) => ({ ...phases, [phase]: { ...phases[phase]!, ...change } })
    expect(judgePhases(phases, phases)).toBe('same')
    expect(judgePhases(phases, edit('LAUNCH', { claude: {} }))).toBe('raise')
    expect(judgePhases(phases, edit('LAUNCH', { claude: { budget: 'off' } }))).toBe('lower')
    expect(judgePhases(phases, edit('DEFEND', { slots: {} }))).toBe('raise')
    expect(judgePhases(phases, edit('PROFIT', { rank: { performance: 'on', research: 'on' } }))).toBe('raise')
    expect(judgePhases(phases, edit('PROFIT', { harvestCadence: 'daily' }))).toBe('raise')
    expect(judgePhases(phases, edit('PROFIT', { harvestCadence: 'off' }))).toBe('lower')
    expect(judgePhases(phases, edit('PROFIT', { minDays: 7 }))).toBe('raise')
    expect(judgePhases(phases, edit('PROFIT', { minDays: 21 }))).toBe('lower')
    expect(judgePhases(phases, edit('PROFIT', { exit: [] }))).toBe('raise')
    expect(judgePhases(phases, edit('PROFIT', { recipe: { ...phases.PROFIT!.recipe, targetAcos: { from: 'breakEven', factor: 0.9, fallbackFactor: 1 } } }))).toBe('raise')
    const { DEFEND: _gone, ...fewer } = phases
    expect(judgePhases(phases, fewer)).toBe('lower')
    expect(judgePhases(fewer, phases)).toBe('raise')
  })
})
