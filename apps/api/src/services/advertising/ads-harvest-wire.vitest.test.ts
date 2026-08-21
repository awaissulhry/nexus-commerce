/** HP1 — the harvest wire, pinned: normalisation, mapping membership, filters, bid modes. */
import { describe, it, expect } from 'vitest'
import { normalizeHarvestWire, matchedBlocks, termPassesFilters, resolveHarvestBidEur, normalizeHarvestBidMode, type HarvestTermFilters } from './ads-harvest-wire.js'

const NO_FILTERS: HarvestTermFilters = { containsAny: [], notContains: [], brandExclude: [], competitorOnly: false }

describe('normalizeHarvestWire', () => {
  it('maps the builder shape: look flags, P/E/ASIN types, term filters, dedupe default ON', () => {
    const w = normalizeHarvestWire({
      mappings: [{ groups: [
        { id: 'ag1', look: true, types: { P: true, E: true, product: false } },
        { id: 'ag2', look: false, types: { P: false, E: true, product: true } },
        { id: 'ag3', look: true, types: { P: false, E: false, product: false } }, // look-only, creates nothing
      ] }],
      searchTerms: [{ term: 'Moto', op: 'contains' }, { term: 'kinder', op: 'not' }],
      filters: { brandExclude: ['xavia'], competitorOnly: true },
    })
    expect(w.blocks).toHaveLength(1)
    expect(w.blocks![0].look).toEqual(['ag1', 'ag3'])
    expect(w.blocks![0].create).toEqual([
      { adGroupId: 'ag1', types: ['PHRASE', 'EXACT'] },
      { adGroupId: 'ag2', types: ['EXACT', 'ASIN'] },
    ])
    expect(w.filters).toEqual({ containsAny: ['moto'], notContains: ['kinder'], brandExclude: ['xavia'], competitorOnly: true })
    expect(w.dedupe).toBe(true)
  })

  it('no mappings ⇒ blocks null (account-wide, the pre-HP1 behaviour) · dedupe:false honoured', () => {
    const w = normalizeHarvestWire({ dedupe: false })
    expect(w.blocks).toBeNull()
    expect(w.dedupe).toBe(false)
  })
})

describe('matchedBlocks', () => {
  const blocks = [
    { look: ['a', 'b'], create: [{ adGroupId: 'x', types: ['EXACT' as const] }] },
    { look: ['c'], create: [{ adGroupId: 'y', types: ['PHRASE' as const] }] },
  ]
  it('admits only blocks whose look set contains the source', () => {
    expect(matchedBlocks(blocks, 'c')).toEqual([blocks[1]])
    expect(matchedBlocks(blocks, 'zzz')).toEqual([])
  })
  it('null blocks = account-wide', () => {
    expect(matchedBlocks(null, 'anything')).toBe('account-wide')
  })
})

describe('termPassesFilters', () => {
  it('containsAny requires at least one hit; notContains and brand refuse with the token named', () => {
    const f: HarvestTermFilters = { ...NO_FILTERS, containsAny: ['moto', 'giacca'], notContains: ['bambino'], brandExclude: ['xavia'] }
    expect(termPassesFilters('giacca da moto', f, false)).toEqual({ pass: true })
    expect(termPassesFilters('casco integrale', f, false).pass).toBe(false)
    const r1 = termPassesFilters('giacca moto bambino', f, false)
    expect(r1.pass === false && r1.reason).toContain('bambino')
    const r2 = termPassesFilters('xavia moto giacca', f, false)
    expect(r2.pass === false && r2.reason).toContain('xavia')
  })
  it('competitorOnly skips OUR OWN asins only', () => {
    const f: HarvestTermFilters = { ...NO_FILTERS, competitorOnly: true }
    expect(termPassesFilters('b0abcd1234', f, true).pass).toBe(false)
    expect(termPassesFilters('b0abcd1234', f, false).pass).toBe(true) // a competitor's ASIN harvests
    expect(termPassesFilters('plain term', f, true).pass).toBe(true)
  })
})

describe('resolveHarvestBidEur — a bid is computed or refused, never a silent constant', () => {
  it('cpc inherits the term’s own CPC; refuses with no CPC', () => {
    expect(resolveHarvestBidEur('cpc', null, 0.437, null)).toEqual({ bidEur: 0.44 })
    expect('refuse' in resolveHarvestBidEur('cpc', null, null, null)).toBe(true)
  })
  it('cpcPlus scales it', () => {
    expect(resolveHarvestBidEur('cpcPlus', 20, 0.5, null)).toEqual({ bidEur: 0.6 })
  })
  it('adGroupDefault inherits the destination default; fixed takes the typed value', () => {
    expect(resolveHarvestBidEur('adGroupDefault', null, null, 0.35)).toEqual({ bidEur: 0.35 })
    expect(resolveHarvestBidEur('fixed', 0.75, null, null)).toEqual({ bidEur: 0.75 })
    expect('refuse' in resolveHarvestBidEur('fixed', null, null, null)).toBe(true)
  })
  it('legacy "suggested" (the €0.75 constant) normalises to cpc', () => {
    expect(normalizeHarvestBidMode('suggested')).toBe('cpc')
    expect(normalizeHarvestBidMode('fixed')).toBe('fixed')
  })
})

describe('HP2 — a paused pathway is out of both sides', () => {
  it('paused entries neither source nor receive; the rest of the block stands', () => {
    const w = normalizeHarvestWire({
      mappings: [{ groups: [
        { id: 'src1', look: true, types: { P: false, E: false, product: false } },
        { id: 'src2', look: true, paused: true, types: { P: false, E: true, product: false } },
        { id: 'dst1', look: false, types: { P: true, E: false, product: false } },
      ] }],
    })
    expect(w.blocks![0].look).toEqual(['src1'])
    expect(w.blocks![0].create).toEqual([{ adGroupId: 'dst1', types: ['PHRASE'] }])
  })
})
