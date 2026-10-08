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
  readLeverHolds, readAdGroupLeverHolds, productLeverSkip, leverSkipOf, leverSkipNote, leverSkipReason, addLeverSkipCounts,
  brainSkipsOutput, noLeverHolds,
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
      lever: 'budgets', kind: 'owned', campaignId: 'c1', campaignName: 'GALE c1', productId: 'gale', market: 'IT',
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
    expect(leverSkipOf(c1, 'state', { actor: PRODUCT_BRAIN_ACTOR })?.kind).toBe('locked')
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
    expect(holds.skip('c1', 'budgets')?.kind).toBe('owned')
    expect(holds.skip('c1', 'budgets')).not.toBeNull()
    expect(holds.skip('c1', 'negatives')?.kind).toBe('locked')
    expect(holds.peek('c1', 'budgets')).not.toBeNull() // a look is not counted
    expect(holds.skip('c2', 'budgets')).toBeNull()
    expect(holds.skip('c1', 'state')).toBeNull()
    expect(holds.counts()).toEqual({ budgets: 2, negatives: 1 })
    expect(holds.total()).toBe(3)
    expect(holds.note()).toBe(' brain-levers=budgets:2,negatives:1 (left to a product\'s brain or the Owner\'s lock)')
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
    expect(await productLeverSkip('gale-m', 'IT', 'structure', { actor: 'user:asker' }, 'test')).toMatchObject({ kind: 'owned', productId: 'gale', reason: expect.stringContaining('a product\'s brain runs the structure (new ad groups and product ads) of product gale in IT') })
    brainSettings.mockResolvedValue(settings({ owned: false, effective: 'LOCKED', why: 'locked at the Owner\'s own value' }))
    expect(await productLeverSkip('gale', 'IT', 'structure', { actor: 'user:asker' }, 'test')).toMatchObject({ kind: 'locked' })
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
  it('leverSkipNote, addLeverSkipCounts, brainSkipsOutput', () => {
    expect(leverSkipNote(undefined)).toBe('')
    expect(leverSkipNote({ budgets: 0 })).toBe('')
    expect(leverSkipNote({ placements: 1, adGroupBids: 2 })).toBe(' brain-levers=placements:1,adGroupBids:2 (left to a product\'s brain or the Owner\'s lock)')
    expect(addLeverSkipCounts({ budgets: 1 }, { budgets: 2, state: 1 })).toEqual({ budgets: 3, state: 1 })
    expect(brainSkipsOutput({}, [])).toEqual({})
    const skip = { lever: 'negatives' as const, kind: 'owned' as const, campaignId: 'c1', campaignName: null, productId: 'gale', market: 'IT', reason: leverSkipReason('negatives', OWNED, 'c1') }
    expect(skip.reason).toBe('a product\'s brain runs the negatives of campaign c1 — product gale in IT')
    expect(brainSkipsOutput({ negatives: 1 }, [skip])).toEqual({ brainSkips: { counts: { negatives: 1 }, sample: [{ lever: 'negatives', campaignId: 'c1', why: skip.reason }] } })
    expect(brainSkipsOutput({}, [], true)).toMatchObject({ brainSkips: { counts: {}, unread: expect.stringContaining('could not be read') } })
    expect(noLeverHolds(ENGINE).skip('c1', 'budgets')).toBeNull()
  })
})
