/**
 * ONE BRAIN AB-5 — who holds each lever of a campaign for the write gate (brain/lever-owners.ts).
 *   pure      leverHoldsOf: owned at PROPOSE or AUTO of an enrolled product's own campaign; nothing at OBSERVE, OFF or by
 *             default; nothing when not enrolled, in another market, excluded or with no owner; the Owner's whole-lever
 *             lock (campaign or product) holds it; a lock of one thing inside a lever does not; a shared campaign is owned
 *             by nobody but one enrolled product's lock holds it and one product's exclusion keeps it out; the keyword bids
 *             are never here (BidBrainEnrollment, BB-6)
 *   reads     nothing enrolled: one query, remembered per business; a fixed number of queries for any number of
 *             campaigns; each campaign's answer remembered (an empty one too); forgetLeverOwners; a failed read throws
 *   portfolio the brain that owns the cap lever of every campaign in it, or any campaign's lock
 * The levels a lever takes today are widened here (each lever's own PR widens LEVER_LEVELS_NOW): the gate must already
 * hold every lever correctly when it does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OverrideRow } from './settings.js'
import type { CampaignOwnership } from './ownership.js'

const enrollmentFindFirst = vi.fn()
const enrollmentFindMany = vi.fn()
const overrideFindMany = vi.fn()
const portfolioFindFirst = vi.fn()
const campaignFindMany = vi.fn()
vi.mock('../../../db.js', () => ({
  default: {
    adsBrainEnrollment: { get findFirst() { return enrollmentFindFirst }, get findMany() { return enrollmentFindMany } },
    adsBrainOverride: { get findMany() { return overrideFindMany } },
    amazonAdsPortfolio: { get findFirst() { return portfolioFindFirst } },
    campaign: { get findMany() { return campaignFindMany } },
  },
}))
const resolveCampaignOwnership = vi.fn()
vi.mock('./ownership.js', () => ({ resolveCampaignOwnership: (...a: unknown[]) => resolveCampaignOwnership(...a) }))
vi.mock('./levers.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./levers.js')>()), levelRefusal: () => null }))

const { leverHoldsOf, campaignLeverOwners, portfolioCapHold, forgetLeverOwners, GATE_LEVERS } = await import('./lever-owners.js')
const { withWorkspace } = await import('../../../lib/workspace-context.js')

const AT = new Date('2026-10-08T12:00:00Z')
let n = 0
const o = (row: Partial<OverrideRow> & Pick<OverrideRow, 'kind' | 'key'>): OverrideRow => ({
  id: `o${++n}`, productId: 'gale', marketplace: 'IT', scope: 'PRODUCT', campaignId: null, ref: '', value: null, by: 'user:owner', reason: null, createdAt: AT, endedAt: null, ...row,
})
const level = (key: string, value: string, extra: Partial<OverrideRow> = {}) => o({ kind: 'LEVEL', key, value, ...extra })
const lock = (key: string, extra: Partial<OverrideRow> = {}) => o({ kind: 'LOCK', key, ...extra })
const CAMPAIGN = { scope: 'CAMPAIGN', campaignId: 'c1' } as const
const own = (productId = 'gale'): Pick<CampaignOwnership, 'campaignId' | 'market' | 'owner'> => ({ campaignId: 'c1', market: 'IT', owner: { kind: 'product', productId } })
const shared = (...productIds: string[]): Pick<CampaignOwnership, 'campaignId' | 'market' | 'owner'> => ({ campaignId: 'c1', market: 'IT', owner: { kind: 'shared', productIds } })
const enrolled = (...pairs: string[]) => new Set(pairs.map((p) => { const [productId, market] = p.split('@'); return `${productId}\u0000${market}` }))
const GALE_IT = enrolled('gale@IT')

describe('leverHoldsOf (pure)', () => {
  it('a lever at AUTO or PROPOSE of an enrolled product\'s own campaign is owned, with where it comes from', () => {
    const h = leverHoldsOf(own(), GALE_IT, [level('budgets', 'AUTO'), level('negatives', 'PROPOSE', { ...CAMPAIGN, by: 'user:anna' })])
    expect(h).toEqual({
      budgets: { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override (user:owner, 2026-10-08)' },
      negatives: { kind: 'owned', productId: 'gale', market: 'IT', why: 'PROPOSE by the Owner\'s campaign override (user:anna, 2026-10-08)' },
    })
  })

  it('shadow, off and the default own nothing', () => {
    expect(leverHoldsOf(own(), GALE_IT, [level('budgets', 'OBSERVE'), level('state', 'OFF')])).toEqual({})
    expect(leverHoldsOf(own(), GALE_IT, [])).toEqual({})
  })

  it('a campaign\'s own level wins over the product\'s', () => {
    expect(leverHoldsOf(own(), GALE_IT, [level('budgets', 'AUTO'), level('budgets', 'OBSERVE', CAMPAIGN)])).toEqual({})
    expect(leverHoldsOf(own(), GALE_IT, [level('budgets', 'OBSERVE'), level('budgets', 'AUTO', CAMPAIGN)]).budgets?.kind).toBe('owned')
  })

  it('nothing when the product is not enrolled, or only in another market, or the campaign has no owner', () => {
    const rows = [level('budgets', 'AUTO'), lock('state')]
    expect(leverHoldsOf(own(), new Set(), rows)).toEqual({})
    expect(leverHoldsOf(own(), enrolled('gale@DE'), rows)).toEqual({})
    expect(leverHoldsOf({ campaignId: 'c1', market: 'IT', owner: { kind: 'none' } }, GALE_IT, rows)).toEqual({})
    expect(leverHoldsOf({ campaignId: 'c1', market: null, owner: { kind: 'product', productId: 'gale' } }, GALE_IT, rows)).toEqual({})
  })

  it('an exclusion (of the campaign or of the product) wins over every level and every lock', () => {
    const rows = [level('budgets', 'AUTO'), lock('state')]
    expect(leverHoldsOf(own(), GALE_IT, [...rows, o({ kind: 'EXCLUDE', key: '*', ...CAMPAIGN })])).toEqual({})
    expect(leverHoldsOf(own(), GALE_IT, [...rows, o({ kind: 'EXCLUDE', key: '*' })])).toEqual({})
  })

  it('the Owner\'s lock of a whole lever holds it, whatever its level, with his words', () => {
    const h = leverHoldsOf(own(), GALE_IT, [level('budgets', 'AUTO'), lock('budgets', { ...CAMPAIGN, value: { dailyBudgetCents: 2_000 }, reason: 'my own budget' }), lock('state')])
    expect(h.budgets).toEqual({ kind: 'locked', productId: 'gale', market: 'IT', why: 'locked by the Owner\'s campaign override (user:owner, 2026-10-08) ("my own budget")' })
    expect(h.state).toEqual({ kind: 'locked', productId: 'gale', market: 'IT', why: 'locked by the Owner\'s product override (user:owner, 2026-10-08)' })
  })

  it('a lock of one thing inside a lever is not the gate\'s (the brain\'s own modules obey it)', () => {
    const h = leverHoldsOf(own(), GALE_IT, [level('state', 'AUTO'), lock('state', { ref: 'adGroup:g1' }), lock('negatives', { ref: 'term:cheap jacket' })])
    expect(h).toEqual({ state: { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override (user:owner, 2026-10-08)' } })
  })

  it('an ended choice counts for nothing', () => {
    expect(leverHoldsOf(own(), GALE_IT, [level('budgets', 'AUTO', { endedAt: AT }), lock('state', { endedAt: AT })])).toEqual({})
  })

  it('a shared campaign is owned by no brain; one enrolled product\'s lock holds it; one product\'s exclusion keeps it out', () => {
    const both = enrolled('gale@IT', 'misano@IT')
    expect(leverHoldsOf(shared('gale', 'misano'), both, [level('negatives', 'AUTO')])).toEqual({})
    expect(leverHoldsOf(shared('gale', 'misano'), both, [lock('negatives', { productId: 'misano' })]).negatives?.kind).toBe('locked')
    expect(leverHoldsOf(shared('gale', 'misano'), GALE_IT, [lock('negatives', { productId: 'misano' })])).toEqual({})
    expect(leverHoldsOf(shared('gale', 'misano'), both, [lock('negatives'), o({ kind: 'EXCLUDE', key: '*', productId: 'misano' })])).toEqual({})
  })

  it('the keyword bids are never held here: they stay the bid brain\'s BidBrainEnrollment', () => {
    expect(GATE_LEVERS).not.toContain('bids')
    expect(leverHoldsOf(own(), GALE_IT, [level('bids', 'AUTO'), lock('bids', CAMPAIGN)])).toEqual({})
  })
})

describe('campaignLeverOwners and portfolioCapHold (reads)', () => {
  const ownership = (id: string, owner: CampaignOwnership['owner'], market = 'IT'): [string, CampaignOwnership] =>
    [id, { campaignId: id, name: `campaign ${id}`, market, adProduct: 'SPONSORED_PRODUCTS', status: 'ENABLED', productIds: owner.kind === 'product' ? [owner.productId] : owner.kind === 'shared' ? owner.productIds : [], unresolved: [], ambiguous: [], owner }]

  beforeEach(() => {
    forgetLeverOwners()
    for (const f of [enrollmentFindFirst, enrollmentFindMany, overrideFindMany, portfolioFindFirst, campaignFindMany, resolveCampaignOwnership]) f.mockReset()
    enrollmentFindFirst.mockResolvedValue({ id: 'e1' })
    enrollmentFindMany.mockResolvedValue([{ productId: 'gale', marketplace: 'IT' }])
    overrideFindMany.mockResolvedValue([level('budgets', 'AUTO'), lock('state', { scope: 'CAMPAIGN', campaignId: 'c2' })])
    resolveCampaignOwnership.mockImplementation(async (ids: string[]) => new Map([
      ownership('c1', { kind: 'product', productId: 'gale' }), ownership('c2', { kind: 'product', productId: 'gale' }), ownership('c3', { kind: 'none' }),
    ].filter(([id]) => ids.includes(id))))
  })

  it('nothing enrolled in the business: one query, remembered, and no other read', async () => {
    enrollmentFindFirst.mockResolvedValue(null)
    expect(await campaignLeverOwners(['c1', 'c2'])).toEqual(new Map())
    expect(await campaignLeverOwners(['c1'])).toEqual(new Map())
    expect(await portfolioCapHold('pf-1')).toBeNull()
    expect(enrollmentFindFirst).toHaveBeenCalledTimes(1)
    for (const f of [resolveCampaignOwnership, enrollmentFindMany, overrideFindMany, portfolioFindFirst, campaignFindMany]) expect(f).not.toHaveBeenCalled()
  })

  it('a fixed number of queries for any number of campaigns, and only the campaigns someone holds a lever of', async () => {
    const got = await campaignLeverOwners(['c1', 'c2', 'c3', 'c1', ''])
    expect([...got.keys()].sort()).toEqual(['c1', 'c2'])
    expect(got.get('c1')).toMatchObject({ name: 'campaign c1', market: 'IT', levers: { budgets: { kind: 'owned' } } })
    expect(got.get('c2')?.levers).toMatchObject({ budgets: { kind: 'owned' }, state: { kind: 'locked' } })
    expect(resolveCampaignOwnership).toHaveBeenCalledTimes(1)
    expect(resolveCampaignOwnership).toHaveBeenCalledWith(['c1', 'c2', 'c3'])
    expect(enrollmentFindMany).toHaveBeenCalledTimes(1)
    expect(enrollmentFindMany).toHaveBeenCalledWith({ where: { productId: { in: ['gale'] } }, select: { productId: true, marketplace: true } })
    expect(overrideFindMany).toHaveBeenCalledTimes(1)
    expect(overrideFindMany.mock.calls[0][0].where).toEqual({
      endedAt: null, kind: { in: ['LEVEL', 'LOCK', 'EXCLUDE'] },
      OR: [{ scope: 'PRODUCT', productId: { in: ['gale'] } }, { scope: 'CAMPAIGN', campaignId: { in: ['c1', 'c2', 'c3'] } }],
    })
  })

  it('each answer is remembered (an empty one too) until forgotten', async () => {
    await campaignLeverOwners(['c1', 'c3'])
    const again = await campaignLeverOwners(['c3', 'c1'])
    expect([...again.keys()]).toEqual(['c1'])
    expect(resolveCampaignOwnership).toHaveBeenCalledTimes(1)
    // A campaign not asked before is the only one read.
    await campaignLeverOwners(['c1', 'c2'])
    expect(resolveCampaignOwnership).toHaveBeenLastCalledWith(['c2'])
    forgetLeverOwners()
    await campaignLeverOwners(['c1'])
    expect(resolveCampaignOwnership).toHaveBeenCalledTimes(3)
    expect(enrollmentFindFirst).toHaveBeenCalledTimes(2)
  })

  it('the memory is per business', async () => {
    const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
    enrollmentFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'e1' })
    expect((await withWorkspace(scope('ws-a'), () => campaignLeverOwners(['c1']))).size).toBe(0)
    expect((await withWorkspace(scope('ws-b'), () => campaignLeverOwners(['c1']))).size).toBe(1)
    expect((await withWorkspace(scope('ws-a'), () => campaignLeverOwners(['c1']))).size).toBe(0)
    expect(enrollmentFindFirst).toHaveBeenCalledTimes(2)
  })

  it('a failed read throws (the gate fails closed), and nothing is remembered from it', async () => {
    overrideFindMany.mockRejectedValueOnce(new Error('db down'))
    await expect(campaignLeverOwners(['c1'])).rejects.toThrow('db down')
    expect((await campaignLeverOwners(['c1'])).get('c1')?.levers.budgets?.kind).toBe('owned')
    forgetLeverOwners()
    enrollmentFindFirst.mockRejectedValueOnce(new Error('db down'))
    await expect(campaignLeverOwners(['c1'])).rejects.toThrow('db down')
  })

  it('a portfolio\'s cap: owned when one product\'s brain owns it on every campaign in it; any campaign\'s lock holds it', async () => {
    portfolioFindFirst.mockResolvedValue({ externalPortfolioId: 'AMZ-PF-1' })
    campaignFindMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }])
    overrideFindMany.mockResolvedValue([level('portfolioCap', 'AUTO')])
    expect(await portfolioCapHold('pf-row-1')).toMatchObject({ kind: 'owned', productId: 'gale' })
    expect(portfolioFindFirst).toHaveBeenCalledWith({ where: { OR: [{ id: 'pf-row-1' }, { externalPortfolioId: 'pf-row-1' }] }, select: { externalPortfolioId: true } })
    expect(campaignFindMany).toHaveBeenCalledWith({ where: { portfolioId: 'AMZ-PF-1', status: { not: 'ARCHIVED' } }, select: { id: true } })

    forgetLeverOwners()
    campaignFindMany.mockResolvedValue([{ id: 'c1' }, { id: 'c3' }]) // c3 advertises no product: the brain does not own the whole portfolio
    expect(await portfolioCapHold('pf-row-1')).toBeNull()

    forgetLeverOwners()
    campaignFindMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }])
    overrideFindMany.mockResolvedValue([lock('portfolioCap', { value: { amountCents: 50_000 } })])
    expect(await portfolioCapHold('AMZ-PF-1')).toMatchObject({ kind: 'locked', productId: 'gale' })

    forgetLeverOwners()
    portfolioFindFirst.mockResolvedValue(null)
    campaignFindMany.mockResolvedValue([])
    expect(await portfolioCapHold('AMZ-PF-9')).toBeNull()
    expect(campaignFindMany).toHaveBeenLastCalledWith({ where: { portfolioId: 'AMZ-PF-9', status: { not: 'ARCHIVED' } }, select: { id: true } })
  })
})
