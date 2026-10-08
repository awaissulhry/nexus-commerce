/**
 * ONE BRAIN AB-5 — one owner per lever at the write gate (design 2026-10-08-ads-one-brain/DESIGN.md §3 target 2-5). Every
 * write names its lever; on a lever a product's brain owns (brain/lever-owners.ts, mocked here: the real resolver has its
 * own tests and a real-PostgreSQL suite) the gate passes the brain's actor, a person, a forced lowering and the safety
 * owners, and refuses every other automatic writer naming the lever and the product's brain. On a lever the Owner locked,
 * the brain is refused too (placements and the bidding strategy excepted: the brain's own writers obey those locks). A
 * lever nobody holds, the keyword bids (BidBrainEnrollment, BB-6), a shadow ceiling and a write that names no actor are
 * judged exactly as before. When the holders cannot be read, an automatic write's gate fails with the read's error (the
 * ads worker then sends the row again later — never a refusal it would settle SKIPPED); a person's write passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BrainLever } from './brain/levers.js'
import type { CampaignLeverOwners, LeverHold } from './brain/lever-owners.js'

const campaignFindUnique = vi.fn()
const enrollmentFindMany = vi.fn()
vi.mock('../../db.js', () => ({
  default: {
    campaign: { get findUnique() { return campaignFindUnique }, findMany: vi.fn(async () => []) },
    bidBrainEnrollment: { get findMany() { return enrollmentFindMany } },
    adKeywordProtection: { findMany: vi.fn(async () => []) },
    adSpendCeiling: { findMany: vi.fn(async () => []) },
    adBidPolicy: { findMany: vi.fn(async () => []) },
    advertisingActionLog: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    adProductAd: { findMany: vi.fn(async () => []) },
    adWriteRefusal: { create: vi.fn(async () => ({})) },
    adsStrategy: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  },
}))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'live' }))
vi.mock('./ads-profile-resolver.js', () => ({ adsProfileFor: vi.fn(async () => ({ profileId: 'p1', mode: 'production', writesEnabledAt: new Date() })) }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./ads-automation-state.service.js', () => ({ getAutomationState: vi.fn(async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false })) }))
const campaignLeverOwners = vi.fn()
const portfolioCapHold = vi.fn()
vi.mock('./brain/lever-owners.js', () => ({ campaignLeverOwners, portfolioCapHold }))

const {
  checkAdsWriteGate, leverWriterOf, brainLeversOfWrite, leverHoldRefusal, PRODUCT_BRAIN_ACTOR, BRAIN_SAFETY_ACTOR_PREFIXES, BRAIN_STRATEGY_REPAIR_PREFIXES,
} = await import('./ads-write-gate.js')
const { leverDimensionsForWrite, dimensionsForWrite } = await import('./ads-authority-pins.js')

const ROW = {
  liveBidWritesEnabled: true, dynamicBidding: null, liveBidWritesToday: 0, liveBidWritesDay: null,
  minBidCents: null, maxBidCents: null, pinPlacement: false, pinBids: false, pinBudget: false, pinNote: null,
  dailyBudget: 5, portfolioId: null, marketplace: 'IT', minBudgetCents: null, maxBudgetCents: null,
  adProduct: 'SPONSORED_PRODUCTS', type: 'SP', name: 'GALE exact', costType: null, budgetJson: null,
}

const owned = (why = 'AUTO by the Owner\'s product override (user:owner, 2026-10-08)'): LeverHold => ({ kind: 'owned', productId: 'gale', market: 'IT', why })
const locked = (why = 'locked by the Owner\'s campaign override (user:owner, 2026-10-08) ("my own value")'): LeverHold => ({ kind: 'locked', productId: 'gale', market: 'IT', why })
/** The campaign c1 with these levers held (none: nobody holds any). */
function holds(levers: Partial<Record<BrainLever, LeverHold>>) {
  const map = new Map<string, CampaignLeverOwners>()
  if (Object.keys(levers).length) map.set('c1', { campaignId: 'c1', name: 'GALE exact', market: 'IT', levers })
  campaignLeverOwners.mockResolvedValue(map)
}

