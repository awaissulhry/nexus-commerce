/**
 * B-3 — the SP Super Wizard's structures and negative funnel, the one copy the wizard's screen and Claude's one-off
 * build both use: the campaigns each structure generates (order, names, ids) and the funnel's negatives inside the set.
 * Values are made up.
 */
import { describe, expect, it } from 'vitest'
import { advancedRows, applyAutoNegatives, AUTO_GROUP_MULT, dedupeCI, DEFAULT_CUSTOM_NAME_TOKENS, generateCampaignRows, singleMatch, standardRows } from './ads-sp-wizard.js'

describe('the structures', () => {
  it('the diagram rows: Standard 5, Advanced 11', () => {
    expect(standardRows().map((r) => [r.c, r.a, r.m, r.k])).toEqual([
      ['Campaign 1', 'AdGroup 1', 'Auto', '-'],
      ['Campaign 2', 'AdGroup 2', 'Broad & Phrase & Exact', 'Brand'],
      ['Campaign 3', 'AdGroup 3', 'Broad & Phrase & Exact', 'Competitor'],
      ['Campaign 4', 'AdGroup 4', 'Broad & Phrase & Exact', 'Category'],
      ['Campaign 5', 'AdGroup 5', 'PAT', '-'],
    ])
    expect(advancedRows().map((r) => `${r.m} ${r.k}`)).toEqual([
      'Auto -', 'Broad Brand', 'Broad Competitor', 'Broad Category', 'Phrase Brand', 'Phrase Competitor', 'Phrase Category',
      'Exact Brand', 'Exact Competitor', 'Exact Category', 'PAT -',
    ])
  })

  it('Standard: Auto, one keyword campaign per keyword type, PAT', () => {
    const c = generateCampaignRows('Test Jacket', 'standard', [], [])
    expect(c.map((x) => [x.id, x.name, x.adGroupName, x.kind, x.matchType, x.keywordType, x.keywords])).toEqual([
      ['cmp-0', 'Test Jacket-SP-Auto', 'Test Jacket-SP-Auto Ad Group', 'auto', 'Auto', '-', []],
      ['cmp-1', 'Test Jacket-SP-Keyword-Brand', 'Test Jacket-SP-Keyword-Brand Ad Group', 'keyword', 'Broad & Phrase & Exact', 'Brand', []],
      ['cmp-2', 'Test Jacket-SP-Keyword-Competitor', 'Test Jacket-SP-Keyword-Competitor Ad Group', 'keyword', 'Broad & Phrase & Exact', 'Competitor', []],
      ['cmp-3', 'Test Jacket-SP-Keyword-Category', 'Test Jacket-SP-Keyword-Category Ad Group', 'keyword', 'Broad & Phrase & Exact', 'Category', []],
      ['cmp-4', 'Test Jacket-SP-PAT', 'Test Jacket-SP-PAT Ad Group', 'pat', 'PAT', '-', []],
    ])
    // An empty group name is "Campaign", as on the screen.
    expect(generateCampaignRows('  ', 'standard', [], [])[0].name).toBe('Campaign-SP-Auto')
  })

  it('Advanced: each keyword type at broad, at phrase and at exact on its own', () => {
    expect(generateCampaignRows('T', 'advanced', [], []).map((x) => x.name)).toEqual([
      'T-SP-Auto',
      'T-SP-Keyword-Brand-Broad', 'T-SP-Keyword-Competitor-Broad', 'T-SP-Keyword-Category-Broad',
      'T-SP-Keyword-Brand-Phrase', 'T-SP-Keyword-Competitor-Phrase', 'T-SP-Keyword-Category-Phrase',
      'T-SP-Keyword-Brand-Exact', 'T-SP-Keyword-Competitor-Exact', 'T-SP-Keyword-Category-Exact',
      'T-SP-PAT',
    ])
  })

  it('Custom: the chosen campaign types, each keyword type at its match types, named by the tokens', () => {
    const types = [{ name: 'Research', matchTypes: ['BROAD' as const], keywords: ['race jacket'] }, { name: 'Performance', matchTypes: ['EXACT' as const, 'PHRASE' as const], keywords: ['race jacket'] }]
    const tokens = [...DEFAULT_CUSTOM_NAME_TOKENS]
    expect(generateCampaignRows('T', 'custom', types, ['auto', 'keyword', 'product'], tokens).map((x) => [x.name, x.kind, x.matchType, x.keywordType, x.keywords])).toEqual([
      ['T-SP-Auto', 'auto', 'Auto', '-', []],
      ['T-SP-Keyword-Broad-Research', 'keyword', 'Broad', 'Research', ['race jacket']],
      ['T-SP-Keyword-Exact-Performance', 'keyword', 'Exact', 'Performance', ['race jacket']],
      ['T-SP-Keyword-Phrase-Performance', 'keyword', 'Phrase', 'Performance', ['race jacket']],
      ['T-SP-PAT', 'pat', 'PAT', '-', []],
    ])
    expect(generateCampaignRows('T', 'custom', types, ['keyword'], ['asin', 'keywordType'], 'B0TESTASIN').map((x) => x.name))
      .toEqual(['T-B0TESTASIN-Research', 'T-B0TESTASIN-Performance', 'T-B0TESTASIN-Performance'])
    // No tokens: the group name alone.
    expect(generateCampaignRows('T', 'custom', [], ['auto'])[0].name).toBe('T')
  })
})

