/**
 * NAF.SB.AS.2 — `narrowKinds` must not become another `scopeCampaignIds`.
 *
 * A builder DECLARES which target kinds it can honour, and the Assignments
 * picker reads that declaration. A declaration that lies is exactly the defect
 * this whole series keeps finding: stored, accepted, rendered — binding
 * nothing.
 *
 * Half of it is structural: `observation-builder.ts` throws at import time if
 * a builder declares CAMPAIGN without a `narrow()`. That half needs no test.
 *
 * MARKETPLACE cannot be checked structurally, because it binds inside
 * `build(scope)`. So it is checked BEHAVIOURALLY here: a builder that claims
 * MARKETPLACE must actually produce different evidence when given one, and a
 * builder that does not claim it must be honest about ignoring it.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    adTarget: { findMany: vi.fn(async () => []) },
    amazonAdsSearchTerm: { aggregate: vi.fn(async () => ({ _max: { date: new Date(0) } })) },
    productProfitDaily: { groupBy: vi.fn(async () => []) },
    amazonAdsDailyPerformance: { aggregate: vi.fn(async () => ({ _max: { date: new Date(0) } })) },
    campaign: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('../advertising/ads-harvest.service.js', () => ({
  previewHarvest: vi.fn(async () => ({
    negatives: [], graduations: [], productNegatives: [], productGraduations: [], windowDays: 60,
  })),
}))
vi.mock('../advertising/ads-ngram.service.js', () => ({
  analyzeNgrams: vi.fn(async () => ({ wasteful: [] })),
}))
vi.mock('../advertising/ads-bid-optimizer.service.js', () => ({
  previewBidOptimization: vi.fn(async () => ({ targetAcos: 0.3, proposals: [] })),
}))
vi.mock('../advertising/ads-target-acos.service.js', () => ({
  computeProductTargetAcos: vi.fn(async () => ({ basis: 'fallback' })),
}))

const { negativeCandidatesBuilder } = await import('./observations/negative-candidates.observation.js')
const { harvestCandidatesBuilder } = await import('./observations/harvest-candidates.observation.js')
const { bidProposalsBuilder } = await import('./observations/bid-proposals.observation.js')
const { narrowKindsFor, canNarrowBy } = await import('./observation-builder.js')

const ALL = [negativeCandidatesBuilder, harvestCandidatesBuilder, bidProposalsBuilder]

describe('narrowKinds — the declaration cannot lie', () => {
  it('CAMPAIGN always comes with a narrow() (enforced at import, asserted here)', () => {
    for (const b of ALL) {
      if (b.narrowKinds?.includes('CAMPAIGN')) {
        expect(typeof b.narrow, `${b.key} declares CAMPAIGN`).toBe('function')
      }
    }
  })

  it('a builder that declares MARKETPLACE actually honours it in build()', async () => {
    for (const b of ALL) {
      if (!b.narrowKinds?.includes('MARKETPLACE')) continue
      const wide = await b.build({})
      const scoped = await b.build({ marketplace: 'DE' })
      const w = (wide.payload as { scope: string }).scope
      const s = (scoped.payload as { scope: string }).scope
      expect(w, `${b.key} account-wide scope label`).toBe('account')
      expect(s, `${b.key} must reflect the marketplace it was given`).toContain('DE')
    }
  })

  it('a builder that does NOT declare MARKETPLACE ignores it — so declaring it would be a lie', async () => {
    for (const b of ALL) {
      if (b.narrowKinds?.includes('MARKETPLACE')) continue
      const wide = await b.build({})
      const scoped = await b.build({ marketplace: 'DE' })
      expect(
        (scoped.payload as { scope: string }).scope,
        `${b.key} does not declare MARKETPLACE and must not pretend to honour it`,
      ).toBe((wide.payload as { scope: string }).scope)
    }
  })

  it('the bid tuner is CAMPAIGN-only, on purpose', () => {
    expect(narrowKindsFor('bid-proposals')).toEqual(['CAMPAIGN'])
    expect(canNarrowBy('bid-proposals', 'MARKETPLACE')).toBe(false)
  })

  it('an unnarrowable feed reports no kinds at all', () => {
    for (const key of ['cron-health', 'open-findings', 'pending-plan', 'fleet-health']) {
      expect(narrowKindsFor(key), key).toEqual([])
    }
  })
})

describe('bid-proposals narrow() — the id-dialect join', () => {
  const payload = {
    scope: 'account',
    counts: { proposalsTotal: 3, proposalsTrimmed: 0 },
    caveats: ['original first caveat', 'second'],
    proposals: [{ targetId: 't-in' }, { targetId: 't-out' }, { targetId: 't-orphan' }],
    targetAcosSummary: { byBasis: {} },
  }

  it('keeps only targets whose campaign is named, and counts both drop reasons', async () => {
    const db = (await import('../../db.js')).default as unknown as {
      adTarget: { findMany: ReturnType<typeof vi.fn> }
    }
    db.adTarget.findMany.mockResolvedValueOnce([
      { id: 't-in', adGroup: { campaign: { externalCampaignId: '111' } } },
      { id: 't-out', adGroup: { campaign: { externalCampaignId: '222' } } },
      { id: 't-orphan', adGroup: null },
    ])
    const out = (await bidProposalsBuilder.narrow!(payload, {
      campaignExternalIds: ['111'],
      campaignLabels: ['GALE | IT | Broad'],
    })) as typeof payload

    expect(out.proposals.map((p) => p.targetId)).toEqual(['t-in'])
    expect(out.counts.droppedOutOfScope).toBe(1)
    expect(out.counts.unresolvedCampaign).toBe(1) // orphan proven, never kept
    expect(out.scope).toBe('campaigns:1')
    expect(out.caveats[0]).toContain('GALE | IT | Broad')
  })

  it('an EMPTY scope yields nothing and never queries — fail closed', async () => {
    const db = (await import('../../db.js')).default as unknown as {
      adTarget: { findMany: ReturnType<typeof vi.fn> }
    }
    db.adTarget.findMany.mockClear()
    const out = (await bidProposalsBuilder.narrow!(payload, {
      campaignExternalIds: [],
    })) as typeof payload
    expect(out.proposals).toEqual([])
    expect(db.adTarget.findMany).not.toHaveBeenCalled()
  })

  it('undefined means everything — the only value that widens', async () => {
    const out = (await bidProposalsBuilder.narrow!(payload, {})) as typeof payload
    expect(out.proposals).toHaveLength(3)
  })

  it('keeps targetAcosSummary but relabels it account-wide rather than deleting it', async () => {
    const db = (await import('../../db.js')).default as unknown as {
      adTarget: { findMany: ReturnType<typeof vi.fn> }
    }
    db.adTarget.findMany.mockResolvedValueOnce([
      { id: 't-in', adGroup: { campaign: { externalCampaignId: '111' } } },
    ])
    const out = (await bidProposalsBuilder.narrow!(payload, {
      campaignExternalIds: ['111'],
    })) as typeof payload
    expect(out.targetAcosSummary).toBeTruthy()
    expect(out.caveats.some((c) => c.includes('ACCOUNT-WIDE'))).toBe(true)
  })
})
