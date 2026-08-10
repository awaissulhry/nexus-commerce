/**
 * NAF.SB.M-S6R — the evidence parser, against the shape prod actually stores.
 *
 * The first fixture is a VERBATIM value read off production on 2026-08-10, and
 * that is the point of the file. S6.c's parser passed every check I put to it —
 * the column existed, the row count matched the band — because none of those
 * checks looked INSIDE the cell. The screenshot did.
 *
 * No `@/` imports: the vitest runner in apps/web has no such alias.
 */
import { describe, it, expect } from 'vitest'
import { termsOf } from './entity-terms'

const PROD_TEN =
  'kw:giubbotto moto uomo|EXACT, kw:giacca moto uomo|EXACT, kw:giacca moto|EXACT, ' +
  'kw:giubbino moto estivo uomo|EXACT, kw:giubbotto moto uomo estivo|EXACT, ' +
  'kw:giacca moto donna|EXACT, kw:giacca moto donna estiva|EXACT, ' +
  'kw:giacca moto estiva donna|EXACT, kw:giacca moto estiva|EXACT, ' +
  'kw:giacca moto estiva uomo|EXACT'

describe('termsOf', () => {
  it('reads a real production value as ten terms, not one', () => {
    expect(termsOf(PROD_TEN)).toHaveLength(10)
  })

  /* The regression itself. The old pattern returned a single term whose text
     still carried `|EXACT, kw:` nine times over. */
  it('never leaves the wire format in a term', () => {
    for (const t of termsOf(PROD_TEN)) {
      expect(t.term).not.toContain('kw:')
      expect(t.term).not.toContain('|')
    }
  })

  it('keeps the term and the match type apart', () => {
    expect(termsOf(PROD_TEN)[0]).toEqual({ term: 'giubbotto moto uomo', type: 'exact' })
    expect(termsOf('kw:giacca|PHRASE')).toEqual([{ term: 'giacca', type: 'phrase' }])
  })

  /* An unresolved shape is shown as itself, never invented — the rule the whole
     page runs on. Both of these are non-matches, and both must survive intact. */
  it('shows an unexpected shape as itself', () => {
    expect(termsOf('asin:B01ABC')).toEqual([{ term: 'asin:B01ABC', type: '' }])
    expect(termsOf('kw:weird|lower')).toEqual([{ term: 'kw:weird|lower', type: '' }])
  })

  it('has nothing to say about an empty value', () => {
    expect(termsOf('')).toEqual([])
    expect(termsOf('   ,  ,')).toEqual([])
  })
})