describe('the negative funnel (NT.1), inside the set only', () => {
  const advanced = () => generateCampaignRows('T', 'advanced', [], []).map((c) => ({
    ...c, negKeywords: [] as Array<{ text: string; matchType: 'EXACT' | 'PHRASE'; auto?: boolean }>,
    keywords: c.keywordType === 'Brand' ? ['b1'] : c.keywordType === 'Category' ? ['c1', 'c2'] : [],
  }))
  const negs = (c: { negKeywords: Array<{ text: string; matchType: string }> }) => c.negKeywords.map((n) => `${n.matchType} ${n.text}`)

  it('broad negates its keyword type as exact and phrase, phrase as exact, exact none; Auto every keyword as exact', () => {
    const c = applyAutoNegatives(advanced(), true)
    const byName = new Map(c.map((x) => [x.name, x]))
    expect(negs(byName.get('T-SP-Auto')!)).toEqual(['EXACT b1', 'EXACT c1', 'EXACT c2'])
    expect(negs(byName.get('T-SP-Keyword-Category-Broad')!)).toEqual(['EXACT c1', 'EXACT c2', 'PHRASE c1', 'PHRASE c2'])
    expect(negs(byName.get('T-SP-Keyword-Category-Phrase')!)).toEqual(['EXACT c1', 'EXACT c2'])
    expect(negs(byName.get('T-SP-Keyword-Category-Exact')!)).toEqual([])
    // Never another keyword type's words.
    expect(negs(byName.get('T-SP-Keyword-Brand-Broad')!)).toEqual(['EXACT b1', 'PHRASE b1'])
    expect(negs(byName.get('T-SP-PAT')!)).toEqual([])
    expect(c.flatMap((x) => x.negKeywords).every((n) => n.auto)).toBe(true)
  })

  it('a manual negative comes first and wins over the same funnel one; off drops the funnel and keeps the manual ones', () => {
    const own = advanced().map((x) => ({ ...x, negKeywords: [{ text: 'C1', matchType: 'EXACT' as const }, { text: 'cheap', matchType: 'PHRASE' as const }] }))
    const on = applyAutoNegatives(own, true)
    expect(negs(on.find((x) => x.name === 'T-SP-Keyword-Category-Phrase')!)).toEqual(['EXACT C1', 'PHRASE cheap', 'EXACT c2'])
    expect(applyAutoNegatives(on, false).every((x) => negs(x).join() === 'EXACT C1,PHRASE cheap')).toBe(true)
    // Recomputed, never piled up: running it twice gives the same negatives.
    expect(applyAutoNegatives(on, true)).toEqual(on)
  })

  it('Standard\'s combined keyword campaigns take no part; every other field of a campaign is kept', () => {
    const c = applyAutoNegatives(generateCampaignRows('T', 'standard', [], []).map((x) => ({ ...x, negKeywords: [], bid: '0.75', keywords: x.keywordType === 'Category' ? ['c1'] : [] })), true)
    expect(c.map((x) => x.negKeywords.length)).toEqual([1, 0, 0, 0, 0])
    expect(c.every((x) => x.bid === '0.75')).toBe(true)
  })
})

it('the helpers: one match type per campaign label, each text once, the Auto multipliers', () => {
  expect(['Broad & Phrase & Exact', 'Broad', 'Phrase', 'Exact', 'Auto', 'PAT'].map(singleMatch)).toEqual([null, 'BROAD', 'PHRASE', 'EXACT', null, null])
  expect(dedupeCI([' Race Jacket', 'race jacket', '', 'moto'])).toEqual(['Race Jacket', 'moto'])
  expect(AUTO_GROUP_MULT).toEqual({ CLOSE_MATCH: 1.0, SUBSTITUTES: 1.1, LOOSE_MATCH: 0.65, COMPLEMENTS: 0.6 })
})