/**
 * One write per lever, as its write path hands it to the gate: the worker and the mutation layer (fields), the create
 * service (a named lever with the first bid), the negative service (a named lever with the term), the placement write.
 */
const WRITES: Record<Exclude<BrainLever, 'bids' | 'hours' | 'offAmazon'>, Record<string, unknown>> = {
  adGroupBids: { field: 'defaultBid', fields: ['defaultBid'], intendedValueCents: 40, payloadValueCents: 40 },
  placements: { dimension: 'placement', payloadValueCents: 0 },
  biddingStrategy: { field: 'biddingStrategy', fields: ['biddingStrategy'], payloadValueCents: 0 },
  state: { field: 'status', fields: ['status'], payloadValueCents: 0 },
  budgets: { field: 'dailyBudget', fields: ['dailyBudget'], intendedValueCents: 600, previousValueCents: 500, payloadValueCents: 600 },
  portfolioCap: { field: 'portfolioId', fields: ['portfolioId'], payloadValueCents: 0 },
  negatives: { dimension: 'negatives', isNegation: true, keywordText: 'cheap jacket', negativeMatchType: 'NEGATIVE_EXACT', payloadValueCents: 0 },
  harvest: { dimension: 'keywords', field: 'bid', intendedValueCents: 40, payloadValueCents: 40 },
  structure: { dimension: 'structure', field: 'defaultBid', intendedValueCents: 40, payloadValueCents: 40 },
}
const LEVERS = Object.keys(WRITES) as Array<keyof typeof WRITES>
const write = (lever: keyof typeof WRITES, actor: string | null | undefined, extra: Record<string, unknown> = {}) =>
  checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c1', ...WRITES[lever], ...(actor !== undefined ? { actor } : {}), ...extra } as never)

