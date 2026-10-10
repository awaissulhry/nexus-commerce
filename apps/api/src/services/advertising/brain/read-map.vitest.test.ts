/**
 * ONE BRAIN AB-3 — the map's pure parts (brain/read-map.ts), on a GALE IT shape: ten own campaigns the bid brain runs
 * LIVE, one campaign shared with two other products, campaigns an hourly plan holds, a classic dayparting schedule, and
 * rules at Auto, Propose and Observe. The database part runs in read-map-postgres.vitest.test.ts.
 *
 *   levers    an action-log row and a rule action each name the lever they move
 *   state     an engine's or a rule's mode under the account dial: acts, asks, watches, off
 *   writers   what is set up on one campaign, per lever: the brain (live or in shadow), the engines by the read their own
 *             job uses, the rules by their scope, the Owner (a lock, pinned bids, held keywords)
 *   owner     one line per lever: the Owner's lock first, then the one writer that acts, a clash, the ones that ask, nobody
 *   clash     two automatic writers (set up at Auto, or wrote) on one lever; a person, a safety owner, a rule that asks,
 *             never count
 *   terms     a keyword blocked where it is targeted; a keyword two products bid on
 *   actors    an action-log actor in the map's words (engine label, rule name, safety owner, person)
 *   amazon    AB-4 — Amazon's own rules: each one that acts on a brain campaign is a clash; one elsewhere is listed apart;
 *             an Amazon rule counts as an automatic writer of its lever; what could not be read is said
 *   truth     A2a — a lever the Owner gave the brain says what the brain really does there (lever-state.ts): the negatives
 *             act after their shadow days under the live switch, the harvest watches under its own switch naming it, the
 *             bidding strategy asks during the N4 clock; the brain's negatives and harvest writes and a bidding-strategy
 *             switch are evidence; nobody set to act but someone wrote is said with who, how many and when
 *
 * Values are made up (public repo).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

const {
  amazonRulesGap, brainNoteOf, clashOf, configuredWriters, engineState, leverOfAction, leverOwner, leversOfRuleAction, ruleState, selfBlocking, serverVariables, siblingTerms, writerOfActor, keywordValuesOf,
} = await import('./read-map.js')
const { resolveBrainSettings } = await import('./settings.js')
const { campaignNativeRules } = await import('./native-rules.js')

const DIAL = { stopped: false, suggest: false }
/** A2a — the server switches as production has them today: the bid brain in shadow, nothing else live. */
const RUNTIME = {
  ceiling: 'shadow', ceilingLive: false, cycleOn: false, hoursOn: true,
  harvest: { live: false, why: 'the brain\'s env ceiling NEXUS_BID_BRAIN_MODE is not live' },
  structure: { live: false, why: 'the brain\'s env ceiling NEXUS_BID_BRAIN_MODE is not live' },
  posture: { posture: 'auto' as const, why: 'the account ads dial is AUTO' },
}
const GALE = 'p-gale'

