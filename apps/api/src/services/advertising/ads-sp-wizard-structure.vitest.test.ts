/**
 * B-3 — the SP Super Wizard's structures, server side (ads-sp-wizard-structure.ts), pinned to what the wizard's screen
 * makes (StructureSelection.tsx, CampaignSetup.tsx `generateCampaigns` / `applyAutoNegatives`): the same campaigns, in
 * the same order, with the same names, and the same negative funnel inside the set. Pure. Values are made up.
 */
import { describe, expect, it } from 'vitest'
import { applyWizardFunnel, autoGroupBidCents, generateWizardCampaigns, WIZARD_AUTO_GROUPS } from './ads-sp-wizard-structure.js'

const keywords = { Brand: ['testbrand jacket', 'testbrand'], Competitor: ['otherbrand jacket'], Category: ['race jacket', 'moto jacket', 'Race Jacket'] }

describe('the structures, as the screen generates them', () => {
  it('Standard: 5 campaigns — Auto, one keyword campaign per keyword type at broad, phrase and exact, PAT', () => {
    const c = generateWizardCampaigns({ productGroupName: 'Test Jacket', structure: 'standard', keywords })
    expect(c.map((x) => [x.id, x.name, x.kind, x.matchType, x.keywordType])).toEqual([
      ['cmp-0', 'Test Jacket-SP-Auto', 'auto', 'Auto', '-'],
      ['cmp-1', 'Test Jacket-SP-Keyword-Brand', 'keyword', 'Broad & Phrase & Exact', 'Brand'],
      ['cmp-2', 'Test Jacket-SP-Keyword-Competitor', 'keyword', 'Broad & Phrase & Exact', 'Competitor'],
      ['cmp-3', 'Test Jacket-SP-Keyword-Category', 'keyword', 'Broad & Phrase & Exact', 'Category'],
      ['cmp-4', 'Test Jacket-SP-PAT', 'pat', 'PAT', '-'],
    ])
    expect(c[0].adGroupName).toBe('Test Jacket-SP-Auto Ad Group')
    // Each keyword once, the first spelling kept.
    expect(c[3].keywords).toEqual(['race jacket', 'moto jacket'])
  })

  it('Advanced: 11 campaigns — Auto, each keyword type at broad, at phrase and at exact on its own, PAT', () => {
    const c = generateWizardCampaigns({ productGroupName: 'Test Jacket', structure: 'advanced', keywords })
    expect(c.map((x) => x.name)).toEqual([
      'Test Jacket-SP-Auto',
      'Test Jacket-SP-Keyword-Brand-Broad', 'Test Jacket-SP-Keyword-Competitor-Broad', 'Test Jacket-SP-Keyword-Category-Broad',
      'Test Jacket-SP-Keyword-Brand-Phrase', 'Test Jacket-SP-Keyword-Competitor-Phrase', 'Test Jacket-SP-Keyword-Category-Phrase',
      'Test Jacket-SP-Keyword-Brand-Exact', 'Test Jacket-SP-Keyword-Competitor-Exact', 'Test Jacket-SP-Keyword-Category-Exact',
      'Test Jacket-SP-PAT',
    ])
    expect(c.map((x) => x.id)).toEqual(Array.from({ length: 11 }, (_, i) => `cmp-${i}`))
  })

  it('Custom: the chosen campaign types and each keyword type at its match types, named by the default tokens (the Quick shape)', () => {
    const c = generateWizardCampaigns({
      productGroupName: 'Test Jacket', structure: 'custom', customTargeting: ['auto', 'keyword', 'product'],
      customKeywordTypes: [{ name: 'Research', matchTypes: ['BROAD'], keywords: ['race jacket'] }, { name: 'Performance', matchTypes: ['EXACT'], keywords: ['race jacket'] }],
    })
    expect(c.map((x) => [x.name, x.kind, x.matchType, x.keywordType, x.keywords])).toEqual([
      ['Test Jacket-SP-Auto', 'auto', 'Auto', '-', []],
      ['Test Jacket-SP-Keyword-Broad-Research', 'keyword', 'Broad', 'Research', ['race jacket']],
      ['Test Jacket-SP-Keyword-Exact-Performance', 'keyword', 'Exact', 'Performance', ['race jacket']],
      ['Test Jacket-SP-PAT', 'pat', 'PAT', '-', []],
    ])
    expect(generateWizardCampaigns({ productGroupName: 'G', structure: 'custom', customTargeting: ['keyword'], customKeywordTypes: [{ name: 'Brand', matchTypes: ['BROAD', 'PHRASE'], keywords: ['x'] }] }).map((x) => x.name))
      .toEqual(['G-SP-Keyword-Broad-Brand', 'G-SP-Keyword-Phrase-Brand'])
  })
})