/** The writer classes, with how each one is marked. */
const BRAIN = PRODUCT_BRAIN_ACTOR
const PERSON = ['user:owner', { manual: true }] as const
const OTHER = ['automation:rule-abc', 'automation:budget-schedule-s1', 'automation:rank-defend-s1', 'automation:autopilot-x', 'automation:auto-bid', 'user:owner' /* no person mark: an engine */]
const EXTERNAL = ['external:bidding-engine', null]

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  campaignFindUnique.mockReset().mockResolvedValue(ROW)
  // The bid brain owns no campaign here: BB-6 says nothing, AB-5 alone decides.
  enrollmentFindMany.mockReset().mockResolvedValue([])
  campaignLeverOwners.mockReset()
  portfolioCapHold.mockReset().mockResolvedValue(null)
  holds({})
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-5 — a lever a product\'s brain owns: one owner per lever', () => {
  for (const lever of LEVERS) {
    describe(lever, () => {
      beforeEach(() => { holds({ [lever]: owned() }) })

      it('refuses another automatic writer and an external one, naming the lever, the product\'s brain and the way back', async () => {
        for (const actor of [...OTHER, ...EXTERNAL]) {
          const r = await write(lever, actor)
          expect(r, String(actor)).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
          const reason = (r as { reason: string }).reason
          expect(reason, String(actor)).toMatch(/is run by the brain of product gale in IT \(one owner per lever\)/)
          expect(reason, String(actor)).toContain(`${actor ?? 'an unnamed automatic writer'} may not change its`)
          expect(reason, String(actor)).toMatch(/the Owner can set the lever to shadow or off, exclude the campaign, or lock his own value/)
        }
        expect(campaignLeverOwners).toHaveBeenCalledWith(['c1'])
      })

      it('lets the brain, a person and a request a person approved through', async () => {
        expect(await write(lever, BRAIN)).toMatchObject({ allowed: true, mode: 'live' })
        expect(await write(lever, `${BRAIN}-cycle`)).toMatchObject({ allowed: true })
        expect(await write(lever, PERSON[0], PERSON[1])).toMatchObject({ allowed: true })
      })

      if (lever === 'biddingStrategy') {
        it('lets only the repairs through among the automatic writers — never a safety owner or a "lowering" (AB-2\'s rule)', async () => {
          for (const actor of BRAIN_STRATEGY_REPAIR_PREFIXES) expect(await write(lever, actor), actor).toMatchObject({ allowed: true })
          for (const actor of ['automation:retail-guard', 'automation:budget-manager', 'automation:auto-undo']) expect(await write(lever, actor), actor).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
          expect(await write(lever, 'automation:retail-guard', { isSuppression: true })).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
        })
      } else {
        it('lets every safety owner and a forced lowering through, and reads nothing for them', async () => {
          for (const actor of BRAIN_SAFETY_ACTOR_PREFIXES) expect(await write(lever, actor), actor).toMatchObject({ allowed: true })
          expect(await write(lever, 'automation:retail-guard-cron')).toMatchObject({ allowed: true })
          expect(await write(lever, 'automation:rule-abc', { isSuppression: true })).toMatchObject({ allowed: true })
          expect(campaignLeverOwners).not.toHaveBeenCalled()
        })
      }
    })
  }

  it('the bid brain is the brain on the levers it writes (ad group bids, placements, strategy), another engine on the rest', async () => {
    holds(Object.fromEntries(LEVERS.map((l) => [l, owned()])))
    for (const lever of ['adGroupBids', 'placements', 'biddingStrategy'] as const) expect(await write(lever, 'automation:bid-brain'), lever).toMatchObject({ allowed: true })
    for (const lever of ['state', 'budgets', 'portfolioCap', 'negatives', 'harvest', 'structure'] as const) {
      expect(await write(lever, 'automation:bid-brain'), lever).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    }
    // A look-alike of the brain's actor is another engine.
    expect(await write('budgets', 'automation:ads-brainy')).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
  })

  it('a write of several levers is refused on the first one held', async () => {
    holds({ budgets: owned() })
    const r = await checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c1', payloadValueCents: 600, field: 'dailyBudget', fields: ['status', 'dailyBudget'], intendedValueCents: 600, previousValueCents: 500, actor: 'automation:rule-abc' })
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect((r as { reason: string }).reason).toMatch(/may not change its daily budget/)
  })
})

