/**
 * ONE BRAIN AB-20 — the pure rules of retirement (brain/retire.ts): who is ready, which rows retire per writer type and which
 * stay (each with why), the plan's basis, the configuration fingerprint and the give-back decision. Values are made up.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyRuleAction, giveBackDecision, planRetirement, retireBasis, retireFingerprint, retireReadiness, ROWLESS_WRITERS, ruleActionLevers, stableJson,
  type CampaignHold, type RetireCandidate,
} from './retire.js'
import { BRAIN_LEVERS, type BrainLever } from './levers.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'

const P = 'p-jacket'
const at = new Date('2026-10-08T10:00:00Z')
let n = 0
const level = (lever: BrainLever, value: string, extra: Partial<OverrideRow> = {}): OverrideRow => ({
  id: `o${++n}`, productId: P, marketplace: 'IT', scope: 'PRODUCT', campaignId: null, kind: 'LEVEL', key: lever, ref: '', value, by: 'user:owner', reason: null, createdAt: at, endedAt: null, ...extra,
})
/** Every lever settled the way a fully enrolled product would be today: AUTO where the lever takes it, else the Owner's own level. */
const SETTLED: OverrideRow[] = [
  level('bids', 'AUTO'), level('adGroupBids', 'OFF'), level('hours', 'PROPOSE'), level('placements', 'OFF'), level('state', 'AUTO'), level('budgets', 'AUTO'),
  level('portfolioCap', 'AUTO'), level('negatives', 'AUTO'), level('harvest', 'AUTO'), level('structure', 'PROPOSE'), level('biddingStrategy', 'OFF'), level('offAmazon', 'OFF'),
]
const settings = (overrides: OverrideRow[]) => resolveBrainSettings({ productId: P, market: 'IT', enrolled: true, overrides })
const ready = (over: Partial<Parameters<typeof retireReadiness>[0]> = {}) =>
  retireReadiness({ enrolled: true, ceilingLive: true, ceiling: 'live', settings: settings(SETTLED), kills: {}, ownCampaigns: 2, ...over })

describe('AB-20 — readiness: every lever AUTO or the Owner\'s own choice, under the live switch', () => {
  it('every lever AUTO or chosen by the Owner, live, with own campaigns: ready', () => {
    const r = ready()
    expect(r.ready).toBe(true)
    expect(r.blockers).toEqual([])
    expect(r.levers).toHaveLength(BRAIN_LEVERS.length)
    expect(r.levers.find((l) => l.lever === 'hours')).toMatchObject({ ok: true, effective: 'PROPOSE', source: 'product' })
    expect(r.levers.find((l) => l.lever === 'bids')).toMatchObject({ ok: true, effective: 'AUTO' })
  })

  it('a lever still at the brain\'s default (shadow) is not settled: not ready, and it says which', () => {
    const r = ready({ settings: settings(SETTLED.filter((o) => o.key !== 'negatives')) })
    expect(r.ready).toBe(false)
    expect(r.levers.find((l) => l.lever === 'negatives')).toMatchObject({ ok: false, effective: 'OBSERVE', source: 'default' })
    expect(r.why).toContain('negatives (OBSERVE by the brain\'s default')
  })

  it('a lock of the Owner settles a lever; a kill switch leaves readiness alone and is said (its rows are simply not held)', () => {
    const lock: OverrideRow = { ...level('negatives', 'x'), kind: 'LOCK', value: null }
    expect(ready({ settings: settings([...SETTLED.filter((o) => o.key !== 'negatives'), lock]) }).ready).toBe(true)
    const killed = ready({ kills: { budgets: 'stopped by user:owner on 2026-10-08: "test stop"' } })
    expect(killed.ready).toBe(true)
    expect(killed.levers.find((l) => l.lever === 'budgets')?.why).toBe('AUTO (the Owner\'s product choice); stopped by a kill switch (stopped by user:owner on 2026-10-08: "test stop"): the writers of this lever stay on while it stands')
  })

  it('not enrolled, excluded, the switch in shadow, or no campaign of its own: not ready, each said', () => {
    expect(retireReadiness({ enrolled: false, ceilingLive: true, ceiling: 'live', settings: null, kills: {}, ownCampaigns: 2 })).toMatchObject({ ready: false, levers: [] })
    const shadow = ready({ ceilingLive: false, ceiling: 'shadow' })
    expect(shadow.ready).toBe(false)
    expect(shadow.blockers[0]).toContain('NEXUS_BID_BRAIN_MODE is shadow, not live')
    expect(ready({ ownCampaigns: 0 }).blockers.join(' ')).toContain('no campaign of its own')
    const excluded = ready({ settings: settings([...SETTLED, { ...level('bids', 'x'), kind: 'EXCLUDE', key: '*', value: null }]) })
    expect(excluded.ready).toBe(false)
    expect(excluded.blockers[0]).toContain('excluded the product')
  })
})

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const held = (levers: BrainLever[], extra: Partial<CampaignHold> = {}, id = 'c1'): CampaignHold => ({
  campaignId: id, name: `campaign ${id}`, excluded: null,
  levers: Object.fromEntries(BRAIN_LEVERS.map((l) => [l, levers.includes(l) ? { held: true, why: 'AUTO by the Owner' } : { held: false, why: 'OFF by the Owner\'s product override' }])),
  ...extra,
})
const HELD: BrainLever[] = ['bids', 'hours', 'state', 'budgets', 'portfolioCap', 'negatives', 'harvest', 'structure']
const OWN = new Map([['c1', held(HELD)], ['c2', held(HELD, {}, 'c2')]])
const cand = (c: Partial<RetireCandidate> & Pick<RetireCandidate, 'writer'>): RetireCandidate => ({
  id: `${c.writer}-1`, name: `test ${c.writer}`, fingerprint: 'f1', reach: { campaignIds: ['c1'] }, levers: [], scope: 'one campaign', ...c,
})
const plan = (candidates: RetireCandidate[], own = OWN) => planRetirement({ own, candidates })

