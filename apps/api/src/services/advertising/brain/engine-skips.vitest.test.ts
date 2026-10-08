/**
 * ONE BRAIN AB-6 — an engine leaves a lever a product's brain owns, or the Owner holds, before it asks (brain/engine-skips.ts).
 *   same answer  exactly the gate's: a held lever is a skip for another automatic writer (with why, counted), never for a
 *                person, a forced lowering or a safety owner; the brain passes a lever it owns, not one the Owner locked
 *   inert        not under a live ceiling: nothing read, nothing skipped; nothing enrolled: nothing skipped, note empty
 *   unread       a failed read skips nothing (the write gate decides), says so once, and the note says so
 *   batched      one read for every campaign of a run; an ad-group-keyed run one query for the campaigns and one read
 *   product      a product's own lever (a build): owned or locked, a person passes, nothing enrolled reads nothing more
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CampaignLeverOwners, LeverHold } from './lever-owners.js'

const campaignLeverOwners = vi.fn()
const anyBrainEnrolled = vi.fn()
vi.mock('./lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => anyBrainEnrolled(...a),
}))
const adGroupFindMany = vi.fn()
vi.mock('../../../db.js', () => ({ default: { adGroup: { get findMany() { return adGroupFindMany } } } }))
const brainSettings = vi.fn()
vi.mock('./enrollment.js', () => ({ brainSettings: (...a: unknown[]) => brainSettings(...a) }))
const warn = vi.fn()
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

const {
  readLeverHolds, readAdGroupLeverHolds, productLeverSkip, leverSkipOf, leverHeldNote, leverSkipReason, addLeverHeld,
  brainSkipsOutput, noLeverHolds, bidBrainSkip, leverHeldOf, leverHeldTotal,
} = await import('./engine-skips.js')
const { PRODUCT_BRAIN_ACTOR } = await import('../ads-write-gate.js')

const OWNED: LeverHold = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override (user:owner, 2026-10-08)' }
const LOCKED: LeverHold = { kind: 'locked', productId: 'gale', market: 'IT', why: 'locked by the Owner\'s campaign override (user:owner, 2026-10-08)' }
const owners = (campaignId: string, levers: CampaignLeverOwners['levers']): CampaignLeverOwners => ({ campaignId, name: `GALE ${campaignId}`, market: 'IT', levers })
const ENGINE = { actor: 'automation:budget-schedule' }

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  campaignLeverOwners.mockReset()
  anyBrainEnrolled.mockReset().mockResolvedValue(true)
  adGroupFindMany.mockReset()
  brainSettings.mockReset()
  warn.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('leverSkipOf — the gate\'s own answer (pure)', () => {
  const c1 = owners('c1', { budgets: OWNED, state: LOCKED })
  it('another automatic writer leaves an owned lever and a locked one, with why', () => {
    expect(leverSkipOf(c1, 'budgets', ENGINE)).toEqual({
      lever: 'budgets', holder: 'productBrain', campaignId: 'c1', campaignName: 'GALE c1', productId: 'gale', market: 'IT',
      reason: 'a product\'s brain runs the daily budget of campaign "GALE c1" (c1) — product gale in IT',
    })
    expect(leverSkipOf(c1, 'state', ENGINE)?.reason).toBe('the Owner holds the state (pause, enable, archive) of campaign "GALE c1" (c1) at his own value — product gale in IT')
  })
  it('a lever nobody holds, or a campaign with no holder, is no skip', () => {
    expect(leverSkipOf(c1, 'negatives', ENGINE)).toBeNull()
    expect(leverSkipOf(undefined, 'budgets', ENGINE)).toBeNull()
  })
  it('a person, a forced lowering and a safety owner pass every held lever, as at the gate', () => {
    expect(leverSkipOf(c1, 'budgets', { actor: 'user:owner', manual: true })).toBeNull()
    expect(leverSkipOf(c1, 'state', { actor: 'automation:rule-x', isSuppression: true })).toBeNull()
    expect(leverSkipOf(c1, 'budgets', { actor: 'automation:budget-manager-cron' })).toBeNull()
    // A person's actor without the manual mark is not a person to the gate (never read from the free text): it skips.
    expect(leverSkipOf(c1, 'budgets', { actor: 'user:owner' })).not.toBeNull()
  })
  it('the brain passes a lever it owns, not one the Owner locked', () => {
    expect(leverSkipOf(c1, 'budgets', { actor: PRODUCT_BRAIN_ACTOR })).toBeNull()
    expect(leverSkipOf(c1, 'state', { actor: PRODUCT_BRAIN_ACTOR })?.holder).toBe('ownerLock')
  })
})

describe('readLeverHolds', () => {
  it('not under a live ceiling: nothing is read and nothing skipped (the gate judges nothing either)', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    const holds = await readLeverHolds(['c1'], ENGINE, 'test')
    expect(campaignLeverOwners).not.toHaveBeenCalled()
    expect(holds.skip('c1', 'budgets')).toBeNull()
    expect(holds.note()).toBe('')
  })

  it('nothing enrolled (production today): one read, no skip, nothing said', async () => {
    campaignLeverOwners.mockResolvedValue(new Map())
    const holds = await readLeverHolds(['c1', 'c2', 'c1', null, undefined], ENGINE, 'test')
    expect(campaignLeverOwners).toHaveBeenCalledTimes(1)
    expect(campaignLeverOwners).toHaveBeenCalledWith(['c1', 'c2'])
    for (const lever of ['budgets', 'state', 'negatives', 'harvest', 'placements', 'adGroupBids', 'structure'] as const) expect(holds.skip('c1', lever)).toBeNull()
    expect(holds.total()).toBe(0)
    expect(holds.counts()).toEqual({})
    expect(holds.note()).toBe('')
  })

  it('owned and locked levers are skips, counted per lever once per write left', async () => {
    campaignLeverOwners.mockResolvedValue(new Map([['c1', owners('c1', { budgets: OWNED, negatives: LOCKED })]]))
    const holds = await readLeverHolds(['c1', 'c2'], ENGINE, 'test')
    expect(holds.skip('c1', 'budgets')?.holder).toBe('productBrain')
    expect(holds.skip('c1', 'budgets')).not.toBeNull()
    expect(holds.skip('c1', 'negatives')?.holder).toBe('ownerLock')
    expect(holds.peek('c1', 'budgets')).not.toBeNull() // a look is not counted
    expect(holds.skip('c2', 'budgets')).toBeNull()
    expect(holds.skip('c1', 'state')).toBeNull()
    expect(holds.counts()).toEqual({ productBrain: { budgets: 2 }, ownerLock: { negatives: 1 } })
    expect(holds.total()).toBe(3)
    expect(holds.note()).toBe(' brain-levers=a product\'s brain: budgets 2; the Owner\'s lock: negatives 1 (one owner per lever)')
  })

  it('a bid brain campaign\'s keyword bids are counted as the bid brain\'s, in its own words; a build\'s refusal under its holder', async () => {
    campaignLeverOwners.mockResolvedValue(new Map())
    const holds = await readLeverHolds(['c1'], ENGINE, 'test')
    expect(holds.skipBidBrain('c1', 'GALE c1')).toMatchObject({ holder: 'bidBrain', lever: 'bids', reason: 'the bid brain runs the keyword bids of campaign "GALE c1" (c1)' })
    holds.count('ownerLock', 'structure')
    expect(holds.counts()).toEqual({ bidBrain: { bids: 1 }, ownerLock: { structure: 1 } })
    expect(holds.note()).toBe(' brain-levers=the Owner\'s lock: structure 1; the bid brain: bids 1 (one owner per lever)')
  })

  it('a failed read skips nothing on a guess, says so once, and the note says the holders were unread', async () => {
    campaignLeverOwners.mockRejectedValue(new Error('db blip'))
    const holds = await readLeverHolds(['c1'], ENGINE, 'budget-schedules')
    expect(holds.unread).toBe(true)
    expect(holds.skip('c1', 'budgets')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('nothing is skipped on a guess')
    expect(holds.note()).toBe(' brain-levers=unread (nothing skipped on a guess; the write gate judges each write)')
  })

  it('no campaign: no read', async () => {
    const holds = await readLeverHolds([], ENGINE, 'test')
    expect(campaignLeverOwners).not.toHaveBeenCalled()
    expect(holds.skip('c1', 'budgets')).toBeNull()
  })
})

describe('readAdGroupLeverHolds — one query for the campaigns, one read for the holders', () => {
  it('maps Nexus\'s and Amazon\'s ad group ids to their campaigns', async () => {
    adGroupFindMany.mockResolvedValue([{ id: 'g1', externalAdGroupId: 'EXT-g1', campaignId: 'c1' }, { id: 'g2', externalAdGroupId: null, campaignId: 'c2' }])
    campaignLeverOwners.mockResolvedValue(new Map([['c1', owners('c1', { negatives: OWNED })]]))
    const { holds, campaignOf } = await readAdGroupLeverHolds({ local: ['g2'], external: ['EXT-g1', 'EXT-g1'] }, ENGINE, 'test')
    expect(adGroupFindMany).toHaveBeenCalledTimes(1)
    expect(campaignLeverOwners).toHaveBeenCalledTimes(1)
    expect(campaignOf.get('EXT-g1')).toBe('c1')
    expect(campaignOf.get('g1')).toBe('c1')
    expect(campaignOf.get('g2')).toBe('c2')
    expect(holds.skip(campaignOf.get('EXT-g1'), 'negatives')).not.toBeNull()
    expect(holds.skip(campaignOf.get('g2'), 'negatives')).toBeNull()
  })
  it('nothing enrolled: no ad group query at all', async () => {
    anyBrainEnrolled.mockResolvedValue(false)
    const { holds } = await readAdGroupLeverHolds({ external: ['EXT-g1'] }, ENGINE, 'test')
    expect(adGroupFindMany).not.toHaveBeenCalled()
    expect(campaignLeverOwners).not.toHaveBeenCalled()
    expect(holds.skip('c1', 'negatives')).toBeNull()
  })
  it('a failed ad group read skips nothing and says unread', async () => {
    adGroupFindMany.mockRejectedValue(new Error('db blip'))
    const { holds } = await readAdGroupLeverHolds({ local: ['g1'] }, ENGINE, 'test')
    expect(holds.unread).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('productLeverSkip — a product\'s own lever (a build of new campaigns)', () => {
  const settings = (structure: Record<string, unknown>) => ({ productId: 'gale', market: 'IT', levers: { structure } })
  it('owned at PROPOSE or AUTO, or locked by the Owner: a skip with why', async () => {
    brainSettings.mockResolvedValue(settings({ owned: true, effective: 'AUTO', why: 'AUTO by the Owner\'s product override' }))
    expect(await productLeverSkip('gale-m', 'IT', 'structure', { actor: 'user:asker' }, 'test')).toMatchObject({ holder: 'productBrain', productId: 'gale', reason: expect.stringContaining('a product\'s brain runs the structure (new ad groups and product ads) of product gale in IT') })
    brainSettings.mockResolvedValue(settings({ owned: false, effective: 'LOCKED', why: 'locked at the Owner\'s own value' }))
    expect(await productLeverSkip('gale', 'IT', 'structure', { actor: 'user:asker' }, 'test')).toMatchObject({ holder: 'ownerLock' })
  })
  it('shadow, off, not enrolled: no skip', async () => {
    brainSettings.mockResolvedValue(settings({ owned: false, effective: 'OBSERVE', why: 'OBSERVE by default' }))
    expect(await productLeverSkip('gale', 'IT', 'structure', { actor: 'user:asker' }, 'test')).toBeNull()
  })
  it('a person\'s approval passes without a read; the brain passes its own lever', async () => {
    expect(await productLeverSkip('gale', 'IT', 'structure', { actor: 'user:asker', manual: true }, 'test')).toBeNull()
    expect(brainSettings).not.toHaveBeenCalled()
    brainSettings.mockResolvedValue(settings({ owned: true, effective: 'AUTO', why: 'AUTO' }))
    expect(await productLeverSkip('gale', 'IT', 'structure', { actor: PRODUCT_BRAIN_ACTOR }, 'test')).toBeNull()
  })
  it('nothing enrolled or not live: nothing more read; a failed read is no skip', async () => {
    anyBrainEnrolled.mockResolvedValue(false)
    expect(await productLeverSkip('gale', 'IT', 'structure', { actor: 'user:asker' }, 'test')).toBeNull()
    expect(brainSettings).not.toHaveBeenCalled()
    anyBrainEnrolled.mockResolvedValue(true)
    brainSettings.mockRejectedValue(new Error('db blip'))
    expect(await productLeverSkip('gale', 'IT', 'structure', { actor: 'user:asker' }, 'test')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', '')
    brainSettings.mockReset()
    expect(await productLeverSkip('gale', 'IT', 'structure', { actor: 'user:asker' }, 'test')).toBeNull()
    expect(brainSettings).not.toHaveBeenCalled()
  })
})

describe('the words (pure)', () => {
  it('leverHeldNote names each holder as what it is; addLeverHeld, leverHeldOf, leverHeldTotal, brainSkipsOutput', () => {
    expect(leverHeldNote(undefined)).toBe('')
    expect(leverHeldNote({ productBrain: { budgets: 0 } })).toBe('')
    expect(leverHeldNote({ ownerLock: { placements: 1 }, bidBrain: { bids: 2 }, productBrain: { adGroupBids: 2, state: 1 } }))
      .toBe(' brain-levers=a product\'s brain: adGroupBids 2, state 1; the Owner\'s lock: placements 1; the bid brain: bids 2 (one owner per lever)')
    // Never one holder's words for another's skip.
    expect(leverHeldNote({ bidBrain: { bids: 1 } })).toBe(' brain-levers=the bid brain: bids 1 (one owner per lever)')
    expect(leverHeldNote({ bidBrain: { bids: 1 } })).not.toMatch(/product's brain|Owner's lock/)
    expect(addLeverHeld({ productBrain: { budgets: 1 } }, { productBrain: { budgets: 2, state: 1 }, bidBrain: { bids: 1 } })).toEqual({ productBrain: { budgets: 3, state: 1 }, bidBrain: { bids: 1 } })
    expect(brainSkipsOutput({}, [])).toEqual({})
    const skip = { lever: 'negatives' as const, holder: 'productBrain' as const, campaignId: 'c1', campaignName: null, productId: 'gale', market: 'IT', reason: leverSkipReason('negatives', OWNED, 'c1') }
    expect(skip.reason).toBe('a product\'s brain runs the negatives of campaign c1 — product gale in IT')
    const bid = bidBrainSkip('c2', 'GALE exact')
    expect(bid).toEqual({ lever: 'bids', holder: 'bidBrain', campaignId: 'c2', campaignName: 'GALE exact', productId: null, market: null, reason: 'the bid brain runs the keyword bids of campaign "GALE exact" (c2)' })
    expect(leverHeldOf([skip, bid, skip])).toEqual({ productBrain: { negatives: 2 }, bidBrain: { bids: 1 } })
    expect(leverHeldTotal({ productBrain: { negatives: 2 }, bidBrain: { bids: 1 } })).toBe(3)
    expect(brainSkipsOutput({ productBrain: { negatives: 1 } }, [skip])).toEqual({ brainSkips: { counts: { productBrain: { negatives: 1 } }, sample: [{ lever: 'negatives', holder: 'productBrain', campaignId: 'c1', why: skip.reason }] } })
    expect(brainSkipsOutput({}, [], true)).toMatchObject({ brainSkips: { counts: {}, unread: expect.stringContaining('could not be read') } })
    expect(noLeverHolds(ENGINE).skip('c1', 'budgets')).toBeNull()
  })
})
