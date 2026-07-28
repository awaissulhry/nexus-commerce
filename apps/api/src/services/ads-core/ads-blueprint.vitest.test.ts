/**
 * AX2.4 — blueprint extraction, parameterisation and diff.
 * Fixtures mirror the real IT-AIREON-SP-* structure.
 */
import { describe, it, expect } from 'vitest'
import {
  parameterise, classifyTarget, deriveRole, extractBlueprint, diffBlueprint,
  PRODUCT_TOKEN, type SourceCampaign,
} from './ads-blueprint.js'

const kw = (expressionValue: string, expressionType = 'EXACT', isNegative = false, bidCents: number | null = 2) => ({
  kind: 'KEYWORD', expressionType, expressionValue, bidCents, isNegative, negativeLevel: isNegative ? 'AD_GROUP' : null,
})

const aireon = (): SourceCampaign[] => [
  {
    name: 'IT-AIREON-SP-Brand-Exact', dailyBudget: 10, biddingStrategy: 'LEGACY_FOR_SALES', placementBidding: [],
    adGroups: [{
      name: 'IT-AIREON-SP-Brand-Exact Ad Group', defaultBidCents: 2, asins: ['B0FB41W1TD', 'B0FB41W1TE'],
      targets: [kw('aireon'), kw('aireon jacket'), kw('giacca aireon')],
    }],
  },
  {
    name: 'IT-AIREON-SP-Category-Exact', dailyBudget: 10, biddingStrategy: 'LEGACY_FOR_SALES', placementBidding: [],
    adGroups: [{
      name: 'IT-AIREON-SP-Category-Exact Ad Group', defaultBidCents: 2, asins: ['B0FB41W1TD'],
      targets: [kw('giacca moto'), kw('abbigliamento moto'), kw('aireon'), kw('giacca moto', 'EXACT', true)],
    }],
  },
]

describe('parameterise', () => {
  it('replaces the product token case-insensitively, everywhere', () => {
    expect(parameterise('IT-AIREON-SP-Brand', 'AIREON')).toBe(`IT-${PRODUCT_TOKEN}-SP-Brand`)
    expect(parameterise('giacca aireon estiva', 'AIREON')).toBe(`giacca ${PRODUCT_TOKEN} estiva`)
    expect(parameterise('aireon aireon', 'aireon')).toBe(`${PRODUCT_TOKEN} ${PRODUCT_TOKEN}`)
  })
  it('leaves text without the token untouched', () => {
    expect(parameterise('giacca moto', 'AIREON')).toBe('giacca moto')
  })
  it('is a no-op with an empty token — never mangles input', () => {
    expect(parameterise('giacca moto', '')).toBe('giacca moto')
  })
})

describe('classifyTarget', () => {
  it('BRAND when the keyword contains the product token', () => {
    expect(classifyTarget(kw('aireon jacket'), 'AIREON')).toBe('BRAND')
    expect(classifyTarget(kw('giacca aireon'), 'AIREON')).toBe('BRAND')
  })
  it('CATEGORY for generic keywords — the conservative default', () => {
    expect(classifyTarget(kw('giacca moto'), 'AIREON')).toBe('CATEGORY')
    expect(classifyTarget(kw('abbigliamento moto uomo'), 'AIREON')).toBe('CATEGORY')
  })
  it('COMPETITOR only when the operator supplies the token', () => {
    expect(classifyTarget(kw('alpinestars giacca'), 'AIREON')).toBe('CATEGORY')
    expect(classifyTarget(kw('alpinestars giacca'), 'AIREON', ['alpinestars'])).toBe('COMPETITOR')
  })
  it('does not match a token inside a larger word', () => {
    // "aireonaut" is not the brand.
    expect(classifyTarget(kw('aireonaut helmet'), 'AIREON')).toBe('CATEGORY')
  })
  it('ASIN for product targets', () => {
    expect(classifyTarget({ kind: 'PRODUCT', expressionValue: 'B0FB41W1TD' }, 'AIREON')).toBe('ASIN')
  })
  it('UNKNOWN for an empty expression rather than guessing', () => {
    expect(classifyTarget(kw(''), 'AIREON')).toBe('UNKNOWN')
  })
})

describe('deriveRole', () => {
  it('reduces a real campaign name to its job', () => {
    expect(deriveRole('IT-AIREON-SP-Brand-Broad', 'AIREON')).toBe('Brand-Broad')
    expect(deriveRole('IT-AIREON-SP-Category-Exact', 'AIREON')).toBe('Category-Exact')
    expect(deriveRole('IT-AIREON-SP-Auto', 'AIREON')).toBe('Auto')
    expect(deriveRole('IT-AIREON-SP-PAT', 'AIREON')).toBe('PAT')
  })
  it('gives the same role for a different product — that is the whole point', () => {
    expect(deriveRole('IT-GALE-SP-Brand-Broad', 'GALE')).toBe(deriveRole('IT-AIREON-SP-Brand-Broad', 'AIREON'))
  })
})