describe('AB-20 — which rows retire, per writer type', () => {
  it('each writer type retires when it reaches only own campaigns and every lever it writes is held there', () => {
    const p = plan([
      cand({ writer: 'rule', levers: ['budgets'], actions: [{ type: 'adjust_ad_budget', levers: ['budgets'] }] }),
      cand({ writer: 'budgetSchedule', levers: ['budgets'], reach: { campaignIds: ['c1', 'c2'] } }),
      cand({ writer: 'budgetPool', levers: ['budgets'] }),
      cand({ writer: 'dayparting', levers: ['bids', 'hours'] }),
      cand({ writer: 'coverageSet', levers: ['bids'], reach: { campaignIds: ['c1', 'c2'] } }),
      cand({ writer: 'autopilotPlan', levers: ['bids', 'budgets'] }),
    ])
    expect(p.retire.map((r) => r.writer).sort()).toEqual(['autopilotPlan', 'budgetPool', 'budgetSchedule', 'coverageSet', 'dayparting', 'rule'])
    expect(p.keep).toEqual([])
    expect(p.retire.find((r) => r.writer === 'budgetSchedule')?.why).toBe('every campaign it reaches is this product\'s own (2 campaigns) and the brain holds every lever it writes there (budgets): a duplicate writer')
    expect(p.rowless).toBe(ROWLESS_WRITERS)
  })

  it('a row that also reaches another product\'s campaign, the whole business or another market stays — "not owned → unchanged"', () => {
    const p = plan([
      cand({ writer: 'budgetSchedule', id: 's2', levers: ['budgets'], reach: { campaignIds: ['c1', 'c-other'] } }),
      cand({ writer: 'rule', id: 'r-all', levers: ['budgets'], reach: { beyond: 'every campaign of the business' }, actions: [{ type: 'adjust_ad_budget', levers: ['budgets'] }] }),
      cand({ writer: 'rule', id: 'r-markets', levers: ['state'], reach: { beyond: 'the product in every market, not only this one' }, actions: [{ type: 'pause_target', levers: ['state'] }] }),
    ])
    expect(p.retire).toEqual([])
    expect(p.keep.map((k) => k.id).sort()).toEqual(['r-all', 'r-markets', 's2'])
    expect(p.keep.find((k) => k.id === 's2')?.why).toBe('stays: it also reaches 1 campaign that is not this product\'s own (c-other) — switching it off would change it; the run-time skip (AB-6) keeps it off the brain\'s levers')
    expect(p.keep.find((k) => k.id === 'r-all')?.why).toContain('it reaches every campaign of the business')
  })

  it('a row reaching none of the product\'s own campaigns is not its writer: left out', () => {
    expect(plan([cand({ writer: 'budgetPool', levers: ['budgets'], reach: { campaignIds: ['c-other'] } })])).toMatchObject({ retire: [], keep: [] })
  })

  it('a rule\'s bid or placement asks are the bid brain\'s inputs (BB-9): the rule stays; a notify stays too', () => {
    const p = plan([
      cand({ writer: 'rule', id: 'r-bid', levers: [], actions: [{ type: 'bid_down', levers: ['bids'] }, { type: 'adjust_ad_budget', levers: ['budgets'] }] }),
      cand({ writer: 'rule', id: 'r-note', levers: ['state'], actions: [{ type: 'pause_target', levers: ['state'] }, { type: 'notify', levers: [] }] }),
    ])
    expect(p.retire).toEqual([])
    expect(p.keep.find((k) => k.id === 'r-bid')?.why).toContain('its bid_down action is an input the bid brain reads on these campaigns (BB-9')
    expect(p.keep.find((k) => k.id === 'r-note')?.why).toContain('it also does notify, which no lever of the brain does')
  })

  it('a lever not held on one campaign keeps the row, naming the lever, the campaign and why', () => {
    const own = new Map([['c1', held(HELD)], ['c2', held(HELD.filter((l) => l !== 'budgets'), {}, 'c2')]])
    const p = plan([cand({ writer: 'budgetSchedule', levers: ['budgets'], reach: { campaignIds: ['c1', 'c2'] } })], own)
    expect(p.retire).toEqual([])
    expect(p.keep[0].why).toContain('it writes the budgets lever of "campaign c2" (c2), which the brain does not hold there (OFF by the Owner\'s product override)')
  })

  it('an excluded campaign, a window still owed and a row writing no lever stay', () => {
    const own = new Map([['c1', held(HELD, { excluded: 'excluded by the Owner' })], ['c2', held(HELD, {}, 'c2')]])
    expect(plan([cand({ writer: 'budgetPool', levers: ['budgets'] })], own).keep[0].why).toContain('campaign "campaign c1" is out of the brain (excluded by the Owner)')
    const owed = plan([cand({ writer: 'dayparting', levers: ['bids', 'hours'], owes: 'the bids its window raised on 2 keywords' })])
    expect(owed.keep[0].why).toContain('it still holds the bids its window raised on 2 keywords: its own give-back runs when its window ends')
    expect(plan([cand({ writer: 'autopilotPlan', levers: [] })]).keep[0].why).toContain('it writes no lever the brain could hold')
  })

  it('the basis names exactly the rows to switch off and their configuration, whatever the order', () => {
    const a = cand({ writer: 'budgetPool', id: 'b', levers: ['budgets'] })
    const b = cand({ writer: 'dayparting', id: 'a', levers: ['bids', 'hours'] })
    expect(plan([a, b]).basis).toBe(plan([b, a]).basis)
    expect(plan([a, b]).basis).not.toBe(plan([a, { ...b, fingerprint: 'f2' }]).basis)
    expect(retireBasis([])).toBe(retireBasis([]))
  })
})