describe('the negative funnel (NT.1), inside the set only', () => {
  const advanced = () => generateWizardCampaigns({ productGroupName: 'T', structure: 'advanced', keywords: { Brand: ['b1'], Category: ['c1', 'c2'] } })
  const negs = (c: ReturnType<typeof advanced>[number]) => c.negKeywords.map((n) => `${n.matchType} ${n.text}`)

  it('broad negates its keyword type as exact and phrase, phrase as exact, exact none; Auto negates every keyword as exact', () => {
    const c = applyWizardFunnel(advanced(), true)
    const byName = new Map(c.map((x) => [x.name, x]))
    expect(negs(byName.get('T-SP-Auto')!)).toEqual(['EXACT b1', 'EXACT c1', 'EXACT c2'])
    expect(negs(byName.get('T-SP-Keyword-Category-Broad')!)).toEqual(['EXACT c1', 'EXACT c2', 'PHRASE c1', 'PHRASE c2'])
    expect(negs(byName.get('T-SP-Keyword-Category-Phrase')!)).toEqual(['EXACT c1', 'EXACT c2'])
    expect(negs(byName.get('T-SP-Keyword-Category-Exact')!)).toEqual([])
    // Never another keyword type's words: Brand's broad campaign holds only Brand's.
    expect(negs(byName.get('T-SP-Keyword-Brand-Broad')!)).toEqual(['EXACT b1', 'PHRASE b1'])
    expect(negs(byName.get('T-SP-PAT')!)).toEqual([])
    expect(c.flatMap((x) => x.negKeywords).every((n) => n.funnel)).toBe(true)
  })

  it('Standard\'s combined keyword campaigns take no part; only Auto is kept apart', () => {
    const c = applyWizardFunnel(generateWizardCampaigns({ productGroupName: 'T', structure: 'standard', keywords: { Category: ['c1'] } }), true)
    expect(c.map((x) => x.negKeywords.length)).toEqual([1, 0, 0, 0, 0])
  })

  it('your own negatives come first and win over the same funnel negative; off drops the funnel and keeps yours', () => {
    const own = advanced().map((x) => ({ ...x, negKeywords: [{ text: 'C1', matchType: 'EXACT' as const }, { text: 'cheap', matchType: 'PHRASE' as const }] }))
    const on = applyWizardFunnel(own, true)
    expect(negs(on.find((x) => x.name === 'T-SP-Keyword-Category-Phrase')!)).toEqual(['EXACT C1', 'PHRASE cheap', 'EXACT c2'])
    const off = applyWizardFunnel(on, false)
    expect(off.every((x) => negs(x).join() === 'EXACT C1,PHRASE cheap')).toBe(true)
  })
})

it('the Auto groups: all four on, at the default bid times the screen\'s multipliers', () => {
  expect(WIZARD_AUTO_GROUPS.map((g) => [g.key, autoGroupBidCents(75, g.multiplier)])).toEqual([
    ['CLOSE_MATCH', 75], ['LOOSE_MATCH', 49], ['SUBSTITUTES', 83], ['COMPLEMENTS', 45],
  ])
})