describe('AB-5 — a lever nobody holds is judged exactly as before', () => {
  it('every writer class passes every lever (no enrollment, OBSERVE, OFF, excluded, shared: the resolver holds nothing)', async () => {
    for (const lever of LEVERS) {
      for (const actor of [BRAIN, 'automation:bid-brain', ...OTHER, ...EXTERNAL, ...BRAIN_SAFETY_ACTOR_PREFIXES]) {
        expect(await write(lever, actor), `${lever} ${actor}`).toMatchObject({ allowed: true })
      }
      expect(await write(lever, PERSON[0], PERSON[1])).toMatchObject({ allowed: true })
    }
  })

  it('another lever held changes nothing for this one', async () => {
    holds({ negatives: owned(), budgets: locked() })
    expect(await write('state', 'automation:rule-abc')).toMatchObject({ allowed: true })
    expect(await write('harvest', 'automation:rule-abc')).toMatchObject({ allowed: true })
  })

  it('a shadow ceiling and a write that names no actor read nothing and refuse nothing', async () => {
    holds(Object.fromEntries(LEVERS.map((l) => [l, owned()])))
    for (const lever of LEVERS) expect(await write(lever, undefined), lever).toMatchObject({ allowed: true })
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    for (const lever of LEVERS) expect(await write(lever, 'automation:rule-abc'), lever).toMatchObject({ allowed: true })
    expect(campaignLeverOwners).not.toHaveBeenCalled()
  })

  it('the keyword bids stay the bid brain\'s BidBrainEnrollment (BB-6): never judged by a product\'s settings', async () => {
    holds({ bids: owned() } as Partial<Record<BrainLever, LeverHold>>)
    const bid = (actor: string) => checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 40, campaignId: 'c1', field: 'bid', fields: ['bid'], intendedValueCents: 40, actor })
    expect(await bid('automation:auto-bid')).toMatchObject({ allowed: true })
    expect(campaignLeverOwners).not.toHaveBeenCalled()
    // …and a campaign the bid brain owns refuses as before, in BB-6's words.
    enrollmentFindMany.mockResolvedValue([{ campaignId: 'c1' }])
    const r = await bid('automation:auto-bid')
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect((r as { reason: string }).reason).toMatch(/run by the bid brain \(one writer per campaign\)/)
  })

  it('a create on a campaign the bid brain owns is judged by its own lever, not as a bids change', async () => {
    enrollmentFindMany.mockResolvedValue([{ campaignId: 'c1' }])
    expect(await write('harvest', 'automation:rule-abc')).toMatchObject({ allowed: true })
    expect(await write('structure', 'automation:rule-abc')).toMatchObject({ allowed: true })
    expect(enrollmentFindMany).not.toHaveBeenCalled()
    holds({ harvest: owned() })
    const r = await write('harvest', 'automation:rule-abc')
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect((r as { reason: string }).reason).toMatch(/may not change its new keywords and targets/)
  })

  it('a negative\'s retire is the negatives lever, not a state change', async () => {
    const retire = (actor: string) => checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c1', payloadValueCents: 0, field: 'status', fields: ['status'], dimension: 'negatives', actor })
    holds({ state: owned() })
    expect(await retire('automation:rule-abc')).toMatchObject({ allowed: true })
    holds({ negatives: owned() })
    expect(await retire('automation:rule-abc')).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
  })
})