const campaign = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, marketplace: 'IT', market: 'IT', status: 'ENABLED', adProduct: 'SPONSORED_PRODUCTS', liveBidWritesEnabled: true,
  pinBids: false, pinnedBy: null, portfolioId: 'pf-gale', productIds: [GALE], brainCanOwn: true, ...extra,
})
const engines = new Map(Object.entries({
  'rank-defend': { key: 'rank-defend', name: 'Hourly bid plans', mode: 'AUTO', group: 'acts', why: 'on', start: null },
  dayparting: { key: 'dayparting', name: 'Classic dayparting', mode: 'AUTO', group: 'acts', why: 'on', start: null },
  'auto-bid': { key: 'auto-bid', name: 'Bid optimiser', mode: 'AUTO', group: 'acts', why: 'on', start: null },
  'tos-defense': { key: 'tos-defense', name: 'Top-of-Search defense', mode: 'OFF', group: 'server-off', why: 'NEXUS_TOS_DEFENSE off', start: null },
  'budget-schedules': { key: 'budget-schedules', name: 'Budget schedules', mode: 'AUTO', group: 'ready', why: 'on', start: null },
}))
const rule = (id: string, name: string, autonomyLevel: string, actions: string[], extra: Record<string, unknown> = {}) => ({
  id, name, enabled: true, autonomyLevel, dryRun: false, actions: actions.map((type) => ({ type })), scopeMarketplace: null, scopePortfolioId: null, scopeCampaignId: null, scopeProductId: null, ...extra,
})
const live = Array.from({ length: 10 }, (_, i) => `c-gale-${i + 1}`)
const cfg = {
  brainMode: new Map(live.map((id) => [id, 'LIVE'])),
  brainOwned: new Set(live),
  ceilingLive: true,
  ceiling: 'live' as const,
  rankHeld: new Set(['c-gale-1', 'c-plan-a', 'c-plan-b']),
  schedules: new Map([['c-classic', [{ name: 'weekend boost', goal: false }]]]),
  autopilotOf: () => null,
  rules: [
    rule('r-bid', 'Lower bids on waste', 'AUTO', ['bid_down'], { scopeMarketplace: 'IT' }),
    rule('r-neg', 'Negate waste', 'PROPOSE', ['add_negative_exact']),
    rule('r-harvest', 'Harvest winners', 'AUTO', ['harvest_and_negate']),
    rule('r-other', 'Other product only', 'AUTO', ['bid_up'], { scopeProductId: 'p-misano' }),
    rule('r-watch', 'Watch budgets', 'OBSERVE', ['set_daily_budget']),
  ],
  rootOfRuleProduct: new Map([['p-misano', 'p-misano']]),
  budgetScheduleOf: (id: string) => (id === 'c-gale-2' ? ['evenings'] : []),
  poolOf: new Map<string, string>(),
  budgetPlanFor: () => null,
  goalOf: () => null,
  slotOf: new Map([['c-gale-3', 'exact-brand']]),
  coverageOf: () => null,
  heldKeywords: new Map([['c-gale-4', 2]]),
  engines,
  dial: DIAL,
  runtime: { ...RUNTIME, ceiling: 'live', ceilingLive: true },
}
const settings = (campaignId: string, overrides: Parameters<typeof resolveBrainSettings>[0]['overrides'] = []) =>
  resolveBrainSettings({ productId: GALE, market: 'IT', campaignId, enrolled: true, overrides })

describe('levers of an action and of a rule action', () => {
  it('names the lever an action-log row changed, or none', () => {
    expect(leverOfAction('AD_BID_UPDATE', 'AD_TARGET')).toBe('bids')
    expect(leverOfAction('AD_BID_UPDATE', 'AD_GROUP')).toBe('adGroupBids')
    expect(leverOfAction('AD_BUDGET_UPDATE', 'CAMPAIGN')).toBe('budgets')
    expect(leverOfAction('update_placement_bidding', 'CAMPAIGN')).toBe('placements')
    expect(leverOfAction('AD_ENTITY_STATE_UPDATE', 'CAMPAIGN')).toBe('state')
    expect(leverOfAction('create_negative_keyword', 'AD_TARGET')).toBe('negatives')
    expect(leverOfAction('create_keyword', 'AD_TARGET')).toBe('harvest')
    // A2a — a negative product target and a bidding-strategy switch are levers too.
    expect(leverOfAction('create_negative_product_target', 'AD_TARGET')).toBe('negatives')
    expect(leverOfAction('AD_BIDDING_STRATEGY_UPDATE', 'CAMPAIGN')).toBe('biddingStrategy')
    expect(leverOfAction('update_rule', 'RULE')).toBeNull()
  })

  it('names the levers a rule action moves', () => {
    expect(leversOfRuleAction('bid_down')).toEqual(['bids'])
    expect(leversOfRuleAction('pace_budget')).toEqual(['budgets'])
    expect(leversOfRuleAction('harvest_and_negate')).toEqual(['harvest', 'negatives'])
    expect(leversOfRuleAction('pause_campaign')).toEqual(['state'])
    expect(leversOfRuleAction('notify')).toEqual([])
  })
})

describe('state under the account dial', () => {
  it('an engine or a rule at Auto acts, at Propose asks, at Observe watches; a halt or the dial at Suggest changes it', () => {
    expect(['AUTO', 'PROPOSE', 'OBSERVE', 'OFF'].map((m) => engineState(m, DIAL))).toEqual(['acts', 'asks', 'watches', 'off'])
    expect(engineState('AUTO', { stopped: false, suggest: true })).toBe('asks')
    expect(engineState('AUTO', { stopped: true, suggest: false })).toBe('off')
    expect(ruleState({ enabled: true, autonomyLevel: 'AUTO', dryRun: false }, DIAL)).toBe('acts')
    expect(ruleState({ enabled: true, autonomyLevel: 'AUTO', dryRun: true }, DIAL)).toBe('watches')
    expect(ruleState({ enabled: false, autonomyLevel: 'AUTO', dryRun: false }, DIAL)).toBe('off')
  })
})

