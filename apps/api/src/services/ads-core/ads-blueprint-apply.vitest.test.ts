/**
 * AX2.5 — replication planning + the self-competition gate.
 * The gate is the reason this phase exists; most of these tests are about it.
 */
import { describe, it, expect } from 'vitest'
import { extractBlueprint, type SourceCampaign } from './ads-blueprint.js'
import { planApplication, materialise, type ExistingTarget } from './ads-blueprint-apply.js'

const kw = (expressionValue: string, expressionType = 'EXACT', isNegative = false, bidCents: number | null = 30) => ({
  kind: 'KEYWORD', expressionType, expressionValue, bidCents, isNegative, negativeLevel: isNegative ? 'AD_GROUP' : null,
})

const source = (): SourceCampaign[] => [
  {
    name: 'IT-AIREON-SP-Brand-Exact', dailyBudget: 10, biddingStrategy: 'LEGACY_FOR_SALES', placementBidding: [],
    adGroups: [{ name: 'IT-AIREON-SP-Brand-Exact Ad Group', defaultBidCents: 30, asins: ['B0AIREON1'], targets: [kw('aireon'), kw('giacca aireon')] }],
  },
  {
    name: 'IT-AIREON-SP-Category-Exact', dailyBudget: 15, biddingStrategy: 'LEGACY_FOR_SALES', placementBidding: [],
    adGroups: [{ name: 'IT-AIREON-SP-Category-Exact Ad Group', defaultBidCents: 30, asins: ['B0AIREON1'],
      targets: [kw('giacca moto'), kw('abbigliamento moto'), kw('casco moto', 'EXACT', true)] }],
  },
]
const doc = extractBlueprint(source(), { productToken: 'AIREON' })
const gale = { productToken: 'GALE', asins: ['B0GALE0001', 'B0GALE0002'] }

describe('materialise', () => {
  it('substitutes the target product into a pattern', () => {
    expect(materialise('IT-{{product}}-SP-Brand-Exact', 'GALE')).toBe('IT-GALE-SP-Brand-Exact')
    expect(materialise('giacca {{product}}', 'GALE')).toBe('giacca GALE')
  })
  it('leaves a pattern without the token alone', () => {
    expect(materialise('giacca moto', 'GALE')).toBe('giacca moto')
  })
})

describe('planApplication — the plan', () => {
  it('materialises names and brand keywords for the new product', () => {
    const p = planApplication(doc, gale, [])
    expect(p.campaigns.map((c) => c.name)).toEqual(['IT-GALE-SP-Brand-Exact', 'IT-GALE-SP-Category-Exact'])
    const brand = p.campaigns[0]!.adGroups[0]!.targets.map((t) => t.expression)
    expect(brand).toEqual(['GALE', 'giacca GALE'])
    expect(JSON.stringify(p)).not.toContain('AIREON')
  })

  it('attaches the TARGET product ASINs, never the source ones', () => {
    const p = planApplication(doc, gale, [])
    expect(p.campaigns[0]!.adGroups[0]!.asins).toEqual(['B0GALE0001', 'B0GALE0002'])
    expect(JSON.stringify(p)).not.toContain('B0AIREON1')
  })

  it('totals the daily budget the replication commits', () => {
    const p = planApplication(doc, gale, [])
    expect(p.totals.dailyBudgetTotal).toBe(25)
    expect(p.totals.campaigns).toBe(2)
    expect(p.totals.productAds).toBe(4) // 2 ad groups × 2 ASINs
  })

  it('is allowed when nothing collides', () => {
    const p = planApplication(doc, gale, [])
    expect(p.allowed).toBe(true)
    expect(p.conflicts).toEqual([])
  })
})

