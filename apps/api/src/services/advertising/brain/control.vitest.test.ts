/**
 * ONE BRAIN — the Owner's control of a product's brain (brain/control.ts, the pure part; the database part and the
 * approval path run in control-postgres.vitest.test.ts).
 *
 *   shape     each op names what it needs and nothing it cannot take (a level or reset, never both; no campaign for enroll
 *             or leave; no lever for an exclusion; no value for an unlock)
 *   spend     every setting is rated for spend; a change is a raise only in its direction (up, down, true → false, a mode,
 *             a long stop ended sooner); a setting nobody rated is said as not rated, never as safe
 *   after     the open overrides after a plan: the one it ends gone, the one it stores added (the newest wins)
 *   moves     a campaign's lever moves grouped by from → to; nothing listed when nothing moves
 *   AUTO      where a lever goes to AUTO — the product, an own campaign; a shared campaign never counts (D2); an unlock or an
 *             include that lets a level apply counts too
 *   words     what the brain does at each level, the server switch said when it is not live; a lock on a gate lever vs bids;
 *             one line per move (the same move to shadow, an exclusion or OFF shared, each AUTO its own)
 *   released  a lever the brain leaves is said as open to today's engines — not one the Owner locks where the gate holds it
 *   undo      each choice put back by the op that restores it, parsing as the tool's own arguments
 *
 * Values are made up (public repo).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

const {
  controlUndoRequest, effectiveWord, leverDoes, leverMoves, overridesAfter, releasedLevers, settingRaise, shapeRefusal, SPEND_RATINGS, startLines, turnsAutoOf,
} = await import('./control.js')
const { resolveBrainSettings } = await import('./settings.js')
const { BRAIN_LEVERS, BRAIN_SETTING_KEYS } = await import('./levers.js')
const { ADS_BRAIN_CONTROL_TOOLS } = await import('../../agents/tools/ads-brain-control.tools.js')

type Row = Parameters<typeof resolveBrainSettings>[0]['overrides'][number]
const P = 'p-jacket'
let n = 0
const row = (o: Partial<Row> & Pick<Row, 'kind' | 'key'>): Row => ({
  id: `o${++n}`, productId: P, marketplace: 'IT', scope: o.campaignId ? 'CAMPAIGN' : 'PRODUCT', campaignId: null, ref: '', value: null, by: 'user:owner',
  reason: null, createdAt: new Date(`2026-10-0${Math.min(8, n % 8 + 1)}T08:00:00Z`), endedAt: null, ...o,
})
const resolver = (rows: Row[], enrolled = true) => (campaignId: string | null) => resolveBrainSettings({ productId: P, market: 'IT', campaignId, enrolled, overrides: rows })
const own = [{ campaignId: 'c1', name: 'Jacket exact' }, { campaignId: 'c2', name: 'Jacket broad' }]

describe('shapeRefusal — each op names what it needs', () => {
  const base = { productId: P, market: 'IT' }
  it('passes a well-formed request of every op', () => {
    for (const input of [
      { op: 'enroll', levels: { budgets: 'PROPOSE' } }, { op: 'set-level', lever: 'bids', level: 'AUTO' }, { op: 'set-level', lever: 'bids', reset: true },
      { op: 'lock', lever: 'budgets', value: { dailyBudgetCents: 2000 } }, { op: 'lock', lever: 'hours', ref: 'hourCell:d1h14' }, { op: 'unlock', lever: 'budgets' },
      { op: 'exclude', campaignId: 'c1' }, { op: 'include' }, { op: 'set-value', key: 'paceTargetPct', value: 80 }, { op: 'set-value', key: 'longStopUntil', value: null },
      { op: 'set-value', key: 'paceTargetPct', reset: true }, { op: 'leave', bids: 'shadow' },
    ]) expect(shapeRefusal({ ...base, ...input } as never), JSON.stringify(input)).toBeNull()
  })
  it('refuses what an op cannot take, in words', () => {
    expect(shapeRefusal({ ...base, op: 'enroll', campaignId: 'c1' })).toMatch(/whole product in the market: name no campaignId/)
    expect(shapeRefusal({ ...base, op: 'leave', campaignId: 'c1' })).toMatch(/exclude keeps one campaign out/)
    expect(shapeRefusal({ ...base, op: 'set-level', level: 'AUTO' })).toMatch(/names the lever/)
    expect(shapeRefusal({ ...base, op: 'set-level', lever: 'bids' })).toMatch(/names the level .* or reset: true/)
    expect(shapeRefusal({ ...base, op: 'set-level', lever: 'bids', level: 'AUTO', reset: true })).toMatch(/a level or reset: true .* not both/)
    expect(shapeRefusal({ ...base, op: 'unlock', lever: 'budgets', value: { dailyBudgetCents: 100 } })).toMatch(/unlock takes no value/)
    expect(shapeRefusal({ ...base, op: 'exclude', lever: 'bids' })).toMatch(/no lever \(to hold one lever, lock it\)/)
    expect(shapeRefusal({ ...base, op: 'set-value', key: 'paceTargetPct' })).toMatch(/names the value of paceTargetPct/)
    expect(shapeRefusal({ ...base, op: 'set-value', key: 'paceTargetPct', value: 80, reset: true })).toMatch(/not both/)
    expect(shapeRefusal({ ...base, op: 'set-level', lever: 'bids', level: 'AUTO', levels: { budgets: 'AUTO' } })).toMatch(/starting levels of op enroll/)
    expect(shapeRefusal({ ...base, op: 'lock', lever: 'budgets', reset: true })).toMatch(/unlock ends a lock/)
    expect(shapeRefusal({ ...base, op: 'enroll', bids: 'keep' })).toMatch(/what op leave does/)
    expect(shapeRefusal({ ...base, op: 'set-level', lever: 'state', level: 'OFF', pauses: 'resume' })).toMatch(/pauses says what op leave does with the campaigns the brain's own pause holds/)
    expect(shapeRefusal({ ...base, op: 'leave', pauses: 'keep' })).toBeNull()
  })
})

describe('spend — what a change of a setting can add', () => {
  it('every setting of the brain is rated (a setting added later fails here until it is)', () => {
    expect(BRAIN_SETTING_KEYS.filter((k) => !SPEND_RATINGS[k])).toEqual([])
  })

  it('Owner decision 2A — the portfolio cap limit: a higher value, a value set over the server\'s, or a reset to the server\'s may raise; a lower value does not', () => {
    expect(settingRaise('portfolioCapLimitCents', 200_000, 300_000)).toMatch(/a higher limit for this product's Amazon portfolio caps/)
    expect(settingRaise('portfolioCapLimitCents', null, 300_000)).toMatch(/higher limit/)
    expect(settingRaise('portfolioCapLimitCents', 100_000, null)).toMatch(/empty = the server's limit, which may be higher/)
    expect(settingRaise('portfolioCapLimitCents', 300_000, 200_000)).toBeNull()
    expect(settingRaise('portfolioCapLimitCents', 300_000, 300_000)).toBeNull()
  })
  it('a raise only in its direction', () => {
    expect(settingRaise('paceTargetPct', 90, 95)).toMatch(/^paceTargetPct 90 → 95: the pace aims at more/)
    expect(settingRaise('paceTargetPct', 90, 80)).toBeNull()
    expect(settingRaise('budgetUsePct', 70, 50)).toMatch(/budgets come out larger/)
    expect(settingRaise('budgetUsePct', 70, 90)).toBeNull()
    expect(settingRaise('portfolioCapOn', true, false)).toMatch(/only hard limit/)
    expect(settingRaise('portfolioCapOn', false, true)).toBeNull()
    expect(settingRaise('hourPlanAsLimits', true, false)).toMatch(/above the Owner's own painted plan/)
    expect(settingRaise('strategySwitchMode', 'ALWAYS_PROPOSE', 'PROPOSE_THEN_AUTO')).toMatch(/may run alone after 30 days/)
    expect(settingRaise('strategySwitchMode', 'PROPOSE_THEN_AUTO', 'ALWAYS_PROPOSE')).toBeNull()
    expect(settingRaise('longStopUntil', '2026-11-20', '2026-11-10')).toMatch(/ends sooner/)
    expect(settingRaise('longStopUntil', '2026-11-20', null)).toMatch(/ends sooner/)
    expect(settingRaise('longStopUntil', null, '2026-11-20')).toBeNull()
    expect(settingRaise('portfolioCapCents', null, 50_000)).toMatch(/higher Amazon portfolio cap/)
    expect(settingRaise('portfolioCapCents', 50_000, 40_000)).toBeNull()
    expect(settingRaise('archiveDeadWeeks', 4, 2)).toBeNull()
    expect(settingRaise('negativesPerDay', 20, 10)).toMatch(/wasted clicks/)
  })
})

describe('overridesAfter and leverMoves', () => {
  it('the ended row goes, the stored one comes, and resolves as the newest', () => {
    const level = row({ kind: 'LEVEL', key: 'budgets', value: 'OBSERVE' })
    const lock = row({ kind: 'LOCK', key: 'hours', ref: 'hourCell:d1h14' })
    const after = overridesAfter([level, lock], { ends: level.id, set: { scope: 'PRODUCT', campaignId: null, kind: 'LEVEL', key: 'budgets', ref: '', value: 'AUTO' } }, P, 'IT')
    expect(after.map((o) => o.id)).toEqual([lock.id, 'new'])
    expect(resolver(after)(null).levers.budgets.level.value).toBe('AUTO')
    expect(overridesAfter([level], { ends: level.id, set: null }, P, 'IT')).toEqual([])
  })
  it('groups a campaign\'s moves by from → to, and lists nothing when nothing moves', () => {
    const before = resolver([])('c1')
    const after = resolver([row({ kind: 'EXCLUDE', key: '*', campaignId: 'c1' })])('c1')
    expect(leverMoves([...BRAIN_LEVERS], before, after)).toEqual([{ what: 'every lever', from: 'OBSERVE (shadow)', to: 'EXCLUDED' }])
    const auto = resolver([row({ kind: 'LEVEL', key: 'budgets', value: 'AUTO' }), row({ kind: 'LEVEL', key: 'state', value: 'AUTO' })])('c1')
    expect(leverMoves([...BRAIN_LEVERS], before, auto)).toEqual([{ what: 'state, budgets', from: 'OBSERVE (shadow)', to: 'AUTO' }])
    expect(leverMoves([...BRAIN_LEVERS], before, before)).toEqual([])
  })
})

describe('turnsAutoOf — the big doors of code rule A', () => {
  it('the product and each own campaign where a lever goes to AUTO; a campaign with its own level does not', () => {
    const before = [row({ kind: 'LEVEL', key: 'budgets', value: 'OBSERVE', campaignId: 'c2' })]
    const after = [...before, row({ kind: 'LEVEL', key: 'budgets', value: 'AUTO' })]
    expect(turnsAutoOf(resolver(before), resolver(after), own)).toEqual([
      { where: 'the product', campaignId: null, lever: 'budgets' },
      { where: 'Jacket exact', campaignId: 'c1', lever: 'budgets' },
    ])
  })
  it('an unlock that lets an AUTO level apply again is a big door too; a lock is not', () => {
    const auto = row({ kind: 'LEVEL', key: 'budgets', value: 'AUTO' })
    const lock = row({ kind: 'LOCK', key: 'budgets', campaignId: 'c1' })
    expect(turnsAutoOf(resolver([auto, lock]), resolver([auto]), own)).toEqual([{ where: 'Jacket exact', campaignId: 'c1', lever: 'budgets' }])
    expect(turnsAutoOf(resolver([auto]), resolver([auto, lock]), own)).toEqual([])
  })
  it('enrolling with an AUTO lever: from not enrolled every AUTO counts', () => {
    const rows = [row({ kind: 'LEVEL', key: 'state', value: 'AUTO' })]
    expect(turnsAutoOf(resolver(rows, false), resolver(rows, true), own).map((t) => `${t.where}:${t.lever}`)).toEqual(['the product:state', 'Jacket exact:state', 'Jacket broad:state'])
  })
  it('a shared campaign is no brain\'s: it is never passed, so never counted', () => {
    const rows = [row({ kind: 'LEVEL', key: 'budgets', value: 'AUTO' })]
    expect(turnsAutoOf(resolver([]), resolver(rows), [])).toEqual([{ where: 'the product', campaignId: null, lever: 'budgets' }])
  })
})

describe('leverDoes and effectiveWord — what the brain will start doing', () => {
  it('names the level in a person\'s words, the switch when it is not live, and what the lever\'s code does today', () => {
    expect(effectiveWord('NOT_ENROLLED')).toBe('OFF (not enrolled)')
    expect(leverDoes('budgets', 'AUTO', 'live')).toMatch(/^the brain decides each campaign's daily budget inside the pace.*one automatic writer.*\(today: campaign budgets/)
    expect(leverDoes('budgets', 'AUTO', 'shadow')).toMatch(/while the server switch NEXUS_BID_BRAIN_MODE is shadow, it decides in shadow/)
    expect(leverDoes('hours', 'PROPOSE', 'live')).toMatch(/asks a person for each change/)
    expect(leverDoes('negatives', 'OBSERVE', 'live')).toMatch(/^shadow: the brain decides where and what to negate .* and logs it, and writes nothing \(today: .*AB-10/)
    expect(leverDoes('structure', 'OBSERVE', 'live')).toMatch(/\(today: new campaigns wait for AB-16\)$/)
    expect(leverDoes('budgets', 'LOCKED', 'live')).toMatch(/write gate refuses every other automatic writer/)
    expect(leverDoes('bids', 'LOCKED', 'live')).toMatch(/the bid brain leaves its keyword bids .* pin the campaign's bids/)
    expect(leverDoes('state', 'EXCLUDED', 'live')).toMatch(/today's engines run it/)
  })
})

describe('startLines and releasedLevers', () => {
  it('one line per move: the same move to shadow shared, each AUTO lever its own words', () => {
    const lines = startLines([...BRAIN_LEVERS], () => 'NOT_ENROLLED', (l) => (l === 'state' || l === 'budgets' ? 'AUTO' : 'OBSERVE'), 'live')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^keyword bids, ad group default bids, hourly plan, .*: OFF \(not enrolled\) → OBSERVE \(shadow\) — shadow: the brain decides and logs each of them/)
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^state .*: OFF \(not enrolled\) → AUTO — the brain decides a pause/), expect.stringMatching(/^daily budget: OFF \(not enrolled\) → AUTO — the brain decides each campaign's daily budget/)])
    expect(startLines(['bids'], () => 'AUTO', () => 'AUTO', 'live')).toEqual([])
    expect(startLines([...BRAIN_LEVERS], () => 'OBSERVE', () => 'EXCLUDED', 'live', 'campaign X')).toEqual([expect.stringMatching(/^every lever on campaign X: OBSERVE \(shadow\) → EXCLUDED — excluded by the Owner/)])
  })
  it('a lever the brain leaves is open to today\'s engines, but not one the gate holds at the Owner\'s lock', () => {
    const auto = [row({ kind: 'LEVEL', key: 'budgets', value: 'AUTO' }), row({ kind: 'LEVEL', key: 'bids', value: 'AUTO' })]
    const at = [{ campaignId: 'c1', name: 'Jacket exact' }]
    expect(releasedLevers(resolver(auto), resolver([...auto, row({ kind: 'LOCK', key: 'budgets', campaignId: 'c1' })]), at)).toEqual([])
    expect(releasedLevers(resolver(auto), resolver([...auto, row({ kind: 'LOCK', key: 'bids', campaignId: 'c1' })]), at)).toEqual(['keyword bids on Jacket exact'])
    expect(releasedLevers(resolver(auto), resolver([...auto, row({ kind: 'EXCLUDE', key: '*', campaignId: 'c1' })]), at)).toEqual(['keyword bids on Jacket exact', 'daily budget on Jacket exact'])
  })
})

describe('controlUndoRequest — the op that puts a choice back', () => {
  const tool = ADS_BRAIN_CONTROL_TOOLS[0]
  const base = { productId: P, market: 'IT' }
  const undo = (before: Record<string, unknown>) => controlUndoRequest({ ...base, ...before })
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['a level set where none was', { op: 'set-level', scope: 'PRODUCT', campaignId: null, kind: 'LEVEL', key: 'budgets', ref: '', open: false, value: null }, { op: 'set-level', lever: 'budgets', reset: true }],
    ['a level replaced', { op: 'set-level', scope: 'CAMPAIGN', campaignId: 'c1', kind: 'LEVEL', key: 'bids', ref: '', open: true, value: 'OBSERVE' }, { op: 'set-level', lever: 'bids', level: 'OBSERVE', campaignId: 'c1' }],
    ['a lock set', { op: 'lock', scope: 'PRODUCT', campaignId: null, kind: 'LOCK', key: 'hours', ref: 'hourCell:d1h14', open: false, value: null }, { op: 'unlock', lever: 'hours', ref: 'hourCell:d1h14' }],
    ['a lock ended', { op: 'unlock', scope: 'CAMPAIGN', campaignId: 'c1', kind: 'LOCK', key: 'budgets', ref: '', open: true, value: { dailyBudgetCents: 2000 } }, { op: 'lock', lever: 'budgets', value: { dailyBudgetCents: 2000 }, campaignId: 'c1' }],
    ['an exclusion', { op: 'exclude', scope: 'CAMPAIGN', campaignId: 'c1', kind: 'EXCLUDE', key: '*', ref: '', open: false, value: null }, { op: 'include', campaignId: 'c1' }],
    ['an include', { op: 'include', scope: 'PRODUCT', campaignId: null, kind: 'EXCLUDE', key: '*', ref: '', open: true, value: null }, { op: 'exclude' }],
    ['a value set', { op: 'set-value', scope: 'PRODUCT', campaignId: null, kind: 'VALUE', key: 'paceTargetPct', ref: '', open: true, value: 85 }, { op: 'set-value', key: 'paceTargetPct', value: 85 }],
    ['a value reset', { op: 'set-value', scope: 'PRODUCT', campaignId: null, kind: 'VALUE', key: 'longStopUntil', ref: '', open: false, value: null }, { op: 'set-value', key: 'longStopUntil', reset: true }],
    ['an enrollment', { op: 'enroll', enrolled: false }, { op: 'leave', bids: 'keep', pauses: 'keep' }],
    ['a leave', { op: 'leave', enrolled: true, levels: { bids: 'AUTO', budgets: 'PROPOSE', hours: 'OBSERVE' } }, { op: 'enroll', levels: { budgets: 'PROPOSE', hours: 'OBSERVE' } }],
  ]
  for (const [what, before, want] of cases) {
    it(`${what}: ${JSON.stringify(want)}`, () => {
      const built = undo(before)
      expect(built).toMatchObject({ args: { ...base, ...want } })
      if ('args' in built) expect(tool.input.safeParse(built.args).success).toBe(true)
    })
  }
  it('a record without its product, or without what it changed, cannot be put back', () => {
    expect(controlUndoRequest({ op: 'set-level' })).toEqual({ refusal: expect.stringMatching(/does not record the product/) })
    expect(undo({ op: 'set-level', kind: 'nothing' })).toEqual({ refusal: expect.stringMatching(/does not record what it changed/) })
  })
})