describe('configuredWriters and leverOwner — the GALE IT shape', () => {
  it('a LIVE campaign: the brain owns the bids (and runs its hourly plan); a market rule at Auto clashes with it; held keywords are named', () => {
    const w = configuredWriters(campaign('c-gale-1'), cfg, settings('c-gale-1'))
    expect(w.bids.map((x) => [x.who, x.state])).toEqual([['the brain', 'acts'], ['rule "Lower bids on waste"', 'acts']])
    expect(w.hours.map((x) => x.who)).toContain('the brain')
    expect(w.hours.map((x) => x.who)).not.toContain('Hourly bid plans')
    expect(leverOwner(w.bids, { excluded: false, brainNote: null })).toBe('two or more writers: rule "Lower bids on waste", the brain')
    expect(clashOf(w.bids)).toEqual(['rule "Lower bids on waste"', 'the brain'])
    // The other product's rule never reaches GALE; the Propose rule asks; the Observe rule watches.
    expect(w.bids.some((x) => x.who.includes('Other product'))).toBe(false)
    expect(w.negatives.map((x) => [x.who, x.state])).toEqual([['the brain', 'watches'], ['rule "Negate waste"', 'asks'], ['rule "Harvest winners"', 'acts']])
    expect(w.budgets.map((x) => [x.who, x.state])).toContainEqual(['rule "Watch budgets"', 'watches'])
    const held = configuredWriters(campaign('c-gale-4'), cfg, settings('c-gale-4'))
    expect(held.bids.find((x) => x.kind === 'owner')?.why).toMatch(/2 keywords held/)
  })

  it('a campaign an hourly plan holds and the brain does not own: the plan and the bid brain in shadow; auto-bid leaves it', () => {
    const w = configuredWriters(campaign('c-plan-a'), cfg, settings('c-plan-a'))
    expect(w.bids.map((x) => [x.who, x.state])).toEqual([['the brain', 'watches'], ['Hourly bid plans', 'acts'], ['rule "Lower bids on waste"', 'acts']])
    expect(w.placements.map((x) => [x.who, x.state])).toEqual([['the brain', 'watches'], ['Hourly bid plans', 'acts'], ['Top-of-Search defense', 'off']])
    expect(leverOwner(w.hours, { excluded: false, brainNote: 'the brain watches in shadow' })).toBe('Hourly bid plans')
  })

  it('a classic dayparting schedule, a budget schedule, a playbook slot', () => {
    const classic = configuredWriters(campaign('c-classic'), cfg, settings('c-classic'))
    expect(classic.hours.map((x) => x.who)).toContain('Classic dayparting')
    expect(classic.bids.map((x) => x.who)).not.toContain('Bid optimiser')
    expect(configuredWriters(campaign('c-gale-2'), cfg, settings('c-gale-2')).budgets.map((x) => x.who)).toContain('Budget schedules')
    expect(configuredWriters(campaign('c-gale-3'), cfg, settings('c-gale-3')).structure.map((x) => [x.who, x.state])).toEqual([['the brain', 'watches'], ['the playbook', 'asks']])
  })

  it('A2b / wave 2 — an archived campaign: no engine, rule, brain lever or lock is set to act there; a LIVE enrollment left on it is said', () => {
    const w = configuredWriters(campaign('c-gale-7', { status: 'ARCHIVED' }), cfg, settings('c-gale-7'))
    expect(w.bids).toEqual([{ who: 'the brain', kind: 'brain', state: 'off', basis: 'configured', why: 'archived: its bid brain enrollment (LIVE) is left over — nothing runs on an archived campaign' }])
    for (const [lever, writers] of Object.entries(w)) if (lever !== 'bids') expect(writers, lever).toEqual([])
    expect(clashOf(w.bids)).toBeNull()
    expect(leverOwner(w.bids, { excluded: false, brainNote: null, archived: true })).toBe('nobody (archived: nothing runs on an archived campaign)')
    const wrote = { who: 'Bid optimiser', kind: 'engine' as const, state: 'acts' as const, basis: 'wrote' as const, why: 'Bid optimiser wrote', changes: 2, last: '2026-10-01T05:00:00.000Z' }
    expect(leverOwner([...w.bids, wrote], { excluded: false, brainNote: null, days: 14, archived: true })).toBe('nobody set to act now — Bid optimiser wrote 2 changes in 14 days (last 2026-10-01) (archived: nothing runs on an archived campaign)')
    // An archived campaign nobody enrolled: nothing at all.
    expect(Object.values(configuredWriters(campaign('c-plan-a', { status: 'ARCHIVED' }), cfg, settings('c-plan-a'))).flat()).toEqual([])
  })

  it('wave 2 — the Owner\'s kill switch on the bids of a campaign the bid brain owns: it watches there, in his words', () => {
    const killed = 'stopped by the Owner\'s kill switch (user:owner, 2026-10-09, product p-gale in IT): "testing"'
    const w = configuredWriters(campaign('c-gale-1', { killed: { bids: killed } }), cfg, settings('c-gale-1'))
    expect(w.bids.find((x) => x.kind === 'brain')).toMatchObject({ state: 'watches', why: `the bid brain owns it (LIVE), but ${killed}: it decides and logs, and writes nothing` })
    // Its hourly plan still runs (another lever); the rule at Auto is the one writer that acts on the bids.
    expect(w.hours.find((x) => x.kind === 'brain')).toMatchObject({ state: 'acts' })
    expect(leverOwner(w.bids, { excluded: false, brainNote: brainNoteOf(w.bids) })).toBe('rule "Lower bids on waste"')
    const placements = configuredWriters(campaign('c-gale-1', { killed: { placements: killed } }), cfg, settings('c-gale-1'))
    expect(placements.placements.find((x) => x.kind === 'brain')).toMatchObject({ state: 'watches' })
  })

  it('an allowlisted campaign nobody holds: auto-bid acts beside the brain in shadow', () => {
    const w = configuredWriters(campaign('c-free'), cfg, settings('c-free'))
    expect(w.bids.map((x) => [x.who, x.state])).toEqual([['the brain', 'watches'], ['Bid optimiser', 'acts'], ['rule "Lower bids on waste"', 'acts']])
  })

  it('the shared campaign: no brain level is shown on its other levers; the Owner\'s lock and pinned bids hold', () => {
    const shared = campaign('c-shared', { productIds: [GALE, 'p-misano', 'p-moss'], brainCanOwn: false, pinBids: true, pinnedBy: 'user:owner' })
    const w = configuredWriters(shared, cfg, settings('c-shared'))
    expect(w.negatives.some((x) => x.kind === 'brain')).toBe(false)
    expect(w.bids.some((x) => x.who.includes('Other product'))).toBe(true)
    expect(leverOwner(w.bids, { excluded: false, brainNote: 'the brain watches in shadow' })).toBe('the Owner (bids pinned by hand by user:owner)')
    const lock = { id: 'o-1', productId: GALE, marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-gale-5', kind: 'LOCK', key: 'budgets', ref: '', value: { dailyBudgetCents: 2000 }, by: 'user:owner', reason: null, createdAt: new Date('2026-10-08T09:00:00Z'), endedAt: null }
    const locked = configuredWriters(campaign('c-gale-5'), cfg, settings('c-gale-5', [lock]))
    expect(leverOwner(locked.budgets, { excluded: false, brainNote: null })).toMatch(/^the Owner \(locked at his own value by the campaign override/)
  })

  it('what the brain does where it only watches: the bid brain\'s shadow, or a lever whose shadow is not built yet', () => {
    expect(brainNoteOf(configuredWriters(campaign('c-free'), cfg, settings('c-free')).bids)).toBe('the brain watches in shadow')
    expect(brainNoteOf(configuredWriters(campaign('c-free'), cfg, settings('c-free')).budgets)).toBe('the brain is set to watch; campaign budgets: OBSERVE plans and logs them (ads-brain view money), PROPOSE asks a person for the day\'s moves, AUTO writes them and the intraday ladder (AB-8, under a live NEXUS_BID_BRAIN_MODE)')
    expect(brainNoteOf([])).toBeNull()
    expect(serverVariables('NEXUS_ENABLE_AMAZON_ADS_CRON is off. NEXUS_ENABLE_RANK_DEFEND is not 1; NEXUS_ENABLE_AMAZON_ADS_CRON again')).toEqual(['NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_ENABLE_RANK_DEFEND'])
  })

  it('nobody: no writer, or only ones that ask', () => {
    expect(leverOwner([], { excluded: false, brainNote: null })).toBe('nobody')
    expect(leverOwner([], { excluded: true, brainNote: null })).toBe('nobody (excluded from the brain by the Owner)')
    expect(leverOwner([{ who: 'rule "x"', kind: 'rule', state: 'asks', basis: 'configured', why: '' }], { excluded: false, brainNote: null })).toBe('nobody acts alone — rule "x" asks a person')
  })

  it('A2a — nobody set to act, but someone wrote: who, how many, in how many days, and when last', () => {
    const wrote = { who: 'the brain', kind: 'brain' as const, state: 'acts' as const, basis: 'wrote' as const, why: 'the brain\'s negatives writer added or retired it (AB-10)', changes: 3, last: '2026-10-08T05:00:00.000Z' }
    const watching = { who: 'the brain', kind: 'brain' as const, state: 'watches' as const, basis: 'configured' as const, why: 'OBSERVE: x' }
    expect(leverOwner([watching, wrote], { excluded: false, brainNote: 'the brain is set to watch; x', days: 14 }))
      .toBe('nobody set to act now — the brain wrote 3 changes in 14 days (last 2026-10-08); the brain is set to watch; x')
    expect(leverOwner([wrote], { excluded: true, brainNote: null, days: 7 })).toBe('nobody set to act now — the brain wrote 3 changes in 7 days (last 2026-10-08) (excluded from the brain by the Owner)')
    // One that acts or asks still decides the line.
    expect(leverOwner([wrote, { ...watching, state: 'asks' }], { excluded: false, brainNote: null, days: 14 })).toBe('nobody acts alone — the brain asks a person')
  })
})

describe('A2a — the map says what the brain really does with a lever the Owner gave it', () => {
  const level = (key: string, value: string, id = key) => ({ id: `o-${id}`, productId: GALE, marketplace: 'IT', scope: 'PRODUCT', campaignId: null, kind: 'LEVEL', key, ref: '', value, by: 'user:owner', reason: null, createdAt: new Date('2026-10-01T09:00:00Z'), endedAt: null })
  const auto = settings('c-gale-6', [level('negatives', 'AUTO'), level('harvest', 'AUTO'), level('biddingStrategy', 'AUTO'), level('structure', 'PROPOSE')])
  const gates = (over: Record<string, unknown> = {}) => ({ negativesShadow: { inShadow: false, why: null }, strategyAsks: null, ...over })
  const brainOf = (w: Record<string, Array<{ kind: string; state: string; why: string }>>, lever: string) => w[lever].find((x) => x.kind === 'brain')

  it('negatives AUTO past its shadow days under the live switch: the brain acts, and the line says so', () => {
    const w = configuredWriters(campaign('c-gale-6'), cfg, auto, gates())
    expect(brainOf(w, 'negatives')).toMatchObject({ state: 'acts', why: expect.stringMatching(/^AUTO: the brain writes the day's negatives alone/) })
    expect(leverOwner(w.negatives.filter((x) => !x.who.startsWith('rule')), { excluded: false, brainNote: null })).toBe('the brain')
    // Inside its shadow days it watches, naming them.
    const shadow = configuredWriters(campaign('c-gale-6'), cfg, auto, gates({ negativesShadow: { inShadow: true, why: 'the negatives lever runs 14 days in shadow first: 3 days run' } }))
    expect(brainOf(shadow, 'negatives')).toMatchObject({ state: 'watches', why: 'AUTO, but in shadow for now: the negatives lever runs 14 days in shadow first: 3 days run' })
  })

  it('harvest AUTO watches under its own switch, naming it; the structure asks only under its own', () => {
    const w = configuredWriters(campaign('c-gale-6'), cfg, auto, gates())
    expect(brainOf(w, 'harvest')).toMatchObject({ state: 'watches', why: expect.stringContaining('NEXUS_BID_BRAIN_MODE is not live') })
    expect(brainOf(w, 'structure')).toMatchObject({ state: 'watches' })
    const live = { ...cfg, runtime: { ...cfg.runtime, harvest: { live: true, why: 'live' }, structure: { live: true, why: 'live' } } }
    const w2 = configuredWriters(campaign('c-gale-6'), live, auto, gates())
    expect(brainOf(w2, 'harvest')).toMatchObject({ state: 'acts' })
    expect(brainOf(w2, 'structure')).toMatchObject({ state: 'asks' })
  })

  it('the bidding strategy: off without the product cycle, asks during N4, acts after it — never "nobody" while the Owner gave it', () => {
    const off = configuredWriters(campaign('c-gale-6'), cfg, auto, gates())
    expect(brainOf(off, 'biddingStrategy')).toMatchObject({ state: 'off', why: expect.stringContaining('NEXUS_ADS_BRAIN_CYCLE is off') })
    const cycle = { ...cfg, runtime: { ...cfg.runtime, cycleOn: true } }
    const n4 = configuredWriters(campaign('c-gale-6'), cycle, auto, gates({ strategyAsks: { why: 'AUTO, but for the first 30 days the lever is the brain\'s every switch asks a person (N4)' } }))
    expect(brainOf(n4, 'biddingStrategy')).toMatchObject({ state: 'asks', why: expect.stringContaining('(N4)') })
    expect(leverOwner(n4.biddingStrategy, { excluded: false, brainNote: null })).toBe('nobody acts alone — the brain asks a person')
    expect(brainOf(configuredWriters(campaign('c-gale-6'), cycle, auto, gates()), 'biddingStrategy')).toMatchObject({ state: 'acts' })
  })

  it('the Owner\'s kill switch: the brain only watches the lever, in his words', () => {
    const w = configuredWriters(campaign('c-gale-6', { killed: { negatives: 'stopped by the Owner\'s kill switch (user:owner, 2026-10-09, product p-gale in IT)' } }), cfg, auto, gates())
    expect(brainOf(w, 'negatives')).toMatchObject({ state: 'watches', why: expect.stringContaining('stopped by the Owner\'s kill switch') })
  })
})

describe('clashOf', () => {
  it('counts automatic writers that are set up to act or that wrote; never a person, a safety owner or one that asks', () => {
    const w = (who: string, kind: string, state: string, basis: string) => ({ who, kind, state, basis, why: '' }) as never
    expect(clashOf([w('the brain', 'brain', 'acts', 'configured'), w('a person', 'person', 'acts', 'wrote'), w('safety: retail-guard', 'safety', 'acts', 'wrote')])).toBeNull()
    expect(clashOf([w('the brain', 'brain', 'acts', 'configured'), w('rule "x"', 'rule', 'asks', 'configured')])).toBeNull()
    expect(clashOf([w('the brain', 'brain', 'acts', 'configured'), w('Bid optimiser', 'engine', 'acts', 'wrote')])).toEqual(['Bid optimiser', 'the brain'])
    expect(clashOf([w('the brain', 'brain', 'acts', 'configured'), w('the brain', 'brain', 'acts', 'wrote')])).toBeNull()
  })
})

describe('terms', () => {
  const k = (id: string, campaignId: string, adGroupId: string, text: string, match: string, negative = false, level: string | null = null) => ({ id, campaignId, adGroupId, text, match, negative, level })
  it('a keyword blocked where it is targeted: a negative exact at its ad group, a phrase inside it at its campaign', () => {
    const rows = [
      k('t1', 'c1', 'g1', 'gale jacket', 'EXACT'), k('n1', 'c1', 'g1', 'Gale  Jacket', 'NEGATIVE_EXACT', true, 'AD_GROUP'),
      k('t2', 'c1', 'g2', 'leather moto jacket', 'PHRASE'), k('n2', 'c1', 'g9', 'moto jacket', 'NEGATIVE_PHRASE', true, 'CAMPAIGN'),
      k('t3', 'c2', 'g3', 'gale jacket', 'EXACT'), k('n3', 'c2', 'g4', 'gale jacket', 'NEGATIVE_EXACT', true, 'AD_GROUP'),
      k('t4', 'c3', 'g5', 'jacket', 'BROAD'), k('n4', 'c3', 'g5', 'jacket', 'NEGATIVE_EXACT', true, 'AD_GROUP'),
    ]
    expect(selfBlocking(rows).map((b) => [b.positiveId, b.negativeId])).toEqual([['t1', 'n1'], ['t2', 'n2']])
    expect(selfBlocking(rows)[1].negative).toBe('negative phrase "moto jacket" at its campaign')
    // The Owner's match-type funnel: a phrase of two words or more narrows a broad keyword; one word still blocks it.
    const funnel = [k('b1', 'c4', 'g6', 'racing jacket', 'BROAD'), k('n5', 'c4', 'g6', 'racing jacket', 'NEGATIVE_PHRASE', true, 'AD_GROUP'), k('b2', 'c5', 'g7', 'racing jacket', 'BROAD'), k('n6', 'c5', 'g7', 'jacket', 'NEGATIVE_PHRASE', true, 'AD_GROUP')]
    expect(selfBlocking(funnel).map((b) => [b.positiveId, b.negativeId])).toEqual([['b2', 'n6']])
  })

  it('a keyword two products bid on in one market; shared and unowned campaigns do not count', () => {
    const rows = [k('a', 'c-gale', 'g', 'moto jacket', 'EXACT'), k('b', 'c-misano', 'g2', 'Moto Jacket', 'PHRASE'), k('c', 'c-shared', 'g3', 'gloves', 'EXACT'), k('d', 'c-gale', 'g', 'gloves', 'EXACT'), k('e', 'c-gale', 'g', 'free', 'NEGATIVE_EXACT', true, 'AD_GROUP'), k('f', 'c-misano', 'g2', 'free', 'NEGATIVE_EXACT', true, 'AD_GROUP')]
    const owners = new Map([['c-gale', GALE], ['c-misano', 'p-misano'], ['c-shared', null]])
    expect(siblingTerms(rows, owners)).toEqual([{ text: 'moto jacket', products: [GALE, 'p-misano'].sort(), campaignIds: ['c-gale', 'c-misano'] }])
  })
})

describe('writerOfActor', () => {
  it('names an engine, the brain, a rule, a safety owner, a person and an actor nobody claims', () => {
    const names = new Map([['r-bid', 'Lower bids on waste']])
    expect(writerOfActor('automation:auto-bid', names)).toMatchObject({ who: 'Bid optimiser', kind: 'engine' })
    expect(writerOfActor('automation:rank-defend-s1', names)).toMatchObject({ who: 'Hourly bid plans', kind: 'engine' })
    expect(writerOfActor('automation:bid-brain', names)).toMatchObject({ who: 'the brain', kind: 'brain' })
    // A2a — the brain's negatives and harvest writers are the brain, not an engine.
    expect(writerOfActor('automation:ads-brain-negatives', names)).toMatchObject({ who: 'the brain', kind: 'brain', why: expect.stringContaining('negatives writer') })
    expect(writerOfActor('automation:ads-brain-harvest', names)).toMatchObject({ who: 'the brain', kind: 'brain', why: expect.stringContaining('harvest writer') })
    expect(writerOfActor('automation:ads-brain-strategy', names)).toMatchObject({ who: 'the brain', kind: 'brain' })
    expect(writerOfActor('automation:r-bid', names)).toMatchObject({ who: 'rule "Lower bids on waste"', kind: 'rule' })
    expect(writerOfActor('automation:retail-guard-cron', names)).toMatchObject({ kind: 'safety' })
    expect(writerOfActor('user:owner', names)).toMatchObject({ who: 'a person', kind: 'person' })
    expect(writerOfActor('automation:gone-rule', names)).toMatchObject({ kind: 'unknown' })
    expect(writerOfActor(null, names)).toMatchObject({ who: 'no known author', kind: 'unknown' })
  })
})

describe('AB-4 amazonRulesGap — Amazon\'s own rules in the clashes view', () => {
  const NOW = new Date('2026-10-08T06:00:00Z')
  const budgetRule = { ruleId: 'r-1', name: 'Weekend boost', ruleType: 'SCHEDULE', ruleState: 'ACTIVE', ruleStatus: null, increasePct: 25, startDate: '20261001', endDate: null, eventName: null, recurrence: 'DAILY', daysOfWeek: [], metric: null, comparison: null, threshold: null }
  const native = new Map([
    ['c-budget', campaignNativeRules({ campaignId: 'c-budget', snapshot: { fetchedAt: NOW, readings: { budgetRules: { state: 'read', rules: [budgetRule] } } }, strategy: 'LEGACY_FOR_SALES', strategyAt: NOW }, NOW)],
    ['c-rule', campaignNativeRules({ campaignId: 'c-rule', snapshot: { fetchedAt: NOW, readings: { budgetRules: { state: 'read', rules: [] } } }, strategy: 'RULE_BASED', strategyAt: NOW }, NOW)],
    ['c-failed', campaignNativeRules({ campaignId: 'c-failed', snapshot: { fetchedAt: NOW, readings: { budgetRules: { state: 'could_not_read', why: 'the read failed: Amazon answered 500: x' } } }, strategy: 'MANUAL', strategyAt: NOW }, NOW)],
    ['c-other', campaignNativeRules({ campaignId: 'c-other', snapshot: null, strategy: 'RULE_BASED', strategyAt: NOW }, NOW)],
  ])
  const rows = [
    { campaignId: 'c-budget', name: 'IT_Exact_Gale', brainCampaign: true },
    { campaignId: 'c-rule', name: 'IT_Auto_Gale', brainCampaign: true },
    { campaignId: 'c-failed', name: 'IT_Phrase_Gale', brainCampaign: true },
    { campaignId: 'c-unread', name: 'IT_New_Gale', brainCampaign: true },
    { campaignId: 'c-other', name: 'IT_Misano', brainCampaign: false },
  ]

  it('each rule that acts on a brain campaign is a clash, with its levers and what to do; one on another campaign is listed apart', () => {
    const gap = amazonRulesGap(rows, native)
    expect(gap.clashes.map((c) => [c.campaignId, c.kind, c.rule, c.levers])).toEqual([
      ['c-budget', 'budgetRules', 'Weekend boost', ['budgets']],
      ['c-rule', 'ruleBasedBidding', 'RULE_BASED', ['bids', 'biddingStrategy']],
    ])
    expect(gap.clashes[0].meaning).toMatch(/^Amazon budget rule "Weekend boost" acts on this brain campaign's budgets: a second brain inside Amazon\. While it is attached, the product's brain refuses to take that lever to AUTO; detach it in Amazon's Campaign Manager \(Nexus never edits Amazon's rules\)$/)
    expect(gap.notBrainCampaigns).toEqual([expect.objectContaining({ campaignId: 'c-other', kind: 'ruleBasedBidding' })])
  })

  it('"could not read" is said: the kinds Nexus cannot read anywhere, and each brain campaign whose read failed or is missing', () => {
    const gap = amazonRulesGap(rows, native)
    expect(gap.couldNotRead.map((c) => [c.kind, c.campaignId ?? null])).toEqual([
      ['optimizationRules', null], ['scheduleBidRules', null], ['budgetRules', 'c-failed'], ['budgetRules', 'c-unread'],
    ])
    expect(gap.couldNotRead[2]).toMatchObject({ why: 'the read failed: Amazon answered 500: x', at: NOW.toISOString() })
    expect(gap.couldNotRead[3]).toMatchObject({ why: expect.stringMatching(/^not read yet/) })
    expect(gap.read.budgetRules).toContain('GET /sp/campaigns/{campaignId}/budgetRules')
  })

  it('nothing read, nothing invented: no clash', () => {
    expect(amazonRulesGap([{ campaignId: 'x', name: 'x', brainCampaign: true }], new Map()).clashes).toEqual([])
  })

  it('an Amazon rule is an automatic writer: with the brain on the same lever it is a clash; alone it owns the line', () => {
    const amazon = { who: 'Amazon-run bidding strategy "RULE_BASED"', kind: 'amazon' as const, state: 'acts' as const, basis: 'configured' as const, why: 'Amazon\'s own rule' }
    const brain = { who: 'the brain', kind: 'brain' as const, state: 'acts' as const, basis: 'configured' as const, why: 'the bid brain owns it (LIVE)' }
    expect(clashOf([brain, amazon])).toEqual(['Amazon-run bidding strategy "RULE_BASED"', 'the brain'])
    expect(leverOwner([brain, amazon], { excluded: false, brainNote: null })).toBe('two or more writers: Amazon-run bidding strategy "RULE_BASED", the brain')
    expect(leverOwner([amazon], { excluded: false, brainNote: null })).toBe('Amazon-run bidding strategy "RULE_BASED"')
  })
})

describe('keywordValuesOf — the Owner\'s own per-keyword values (integration review fix)', () => {
  const row = (o: Record<string, unknown>) => ({ id: 'o', productId: 'p1', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c1', kind: 'VALUE', key: 'tosTargetPct', ref: 'target:t-1', value: 40, by: 'user:owner', reason: null, createdAt: new Date('2026-10-09T08:00:00Z'), endedAt: null, ...o }) as never
  it('a campaign\'s keyword values, or the product\'s in a market; never a plain value, an ended one or another scope\'s', () => {
    const rows = [
      row({}), row({ ref: 'target:t-2', value: null, reason: 'off here' }), row({ ref: '' }), row({ endedAt: new Date() }),
      row({ campaignId: 'c2' }), row({ scope: 'PRODUCT', campaignId: null, ref: 'target:t-9', value: 30 }), row({ scope: 'PRODUCT', campaignId: null, marketplace: 'DE', ref: 'target:t-8' }),
    ]
    expect(keywordValuesOf(rows, { scope: 'CAMPAIGN', campaignId: 'c1' })).toEqual([
      { key: 'tosTargetPct', ref: 'target:t-1', value: 40, by: 'user:owner', at: '2026-10-09T08:00:00.000Z' },
      { key: 'tosTargetPct', ref: 'target:t-2', value: null, by: 'user:owner', at: '2026-10-09T08:00:00.000Z', reason: 'off here' },
    ])
    expect(keywordValuesOf(rows, { scope: 'PRODUCT', productId: 'p1', market: 'IT' }).map((v) => [v.ref, v.value])).toEqual([['target:t-9', 30]])
  })
})
