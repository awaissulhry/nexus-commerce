/**
 * KT.2 — the branded classifier, which is the one pure decision in the watchlist service.
 *
 * It matters more than it looks, for a reason measurement supplied: all ten `AdKeywordProtection`
 * rows on prod are `matchType = CONTAINS` with `marketplace = null`, so KT.1's blanket
 * `term.includes(brand)` sweep is **accidentally correct today** — honouring the columns changes
 * zero classifications in all four markets. Which is exactly why this needs tests: the sweep is
 * right by coincidence, one `EXACT` protection on a common word ends the coincidence, and KT.2
 * STORES the answer instead of recomputing it, so a wrong classification would persist.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

const { classifyBranded, normTerm } = await import('./keyword-watchlist.service.js')

/** The ten protections exactly as prod holds them, measured 2026-08-12. */
const PROD = ['air mesh', 'aireon', 'airmesh', 'gale', 'misano', 'moss', 'regal', 'ventra', 'x-tuta', 'xavia']
  .map((term) => ({ term, matchType: 'CONTAINS', isPrefix: false, marketplace: null }))

describe('classifyBranded', () => {
  it('flags our brand terms themselves', () => {
    for (const p of PROD) expect(classifyBranded(p.term, 'IT', PROD), p.term).toBe(true)
  })

  it('does not flag the curated terms — measured: 0 of 97 IT terms contain a brand word', () => {
    for (const t of ['giacca moto estiva uomo', 'accessori moto', 'gilet refrigerante', 'dainese', 'alpinestars']) {
      expect(classifyBranded(t, 'IT', PROD), t).toBe(false)
    }
  })

  it('CONTAINS catches the brand anywhere, which is why brand protection needs it', () => {
    // Amazon hands back "giacca moto xavia", which neither equals "xavia" nor starts with it
    expect(classifyBranded('giacca moto xavia', 'IT', PROD)).toBe(true)
  })

  it('EXACT does NOT catch a substring — the case the blanket sweep gets wrong', () => {
    const exact = [{ term: 'moss', matchType: 'EXACT', isPrefix: false, marketplace: null }]
    expect(classifyBranded('moss', 'IT', exact)).toBe(true)
    // a blanket includes() would flag this; EXACT must not
    expect(classifyBranded('mossa moto', 'IT', exact)).toBe(false)
  })

  it('PREFIX matches only at the start', () => {
    const prefix = [{ term: 'gale', matchType: 'PREFIX', isPrefix: false, marketplace: null }]
    expect(classifyBranded('gale jacket', 'IT', prefix)).toBe(true)
    expect(classifyBranded('xavia gale', 'IT', prefix)).toBe(false)
  })

  it('a null matchType falls back to isPrefix, so rows written before the column behave unchanged', () => {
    expect(classifyBranded('gale jacket', 'IT', [{ term: 'gale', matchType: null, isPrefix: true, marketplace: null }])).toBe(true)
    expect(classifyBranded('xavia gale', 'IT', [{ term: 'gale', matchType: null, isPrefix: true, marketplace: null }])).toBe(false)
    // isPrefix false + no matchType ⇒ EXACT
    expect(classifyBranded('gale jacket', 'IT', [{ term: 'gale', matchType: null, isPrefix: false, marketplace: null }])).toBe(false)
  })

  it('honours a market-scoped protection instead of applying it everywhere', () => {
    const deOnly = [{ term: 'moss', matchType: 'CONTAINS', isPrefix: false, marketplace: 'DE' }]
    expect(classifyBranded('moss jacke', 'DE', deOnly)).toBe(true)
    expect(classifyBranded('moss jacket', 'IT', deOnly)).toBe(false)
  })

  it('normalises both sides, so casing and double spaces cannot smuggle a brand past it', () => {
    expect(classifyBranded('  GIACCA   MOTO   XAVIA ', 'IT', PROD)).toBe(true)
    expect(classifyBranded('x', 'IT', [{ term: '  ', matchType: 'CONTAINS', isPrefix: false, marketplace: null }])).toBe(false)
  })

  it('no protections means nothing is branded', () => {
    expect(classifyBranded('xavia', 'IT', [])).toBe(false)
  })
})

describe('normTerm', () => {
  it('lowercases and collapses whitespace, matching what AdKeywordProtection stores', () => {
    expect(normTerm('  Giacca   Moto\tUomo \n')).toBe('giacca moto uomo')
  })
})