describe('planApplication — the self-competition gate', () => {
  const existing: ExistingTarget[] = [
    { expression: 'giacca moto', campaignName: 'IT-AIREON-SP-Category-Exact', campaignId: 'c_aireon' },
  ]

  it('BLOCKS when a shared keyword is already run by another campaign', () => {
    const p = planApplication(doc, gale, existing)
    expect(p.allowed).toBe(false)
    expect(p.conflicts).toHaveLength(1)
    expect(p.conflicts[0]!.expression).toBe('giacca moto')
    expect(p.conflicts[0]!.resolution).toBe('UNRESOLVED')
    expect(p.blockers[0]).toMatch(/bid against campaigns you already run/)
    expect(p.blockers[0]).toMatch(/giacca moto/)
  })

  it('names the campaign it would fight, so the operator can judge', () => {
    const p = planApplication(doc, gale, existing)
    expect(p.conflicts[0]!.existing).toEqual([{ campaignName: 'IT-AIREON-SP-Category-Exact', campaignId: 'c_aireon' }])
  })

  it('SKIPPING a shared keyword removes it from the plan and unblocks', () => {
    const p = planApplication(doc, gale, existing, { skipSharedTargets: ['giacca moto'] })
    expect(p.allowed).toBe(true)
    expect(p.conflicts).toEqual([])
    const cat = p.campaigns.find((c) => c.role === 'Category-Exact')!
    expect(cat.adGroups[0]!.targets.map((t) => t.expression)).not.toContain('giacca moto')
    // the non-conflicting sibling survives
    expect(cat.adGroups[0]!.targets.map((t) => t.expression)).toContain('abbigliamento moto')
  })

  it('ACCEPTING keeps the keyword, records the decision, and unblocks', () => {
    const p = planApplication(doc, gale, existing, { acceptSharedTargets: ['giacca moto'] })
    expect(p.allowed).toBe(true)
    expect(p.conflicts[0]!.resolution).toBe('ACCEPTED')
    const cat = p.campaigns.find((c) => c.role === 'Category-Exact')!
    expect(cat.adGroups[0]!.targets.map((t) => t.expression)).toContain('giacca moto')
  })

  it('matching is case- and whitespace-insensitive', () => {
    const p = planApplication(doc, gale, [{ expression: '  GIACCA Moto ', campaignName: 'X', campaignId: 'x' }])
    expect(p.allowed).toBe(false)
    expect(p.conflicts[0]!.expression).toBe('giacca moto')
  })

  it('BRAND keywords never conflict — they parameterise per product', () => {
    // Someone already running "aireon" must not block GALE's own brand campaign.
    const p = planApplication(doc, gale, [{ expression: 'aireon', campaignName: 'IT-AIREON-SP-Brand-Exact', campaignId: 'c_a' }])
    expect(p.allowed).toBe(true)
  })

  it('a shared keyword that is only a NEGATIVE does not conflict', () => {
    // "casco moto" is a negative in the source; excluding the same traffic for
    // two products is harmless and must not be gated.
    const p = planApplication(doc, gale, [{ expression: 'casco moto', campaignName: 'Y', campaignId: 'y' }])
    expect(p.allowed).toBe(true)
    expect(p.conflicts).toEqual([])
  })
})

describe('planApplication — other blockers', () => {
  it('refuses when the replication exceeds the daily budget cap', () => {
    const p = planApplication(doc, gale, [], { dailyBudgetCapEur: 20 })
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('€25.00/day') && b.includes('€20.00 cap'))).toBe(true)
  })
  it('allows exactly at the cap', () => {
    expect(planApplication(doc, gale, [], { dailyBudgetCapEur: 25 }).allowed).toBe(true)
  })
  it('refuses with no ASINs — campaigns with nothing to advertise', () => {
    const p = planApplication(doc, { productToken: 'GALE', asins: [] }, [])
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('no ASINs'))).toBe(true)
  })
  it('refuses with a blank productToken', () => {
    const p = planApplication(doc, { productToken: '  ', asins: ['B0X'] }, [])
    expect(p.allowed).toBe(false)
    expect(p.blockers.some((b) => b.includes('productToken is required'))).toBe(true)
  })
  it('reports every blocker at once rather than one at a time', () => {
    const p = planApplication(doc, { productToken: 'GALE', asins: [] }, [
      { expression: 'giacca moto', campaignName: 'A', campaignId: 'a' },
    ], { dailyBudgetCapEur: 1 })
    expect(p.blockers.length).toBe(3)
  })
})