describe('extractBlueprint', () => {
  const doc = extractBlueprint(aireon(), { productToken: 'AIREON' })

  it('parameterises names into reusable patterns', () => {
    expect(doc.campaigns.map((c) => c.namePattern)).toEqual([
      `IT-${PRODUCT_TOKEN}-SP-Brand-Exact`,
      `IT-${PRODUCT_TOKEN}-SP-Category-Exact`,
    ])
    expect(doc.campaigns[0]!.adGroups[0]!.namePattern).toBe(`IT-${PRODUCT_TOKEN}-SP-Brand-Exact Ad Group`)
  })

  it('counts structure without carrying the source ASINs', () => {
    expect(doc.stats.campaigns).toBe(2)
    expect(doc.stats.adGroups).toBe(2)
    expect(doc.stats.productAds).toBe(3)
    expect(doc.campaigns[0]!.adGroups[0]!.productAdCount).toBe(2)
    // ASINs are per-product and deliberately not part of the reusable doc.
    expect(JSON.stringify(doc)).not.toContain('B0FB41W1TD')
  })

  it('splits positives from negatives', () => {
    expect(doc.stats.positives).toBe(6)
    expect(doc.stats.negatives).toBe(1)
  })

  it('classifies brand vs category', () => {
    expect(doc.stats.byClass.BRAND).toBe(4) // 3 brand + "aireon" in the category campaign
    expect(doc.stats.byClass.CATEGORY).toBe(3) // giacca moto, abbigliamento moto, + the negative
  })

  // ── the load-bearing output ───────────────────────────────────────────
  it('reports the shared surface — the self-competition risk', () => {
    expect(doc.sharedTargets.map((t) => t.expression)).toEqual(['abbigliamento moto', 'giacca moto'])
    expect(doc.sharedTargets.every((t) => t.targetClass === 'CATEGORY')).toBe(true)
  })

  it('INCLUDES competitor terms — two of our products on a rival term still collide', () => {
    const withComp = extractBlueprint([{
      name: 'IT-AIREON-SP-Competitor-Exact', dailyBudget: 10, biddingStrategy: null, placementBidding: [],
      adGroups: [{ name: 'g', defaultBidCents: 2, asins: [], targets: [kw('dainese giacca')] }],
    }], { productToken: 'AIREON' })
    expect(withComp.stats.byClass.COMPETITOR).toBe(1)
    expect(withComp.sharedTargets).toEqual([{ expression: 'dainese giacca', targetClass: 'COMPETITOR' }])
  })

  it('EXCLUDES negatives from the shared surface — a shared negative is harmless', () => {
    // "giacca moto" appears as both a positive and a negative here; it is listed
    // once, because of the positive. A negative-only category term must not be
    // flagged as competing.
    const negOnly = extractBlueprint([{
      name: 'IT-AIREON-SP-X', dailyBudget: 1, biddingStrategy: null, placementBidding: [],
      adGroups: [{ name: 'g', defaultBidCents: 2, asins: [], targets: [kw('casco moto', 'EXACT', true)] }],
    }], { productToken: 'AIREON' })
    expect(negOnly.sharedTargets).toEqual([])
  })

  it('brand keywords are NOT shared — they parameterise per product', () => {
    const exprs = doc.sharedTargets.map((t) => t.expression)
    expect(exprs).not.toContain('aireon')
    expect(exprs.join(' ')).not.toContain('aireon')
  })
})

describe('diffBlueprint', () => {
  const doc = extractBlueprint(aireon(), { productToken: 'AIREON' })

  it('a structure identical but for the product conforms', () => {
    const gale = JSON.parse(JSON.stringify(aireon()).replace(/AIREON/g, 'GALE').replace(/aireon/g, 'gale')) as SourceCampaign[]
    const d = diffBlueprint(doc, gale, 'GALE')
    expect(d.conforms).toBe(true)
    expect(d.matched).toBe(2)
    expect(d.entries).toEqual([])
  })

  it('flags a missing campaign role', () => {
    const gale = (JSON.parse(JSON.stringify(aireon()).replace(/AIREON/g, 'GALE').replace(/aireon/g, 'gale')) as SourceCampaign[]).slice(0, 1)
    const d = diffBlueprint(doc, gale, 'GALE')
    expect(d.conforms).toBe(false)
    expect(d.entries.some((e) => e.kind === 'MISSING_CAMPAIGN' && e.role === 'Category-Exact')).toBe(true)
  })

  it('flags budget and bid drift', () => {
    const gale = JSON.parse(JSON.stringify(aireon()).replace(/AIREON/g, 'GALE').replace(/aireon/g, 'gale')) as SourceCampaign[]
    gale[0]!.dailyBudget = 25
    gale[0]!.adGroups[0]!.targets[0]!.bidCents = 40
    const d = diffBlueprint(doc, gale, 'GALE')
    expect(d.entries.some((e) => e.kind === 'BUDGET' && e.detail.includes('25'))).toBe(true)
    expect(d.entries.some((e) => e.kind === 'BID' && e.detail.includes('40c'))).toBe(true)
  })

  it('flags targets present live but absent from the blueprint', () => {
    const gale = JSON.parse(JSON.stringify(aireon()).replace(/AIREON/g, 'GALE').replace(/aireon/g, 'gale')) as SourceCampaign[]
    gale[0]!.adGroups[0]!.targets.push(kw('giacca invernale'))
    const d = diffBlueprint(doc, gale, 'GALE')
    expect(d.entries.some((e) => e.kind === 'EXTRA_TARGET' && e.detail.includes('giacca invernale'))).toBe(true)
  })

  it('a missing target is reported per role', () => {
    const gale = JSON.parse(JSON.stringify(aireon()).replace(/AIREON/g, 'GALE').replace(/aireon/g, 'gale')) as SourceCampaign[]
    gale[1]!.adGroups[0]!.targets = gale[1]!.adGroups[0]!.targets.slice(0, 1)
    const d = diffBlueprint(doc, gale, 'GALE')
    const missing = d.entries.filter((e) => e.kind === 'MISSING_TARGET' && e.role === 'Category-Exact')
    expect(missing.length).toBeGreaterThan(0)
  })
})