describe('AB-5 — the Owner\'s lock: his value stands', () => {
  for (const lever of LEVERS) {
    it(`${lever}: every automatic writer is refused${lever === 'placements' || lever === 'biddingStrategy' ? ' but the brain (its own writers obey this lock)' : ', the brain included'}; a person passes`, async () => {
      holds({ [lever]: locked() })
      for (const actor of [...OTHER, ...EXTERNAL]) {
        const r = await write(lever, actor)
        expect(r, String(actor)).toMatchObject({ allowed: false, deniedAt: 'owner_locked' })
        expect((r as { reason: string }).reason).toMatch(/^the Owner holds the .* at his own value \(locked by the Owner's campaign override/)
        expect((r as { reason: string }).reason).toMatch(/ending the lock lets automation write it again/)
      }
      const brain = await write(lever, BRAIN)
      if (lever === 'placements' || lever === 'biddingStrategy') expect(brain).toMatchObject({ allowed: true })
      else {
        expect(brain).toMatchObject({ allowed: false, deniedAt: 'owner_locked' })
        expect((brain as { reason: string }).reason).toMatch(/may not change it — the brain included/)
      }
      expect(await write(lever, PERSON[0], PERSON[1])).toMatchObject({ allowed: true })
      if (lever !== 'biddingStrategy') expect(await write(lever, 'automation:auto-undo')).toMatchObject({ allowed: true })
    })
  }

  it('the bid brain passes a lock of placements and of the strategy (its stop recipe), not of the ad group bids', async () => {
    holds({ placements: locked(), biddingStrategy: locked(), adGroupBids: locked() })
    expect(await write('placements', 'automation:bid-brain')).toMatchObject({ allowed: true })
    expect(await write('biddingStrategy', 'automation:bid-brain')).toMatchObject({ allowed: true })
    expect(await write('adGroupBids', 'automation:bid-brain')).toMatchObject({ allowed: false, deniedAt: 'owner_locked' })
  })
})

describe('AB-5 — fail closed as "try again": an unreadable holder is never a refusal', () => {
  beforeEach(() => { campaignLeverOwners.mockRejectedValue(new Error('db down')) })

  it('an automatic write\'s gate fails with the read\'s own error (the ads worker then retries the row), the brain\'s own included', async () => {
    for (const lever of LEVERS) {
      for (const actor of ['automation:rule-abc', null, ...(lever === 'placements' || lever === 'biddingStrategy' ? [] : [BRAIN])]) {
        await expect(write(lever, actor), `${lever} ${actor}`).rejects.toThrow('db down')
      }
    }
  })

  it('a person\'s write, a safety owner and a forced lowering pass without a read', async () => {
    for (const lever of LEVERS) {
      expect(await write(lever, PERSON[0], PERSON[1]), lever).toMatchObject({ allowed: true })
      if (lever !== 'biddingStrategy') {
        expect(await write(lever, 'automation:budget-manager-cron'), lever).toMatchObject({ allowed: true })
        expect(await write(lever, 'automation:rule-abc', { isSuppression: true }), lever).toMatchObject({ allowed: true })
      }
    }
    expect(campaignLeverOwners).not.toHaveBeenCalled()
  })
})

describe('AB-5 — a portfolio\'s own write (its cap)', () => {
  const cap = (actor: string | null | undefined, extra: Record<string, unknown> = {}) =>
    checkAdsWriteGate({ marketplace: 'IT', payloadValueCents: 30_000, portfolioId: 'pf-1', field: 'budgetAmount', fields: ['budgetAmount'], dimension: 'portfolio', ...(actor !== undefined ? { actor } : {}), ...extra })

  it('owned: another writer refused, the brain and a person pass', async () => {
    portfolioCapHold.mockResolvedValue(owned())
    const r = await cap('automation:rule-abc')
    expect(r).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
    expect((r as { reason: string }).reason).toMatch(/^portfolio pf-1 is run by the brain of product gale in IT/)
    expect(await cap(BRAIN)).toMatchObject({ allowed: true })
    expect(await cap('user:owner', { manual: true })).toMatchObject({ allowed: true })
    expect(portfolioCapHold).toHaveBeenCalledWith('pf-1')
  })

  it('locked: the brain refused too; nobody holds it, no actor, shadow: as before', async () => {
    portfolioCapHold.mockResolvedValue(locked())
    expect(await cap(BRAIN)).toMatchObject({ allowed: false, deniedAt: 'owner_locked' })
    expect(await cap(undefined)).toMatchObject({ allowed: true })
    portfolioCapHold.mockResolvedValue(null)
    expect(await cap('automation:rule-abc')).toMatchObject({ allowed: true })
    portfolioCapHold.mockRejectedValue(new Error('db down'))
    await expect(cap('automation:rule-abc')).rejects.toThrow('db down')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    expect(await cap('automation:rule-abc')).toMatchObject({ allowed: true })
  })
})

describe('AB-5 — the vocabulary (pure)', () => {
  it('every write names its lever: fields, and a named create or negative', () => {
    expect(leverDimensionsForWrite({ fields: ['bid'] })).toEqual(['bids'])
    expect(leverDimensionsForWrite({ fields: ['biddingStrategy'] })).toEqual(['biddingStrategy'])
    expect(leverDimensionsForWrite({ fields: ['status', 'name'] })).toEqual(['state'])
    expect(leverDimensionsForWrite({ fields: ['portfolioId'] })).toEqual(['portfolio'])
    expect(leverDimensionsForWrite({ fields: ['budgetAmount', 'budgetPolicy'] })).toEqual(['portfolio'])
    expect(leverDimensionsForWrite({ fields: ['dailyBudget', 'status'] }).sort()).toEqual(['budget', 'state'])
    expect(leverDimensionsForWrite({ fields: [], dimension: 'placement' })).toEqual(['placement'])
    // A create or a negative is its own lever only: a first bid, a retire's status are part of it.
    expect(leverDimensionsForWrite({ fields: ['bid'], dimension: 'keywords' })).toEqual(['keywords'])
    expect(leverDimensionsForWrite({ fields: ['defaultBid'], dimension: 'structure' })).toEqual(['structure'])
    expect(leverDimensionsForWrite({ fields: ['status'], dimension: 'negatives' })).toEqual(['negatives'])
    expect(leverDimensionsForWrite({ fields: ['name', 'endDate', 'constructor', null] })).toEqual([])
  })

  it('the pins keep their own vocabulary: the strategy is still the bids pin\'s, and a named create adds no pin', () => {
    expect(dimensionsForWrite({ fields: ['biddingStrategy'] })).toEqual(['bids'])
    expect(dimensionsForWrite({ fields: ['status', 'portfolioId'] })).toEqual([])
    expect(dimensionsForWrite({ fields: ['bid'], dimension: 'keywords' })).toEqual(['bids'])
    expect(dimensionsForWrite({ fields: [], dimension: 'negatives' })).toEqual([])
  })

  it('dimensions → the brain\'s levers', () => {
    expect(brainLeversOfWrite(['bids'], ['bid'])).toEqual(['bids'])
    expect(brainLeversOfWrite(['bids'], ['defaultBid'])).toEqual(['adGroupBids'])
    expect(brainLeversOfWrite(['bids'], ['bid', 'defaultBid']).sort()).toEqual(['adGroupBids', 'bids'])
    expect(brainLeversOfWrite(['placement', 'budget', 'state', 'negatives', 'keywords', 'structure', 'portfolio', 'biddingStrategy'], []))
      .toEqual(['placements', 'budgets', 'state', 'negatives', 'harvest', 'structure', 'portfolioCap', 'biddingStrategy'])
  })

  it('leverWriterOf: a person never from the free-text actor; safety and lowering per lever; the brain per lever', () => {
    expect(leverWriterOf('budgets', { actor: 'user:owner' })).toBe('other')
    expect(leverWriterOf('budgets', { actor: 'user:owner', manual: true })).toBe('passes')
    expect(leverWriterOf('budgets', { actor: 'automation:auto-undo' })).toBe('passes')
    expect(leverWriterOf('budgets', { actor: 'automation:auto-undoer' })).toBe('other')
    expect(leverWriterOf('state', { actor: 'automation:rule-abc', isSuppression: true })).toBe('passes')
    expect(leverWriterOf('biddingStrategy', { actor: 'automation:rule-abc', isSuppression: true })).toBe('other')
    expect(leverWriterOf('biddingStrategy', { actor: 'automation:reconcile-sweep' })).toBe('passes')
    expect(leverWriterOf('negatives', { actor: PRODUCT_BRAIN_ACTOR })).toBe('brain')
    expect(leverWriterOf('negatives', { actor: 'automation:bid-brain' })).toBe('other')
    expect(leverWriterOf('adGroupBids', { actor: 'automation:bid-brain' })).toBe('brain')
    expect(leverWriterOf('placements', { actor: 'automation:bid-brain' })).toBe('passes')
    expect(leverWriterOf('placements', { actor: PRODUCT_BRAIN_ACTOR })).toBe('passes')
    expect(leverWriterOf('state', { actor: null })).toBe('other')
  })

  it('leverHoldRefusal: the brain passes its owned lever, nobody automatic passes a lock', () => {
    expect(leverHoldRefusal('budgets', owned(), 'brain', 'campaign c1', BRAIN)).toBeNull()
    expect(leverHoldRefusal('budgets', owned(), 'passes', 'campaign c1', 'user:owner')).toBeNull()
    expect(leverHoldRefusal('budgets', locked(), 'brain', 'campaign c1', BRAIN)).toMatchObject({ deniedAt: 'owner_locked' })
    expect(leverHoldRefusal('budgets', owned(), 'other', 'campaign c1', null)?.reason).toMatch(/an unnamed automatic writer may not change its daily budget/)
  })
})