describe('AB-20 — rule actions', () => {
  it('directives, absorbed actions, ad-group bids and the rest', () => {
    expect(classifyRuleAction({ type: 'bid_apply', levers: ['bids'] })).toBe('directive')
    expect(classifyRuleAction({ type: 'set_placement_multiplier', levers: ['placements'] })).toBe('directive')
    expect(classifyRuleAction({ type: 'bid_down', target: 'ad_group', levers: ['bids'] })).toBe('lever')
    expect(ruleActionLevers({ type: 'bid_down', target: 'ad_group', levers: ['bids'] })).toEqual(['adGroupBids'])
    expect(classifyRuleAction({ type: 'dayparting_apply', levers: ['hours'] })).toBe('absorbed')
    expect(ruleActionLevers({ type: 'dayparting_apply', levers: ['hours'] })).toEqual(['bids'])
    expect(classifyRuleAction({ type: 'add_negative_exact', levers: ['negatives'] })).toBe('lever')
    expect(classifyRuleAction({ type: 'notify', levers: [] })).toBe('other')
  })
})

describe('AB-20 — fingerprints and the give-back', () => {
  it('the fingerprint ignores key order and changes with any configured value', () => {
    expect(stableJson({ b: 1, a: [new Date('2026-10-01T00:00:00Z'), null] })).toBe('{"a":["2026-10-01T00:00:00.000Z",null],"b":1}')
    expect(retireFingerprint({ enabled: false, name: 'x', windows: [1] })).toBe(retireFingerprint({ windows: [1], name: 'x', enabled: false }))
    expect(retireFingerprint({ enabled: false, name: 'x' })).not.toBe(retireFingerprint({ enabled: true, name: 'x' }))
  })

  it('switched on when untouched; nothing when a person switched it on; left when a person changed it; gone when deleted', () => {
    const left = retireFingerprint({ enabled: false, name: 'x' })
    expect(giveBackDecision('2026-10-08T10:00:00Z', left, { enabled: false, fingerprint: left })).toEqual({ act: 'switchOn', why: 'switched on again exactly as it was before it was retired' })
    expect(giveBackDecision('2026-10-08T10:00:00Z', left, { enabled: true, fingerprint: 'other' }).act).toBe('already')
    const changed = giveBackDecision('2026-10-08T10:00:00Z', left, { enabled: false, fingerprint: retireFingerprint({ enabled: false, name: 'y' }) })
    expect(changed).toEqual({ act: 'left', why: 'a person changed it after it was retired (2026-10-08): left as they made it — switch it on yourself if you want it back' })
    expect(giveBackDecision('2026-10-08T10:00:00Z', left, null).act).toBe('gone')
  })
})
