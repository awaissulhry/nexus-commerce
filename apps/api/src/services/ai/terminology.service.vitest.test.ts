/**
 * MCP full control T4 — the glossary helpers a content change previews with (terminology.service.ts): the rows that
 * apply to one brand (most specific wins) and the avoid words a new text contains. Pure: no database.
 */
import { describe, expect, it } from 'vitest'
import { effectiveGlossary, glossaryHits, type GlossaryRow } from './terminology.service.js'

const row = (preferred: string, avoid: string[], extra: Partial<GlossaryRow> = {}): GlossaryRow =>
  ({ brand: null, marketplace: 'IT', language: 'it', preferred, avoid, context: null, ...extra })

describe('effectiveGlossary — most specific wins', () => {
  const everyBrand = row('Giacca', ['Giubbotto', 'Bomber'], { context: 'all brands' })
  const brandOwn = row('Giubbotto', ['Giaccone'], { brand: 'Test Brand', context: 'the brand says Giubbotto' })
  const brandGiacca = row('Giacca', ['Casacca'], { brand: 'Test Brand', context: 'the brand row about Giacca' })
  const otherMarket = row('Jacke', ['Giubbotto'], { marketplace: 'DE', language: 'de' })

  it("a brand's own row about a word replaces the all-brand row about the same word", () => {
    expect(effectiveGlossary([everyBrand, brandGiacca], 'Test Brand')).toEqual([brandGiacca])
  })

  it('a word the brand prefers is never an avoid word for it, whatever an all-brand row says', () => {
    expect(effectiveGlossary([everyBrand, brandOwn], 'Test Brand')).toEqual([brandOwn, { ...everyBrand, avoid: ['Bomber'] }])
    // In any case, and only in the same marketplace and language.
    expect(effectiveGlossary([everyBrand, { ...brandOwn, preferred: 'GIUBBOTTO' }], 'Test Brand')[1].avoid).toEqual(['Bomber'])
    expect(effectiveGlossary([otherMarket, brandOwn], 'Test Brand')).toEqual([brandOwn, otherMarket])
  })

  it("another brand's rows do not apply; with no brand every row stands as stored", () => {
    expect(effectiveGlossary([everyBrand, brandOwn], 'Other Brand')).toEqual([everyBrand])
    expect(effectiveGlossary([everyBrand, brandOwn], null)).toEqual([everyBrand, brandOwn])
  })
})

describe('glossaryHits — the avoid words a text contains', () => {
  const rows = [row('Giacca', ['Giubbotto', 'giacchetto in pelle'], { context: 'jackets' }), row('Jacke', ['Blouson'], { marketplace: 'DE', language: 'de' })]

  it('finds whole words and phrases in any case, in a text or a list of texts', () => {
    expect(glossaryHits('GIUBBOTTO da moto', rows)).toEqual([
      { avoid: 'Giubbotto', use: 'Giacca', context: 'jackets', brand: null, marketplace: 'IT', language: 'it' },
    ])
    expect(glossaryHits(['Comodo', 'Un Giacchetto in pelle nero', 'Blouson.'], rows).map((hit) => hit.avoid)).toEqual(['giacchetto in pelle', 'Blouson'])
  })

  it('a word inside a longer word is not a hit; accented letters count as letters', () => {
    expect(glossaryHits('Giubbottone e giubbottoè', rows)).toEqual([])
    expect(glossaryHits('', rows)).toEqual([])
  })

  it('a word the brand prefers is not reported once the rows are the effective ones', () => {
    const brand = row('Giubbotto', [], { brand: 'Test Brand' })
    expect(glossaryHits('Giubbotto', effectiveGlossary([...rows, brand], 'Test Brand'))).toEqual([])
    expect(glossaryHits('Giubbotto', [...rows, brand])).toHaveLength(1)
  })
})
