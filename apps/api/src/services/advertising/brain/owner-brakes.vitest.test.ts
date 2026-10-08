/**
 * ONE BRAIN AB-1 review — the campaigns the Owner keeps away from the bid brain (brain/owner-brakes.ts), and the
 * per-campaign tool's refusal on them (bid-brain/enrollment.ts enrollRefusal).
 *
 *   batched   one override query for many campaigns (after the ownership's); none at all when nothing is in this business
 *   shared    a shared campaign is kept off when one product it advertises excludes it
 *   refusal   op live and release are refused with the brake's words; shadow, give-back and hold are not
 *   AB-2      the locks the stop recipe obeys (ownerLeverLocks): the placements lever or one lane, and the bidding strategy —
 *             a campaign's own under any product, a product's on its (shared) campaigns; one query when none is open
 *
 * Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ adsBrainOverride: { findMany: vi.fn() } }))
const owners = vi.hoisted(() => vi.fn())
vi.mock('../../../db.js', () => ({ default: db }))
vi.mock('./ownership.js', () => ({ resolveCampaignOwnership: owners }))

const { ownerBrakes, ownerLeverLocks } = await import('./owner-brakes.js')
const { enrollRefusal } = await import('../bid-brain/enrollment.js')

const owner = (campaignId: string, productIds: string[]) => [campaignId, {
  campaignId, name: campaignId, market: 'IT', adProduct: 'SPONSORED_PRODUCTS', status: 'ENABLED', productIds, unresolved: [], ambiguous: [],
  owner: productIds.length === 1 ? { kind: 'product', productId: productIds[0] } : productIds.length ? { kind: 'shared', productIds } : { kind: 'none' },
}] as const
const row = (o: Record<string, unknown>) => ({ id: `o-${JSON.stringify(o)}`, ref: '', value: null, by: 'user:owner', reason: null, createdAt: new Date('2026-10-08T09:00:00Z'), endedAt: null, campaignId: null, ...o })

describe('ownerBrakes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('one override query for many campaigns; a product exclusion keeps its shared campaign off too', async () => {
    owners.mockResolvedValue(new Map([owner('c-own', ['p-1']), owner('c-shared', ['p-1', 'p-2']), owner('c-free', ['p-2']), owner('c-lock', ['p-2'])]))
    db.adsBrainOverride.findMany.mockResolvedValue([
      row({ productId: 'p-1', marketplace: 'IT', scope: 'PRODUCT', kind: 'EXCLUDE', key: '*', reason: 'not this one' }),
      row({ productId: 'p-2', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-lock', kind: 'LOCK', key: 'bids' }),
    ])
    const brakes = await ownerBrakes(['c-own', 'c-shared', 'c-free', 'c-lock'])
    expect(db.adsBrainOverride.findMany).toHaveBeenCalledTimes(1)
    expect([...brakes.keys()].sort()).toEqual(['c-lock', 'c-own', 'c-shared'])
    expect(brakes.get('c-shared')).toMatch(/excluded from the brain by the Owner's product override \(user:owner, 2026-10-08\): "not this one"/)
    expect(brakes.get('c-lock')).toMatch(/bids are locked at the Owner's own value by the Owner's campaign override/)
  })

  it('asks no override when no campaign is in this business', async () => {
    owners.mockResolvedValue(new Map())
    expect((await ownerBrakes(['c-x'])).size).toBe(0)
    expect(db.adsBrainOverride.findMany).not.toHaveBeenCalled()
  })
})

describe('enrollRefusal with an owner brake', () => {
  const facts = (mode: 'SHADOW' | 'LIVE' | 'HELD' | null) => ({
    campaign: { id: 'c-1', name: 'Italy exact', marketplace: 'IT', market: 'IT', status: 'ENABLED', adProduct: 'SPONSORED_PRODUCTS', allowlisted: true, pinBids: false },
    enrollment: mode ? { mode, heldUntil: null, heldBy: null, snapshot: { takenAt: 't', adGroups: [], targets: [], placements: [] }, updatedAt: 't' } : null,
    ceiling: 'live' as const, blockers: [], floored: null, floorsWithoutMemory: 0,
    ownerBrake: 'it is excluded from the brain by the Owner\'s campaign override (user:owner, 2026-10-08)',
  })

  it('refuses op live and release with the brake\'s words, and lets the way back out run', () => {
    expect(enrollRefusal(facts(null), 'live')).toBe('Italy exact cannot go LIVE: it is excluded from the brain by the Owner\'s campaign override (user:owner, 2026-10-08). The bid brain stays off it until that override is ended.')
    expect(enrollRefusal(facts('HELD'), 'release')).toMatch(/cannot go LIVE: it is excluded/)
    expect(enrollRefusal(facts('LIVE'), 'shadow')).toBeNull()
    expect(enrollRefusal(facts('LIVE'), 'give-back')).toBeNull()
    expect(enrollRefusal(facts('LIVE'), 'hold')).toBeNull()
    expect(enrollRefusal({ ...facts(null), ownerBrake: null }, 'live')).toBeNull()
  })
})

describe('AB-2 — ownerLeverLocks: what the stop recipe may not write', () => {
  beforeEach(() => vi.clearAllMocks())

  it('one query and no ownership when no lock is open', async () => {
    db.adsBrainOverride.findMany.mockResolvedValue([])
    expect((await ownerLeverLocks(['c-1', 'c-2'])).size).toBe(0)
    expect(db.adsBrainOverride.findMany).toHaveBeenCalledTimes(1)
    expect(db.adsBrainOverride.findMany.mock.calls[0][0]).toMatchObject({ where: { endedAt: null, kind: 'LOCK', key: { in: ['placements', 'biddingStrategy'] } } })
    expect(owners).not.toHaveBeenCalled()
    expect((await ownerLeverLocks([])).size).toBe(0)
  })

  it('a campaign\'s own locks — the placements lever, one lane, the strategy — in words, with no ownership read', async () => {
    db.adsBrainOverride.findMany.mockResolvedValue([
      row({ productId: 'p-1', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-1', kind: 'LOCK', key: 'placements', reason: 'my own lanes' }),
      row({ productId: 'p-1', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-4', kind: 'LOCK', key: 'placements', value: { TOP_OF_SEARCH: 40 } }),
      row({ productId: 'p-1', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-2', kind: 'LOCK', key: 'placements', ref: 'lane:TOP_OF_SEARCH' }),
      row({ productId: 'p-1', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-2', kind: 'LOCK', key: 'biddingStrategy', value: 'AUTO_FOR_SALES' }),
      // A stored lock that no longer validates (no such lane) is ignored.
      row({ productId: 'p-1', marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-3', kind: 'LOCK', key: 'placements', ref: 'lane:SIDEBAR' }),
    ])
    const locks = await ownerLeverLocks(['c-1', 'c-2', 'c-3', 'c-4'])
    // His own value goes with the lock: what the lever goes back to after a stop.
    expect(locks.get('c-4')?.placements?.value).toEqual({ TOP_OF_SEARCH: 40 })
    expect(owners).not.toHaveBeenCalled()
    expect(locks.get('c-1')).toEqual({ placements: { words: 'locked by the Owner\'s campaign override (user:owner, 2026-10-08) ("my own lanes")', value: null }, lanes: new Map(), biddingStrategy: null })
    expect(locks.get('c-2')).toEqual({ placements: null, lanes: new Map([['TOP_OF_SEARCH', 'locked by the Owner\'s campaign override (user:owner, 2026-10-08)']]), biddingStrategy: { words: 'locked by the Owner\'s campaign override (user:owner, 2026-10-08)', value: 'AUTO_FOR_SALES' } })
    expect(locks.has('c-3')).toBe(false)
  })

  it('a product\'s lock holds its own and its shared campaigns, not another product\'s', async () => {
    owners.mockResolvedValue(new Map([owner('c-own', ['p-1']), owner('c-shared', ['p-1', 'p-2']), owner('c-other', ['p-2'])]))
    db.adsBrainOverride.findMany.mockResolvedValue([row({ productId: 'p-1', marketplace: 'IT', scope: 'PRODUCT', kind: 'LOCK', key: 'biddingStrategy' })])
    const locks = await ownerLeverLocks(['c-own', 'c-shared', 'c-other'])
    expect(owners).toHaveBeenCalledWith(['c-own', 'c-shared', 'c-other'])
    expect(locks.get('c-own')?.biddingStrategy).toEqual({ words: 'locked by the Owner\'s product override (user:owner, 2026-10-08)', value: null })
    expect(locks.get('c-shared')?.biddingStrategy?.words).toMatch(/^locked by the Owner's product override/)
    expect(locks.has('c-other')).toBe(false)
  })
})
