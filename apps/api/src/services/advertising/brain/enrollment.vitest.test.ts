/**
 * ONE BRAIN AB-1 — the bids lever's plan over a product's own campaigns (brain/enrollment.ts, the pure part; the
 * database part runs in enrollment-postgres.vitest.test.ts).
 *
 *   adopt     the lever is AUTO when the bid brain already runs one own campaign (LIVE or HELD), else OBSERVE
 *   AUTO      a campaign that resolves to AUTO and is in shadow goes LIVE, or stays with its reason; LIVE and HELD stay
 *   not AUTO  (OBSERVE, excluded, locked) LIVE and HELD go back to shadow with the reason; one that cannot refuses the
 *             whole change; shadow ones stay — an excluded or locked campaign never goes LIVE
 *   checks    only the campaigns that would move are checked; only bids level, a whole bids lock and an exclusion move them
 *   snapshot  what the lever kept when it put campaigns LIVE: put LIVE now, LIVE already, skipped with the reason
 *   basis     the approval basis changes when a campaign's step does (a skip that became a live step), not otherwise
 *   big door  any live step makes a plan a big door; a shared campaign only leaves when excluded or bids-locked
 *
 * Values are made up (public repo).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: {} }))

const { adoptedBidsLevel, bidsSnapshotOf, bidsWant, goesLive, needsCheck, planBasis, planBids, planMoves, sharedLeaves, touchesBids } = await import('./enrollment.js')
const { resolveBrainSettings } = await import('./settings.js')

const c = (campaignId: string, mode: 'SHADOW' | 'LIVE' | 'HELD' | null, want: 'AUTO' | 'NOT', extra: Record<string, string | null> = {}) => ({ campaignId, name: `Campaign ${campaignId}`, status: 'ENABLED', mode, want, ...extra })

describe('adoptedBidsLevel', () => {
  it('AUTO as soon as one own campaign is LIVE or HELD; OBSERVE otherwise (and for none)', () => {
    expect(adoptedBidsLevel([c('a', null, 'NOT'), c('b', 'LIVE', 'NOT')])).toBe('AUTO')
    expect(adoptedBidsLevel([c('a', 'HELD', 'NOT')])).toBe('AUTO')
    expect(adoptedBidsLevel([c('a', 'SHADOW', 'NOT'), c('b', null, 'NOT')])).toBe('OBSERVE')
    expect(adoptedBidsLevel([])).toBe('OBSERVE')
  })
})

describe('needsCheck', () => {
  it('asks only for the campaigns that would move', () => {
    expect([null, 'SHADOW', 'LIVE', 'HELD'].map((m) => needsCheck('AUTO', m as never))).toEqual(['live', 'live', null, null])
    expect([null, 'SHADOW', 'LIVE', 'HELD'].map((m) => needsCheck('NOT', m as never))).toEqual([null, null, 'shadow', 'shadow'])
  })
})

describe('planBids', () => {
  it('wanting AUTO: shadow campaigns go LIVE unless refused; LIVE and HELD stay', () => {
    const plan = planBids([
      c('live', 'LIVE', 'AUTO'), c('held', 'HELD', 'AUTO'), c('new', null, 'AUTO'), c('shadow', 'SHADOW', 'AUTO'),
      c('off', null, 'AUTO', { liveRefusal: 'Campaign off is not on the live-write allowlist' }),
    ])
    expect(plan).toEqual({ steps: [
      { campaignId: 'live', name: 'Campaign live', op: 'keep', mode: 'LIVE' },
      { campaignId: 'held', name: 'Campaign held', op: 'keep', mode: 'HELD' },
      { campaignId: 'new', name: 'Campaign new', op: 'live' },
      { campaignId: 'shadow', name: 'Campaign shadow', op: 'live' },
      { campaignId: 'off', name: 'Campaign off', op: 'skip', why: 'Campaign off is not on the live-write allowlist' },
    ] })
    expect(planMoves((plan as { steps: never[] }).steps)).toBe(true)
  })

  it('wanting AUTO over campaigns already LIVE moves nothing', () => {
    const plan = planBids([c('a', 'LIVE', 'AUTO'), c('b', 'HELD', 'AUTO')])
    expect('steps' in plan && planMoves(plan.steps)).toBe(false)
  })

  it('not wanting it: LIVE and HELD go back to shadow with the reason; shadow ones stay and never go LIVE', () => {
    expect(planBids([
      c('live', 'LIVE', 'NOT', { wantWhy: 'OBSERVE by the Owner\'s product override' }),
      c('held', 'HELD', 'NOT', { wantWhy: 'excluded by the Owner\'s campaign override' }),
      c('none', null, 'NOT'),
    ])).toEqual({ steps: [
      { campaignId: 'live', name: 'Campaign live', op: 'shadow', why: 'OBSERVE by the Owner\'s product override' },
      { campaignId: 'held', name: 'Campaign held', op: 'shadow', why: 'excluded by the Owner\'s campaign override' },
      { campaignId: 'none', name: 'Campaign none', op: 'keep', mode: null },
    ] })
  })

  it('one campaign that cannot leave the brain refuses the whole change', () => {
    const plan = planBids([c('ok', 'LIVE', 'NOT'), c('stuck', 'LIVE', 'NOT', { shadowRefusal: 'Campaign stuck cannot go back to shadow now: 2 keywords sit at a floor.' })])
    expect(plan).toEqual({ refusal: 'the bid brain cannot leave these campaigns now: Campaign stuck cannot go back to shadow now: 2 keywords sit at a floor.' })
  })
})

describe('bidsWant and touchesBids', () => {
  const settings = (overrides: Parameters<typeof resolveBrainSettings>[0]['overrides']) =>
    resolveBrainSettings({ productId: 'p-1', market: 'IT', campaignId: 'c-1', enrolled: true, overrides }).levers.bids
  const o = (kind: string, key: string, value: unknown = null, scope = 'CAMPAIGN') =>
    ({ id: `${kind}-${key}`, productId: 'p-1', marketplace: 'IT', scope, campaignId: scope === 'CAMPAIGN' ? 'c-1' : null, kind, key, ref: '', value, by: 'user:owner', reason: null, createdAt: new Date('2026-10-08T10:00:00Z'), endedAt: null })

  it('a campaign wants the bid brain only when its bids resolve to AUTO: excluded or locked never', () => {
    expect(bidsWant(settings([o('LEVEL', 'bids', 'AUTO', 'PRODUCT')])).want).toBe('AUTO')
    expect(bidsWant(settings([]))).toEqual({ want: 'NOT', why: 'OBSERVE by the brain\'s default' })
    expect(bidsWant(settings([o('LEVEL', 'bids', 'AUTO', 'PRODUCT'), o('EXCLUDE', '*')])).want).toBe('NOT')
    expect(bidsWant(settings([o('LEVEL', 'bids', 'AUTO', 'PRODUCT'), o('LOCK', 'bids')])).want).toBe('NOT')
  })

  it('only the bids level, a whole bids lock and an exclusion move campaigns', () => {
    expect(touchesBids({ kind: 'LEVEL', key: 'bids' })).toBe(true)
    expect(touchesBids({ kind: 'LOCK', key: 'bids', ref: '' })).toBe(true)
    expect(touchesBids({ kind: 'EXCLUDE', key: '*' })).toBe(true)
    expect(touchesBids({ kind: 'LOCK', key: 'bids', ref: 'target:t-1' })).toBe(false)
    expect(touchesBids({ kind: 'LEVEL', key: 'budgets' })).toBe(false)
    expect(touchesBids({ kind: 'VALUE', key: 'paceTargetPct' })).toBe(false)
  })
})

describe('bidsSnapshotOf', () => {
  it('names the campaigns put LIVE, those LIVE already, and the skipped with their reason', () => {
    expect(bidsSnapshotOf([
      { campaignId: 'a', name: 'A', op: 'live' },
      { campaignId: 'b', name: 'B', op: 'keep', mode: 'HELD' },
      { campaignId: 'c', name: 'C', op: 'keep', mode: null },
      { campaignId: 'd', name: 'D', op: 'skip', why: 'not allowlisted' },
    ])).toEqual({ enrolled: ['a'], alreadyLive: ['b'], skipped: [{ campaignId: 'd', why: 'not allowlisted' }] })
  })
})

describe('planBasis, goesLive and sharedLeaves (AB-1 review)', () => {
  const set = { scope: 'PRODUCT', campaignId: null, kind: 'LEVEL' as const, key: 'bids', ref: '', value: 'AUTO' }
  const skip = { campaignId: 'a', name: 'A', op: 'skip' as const, why: 'not on the live-write allowlist' }
  const live = { campaignId: 'a', name: 'A', op: 'live' as const }

  it('the basis is stable for the same plan and moves when a campaign\'s step does', () => {
    const one = planBasis({ set, ends: null, steps: [skip] })
    expect(planBasis({ set, ends: null, steps: [{ ...skip, why: 'another reason' }] })).toBe(one)
    expect(planBasis({ set, ends: null, steps: [live] })).not.toBe(one)
    expect(planBasis({ set: null, ends: 'o-1', steps: [skip] })).not.toBe(one)
    expect(planBasis({ set, ends: null })).not.toBe(one)
  })

  it('any live step is a big door, whatever kind of change makes it', () => {
    expect(goesLive([skip, live, { campaignId: 'b', name: 'B', op: 'shadow', why: 'x' }])).toEqual(['a'])
    expect(goesLive(undefined)).toEqual([])
  })

  it('a shared campaign leaves only when the Owner keeps the bid brain off it', () => {
    const o = (kind: string, key: string, value: unknown = null, scope = 'CAMPAIGN') =>
      ({ id: `${kind}-${key}-${scope}`, productId: 'p-1', marketplace: 'IT', scope, campaignId: scope === 'CAMPAIGN' ? 'c-1' : null, kind, key, ref: '', value, by: 'user:owner', reason: null, createdAt: new Date('2026-10-08T10:00:00Z'), endedAt: null })
    const bids = (overrides: ReturnType<typeof o>[]) => resolveBrainSettings({ productId: 'p-1', market: 'IT', campaignId: 'c-1', enrolled: true, overrides }).levers.bids
    expect(sharedLeaves(bids([o('EXCLUDE', '*')]))).toBe(true)
    expect(sharedLeaves(bids([o('EXCLUDE', '*', null, 'PRODUCT')]))).toBe(true)
    expect(sharedLeaves(bids([o('LOCK', 'bids')]))).toBe(true)
    expect(sharedLeaves(bids([o('LEVEL', 'bids', 'OBSERVE', 'PRODUCT')]))).toBe(false)
    expect(sharedLeaves(bids([]))).toBe(false)
  })
})
