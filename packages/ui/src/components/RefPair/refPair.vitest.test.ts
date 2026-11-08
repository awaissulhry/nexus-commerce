import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RefPair } from './RefPair'
import { REF_PAIR_LABELS } from './RefPairLabels'
import { refMatchParts, refPairSides, refPairText } from './refPairModel'

/** B-W2b-155 — RefPair: the partner's reference first, ours second; each copyable; a search match marked. */
describe('refPairSides', () => {
  const words = { theirs: 'Your PO', ours: 'Our ref.' }
  it('theirs first, ours second', () => {
    expect(refPairSides('4500-1234', 'SO-2026-0042', words).map((s) => [s.side, s.value])).toEqual([
      ['theirs', '4500-1234'],
      ['ours', 'SO-2026-0042'],
    ])
  })
  it('a missing or blank reference is left out', () => {
    expect(refPairSides(null, 'SO-1', words).map((s) => s.side)).toEqual(['ours'])
    expect(refPairSides('  ', 'SO-1', words).map((s) => s.side)).toEqual(['ours'])
    expect(refPairSides('PO-9', undefined, words).map((s) => s.side)).toEqual(['theirs'])
    expect(refPairSides(null, null, words)).toEqual([])
  })
  it('the pair as one line', () => {
    expect(refPairText(refPairSides('4500-1234', 'SO-1', words), REF_PAIR_LABELS.pair)).toBe('Your PO 4500-1234 · Our ref. SO-1')
    expect(refPairText(refPairSides(null, 'SO-1', words), REF_PAIR_LABELS.pair)).toBe('Our ref. SO-1')
  })
})

describe('refMatchParts', () => {
  it('marks every match, case and accents ignored', () => {
    expect(refMatchParts('PO-4500-1234', '4500')).toEqual([
      { text: 'PO-', match: false },
      { text: '4500', match: true },
      { text: '-1234', match: false },
    ])
    expect(refMatchParts('Ordine Città', 'citta').filter((p) => p.match).map((p) => p.text)).toEqual(['Città'])
    expect(refMatchParts('aa-AA', 'aa').filter((p) => p.match)).toHaveLength(2)
  })
  it('no search or no match: one part', () => {
    expect(refMatchParts('SO-1', '')).toEqual([{ text: 'SO-1', match: false }])
    expect(refMatchParts('SO-1', '  ')).toEqual([{ text: 'SO-1', match: false }])
    expect(refMatchParts('SO-1', 'XYZ')).toEqual([{ text: 'SO-1', match: false }])
  })
})

describe('RefPair markup', () => {
  const html = renderToStaticMarkup(
    createElement(RefPair, { theirs: '4500-1234', theirsLabel: 'Il vostro ordine', ours: 'SO-2026-0042', oursLabel: 'Nostro ordine', match: '4500', labels: { copy: (v: string) => `Copia ${v}` } }),
  )
  it('draws theirs before ours with their labels', () => {
    expect(html.indexOf('Il vostro ordine')).toBeLessThan(html.indexOf('Nostro ordine'))
    expect(html).toContain('data-side="theirs"')
  })
  it('each value has a named copy button, in the page\'s words', () => {
    expect(html).toContain('aria-label="Copia 4500-1234"')
    expect(html).toContain('aria-label="Copia SO-2026-0042"')
    expect(html).not.toMatch(/Copy /)
  })
  it('marks the search match and keeps a polite region for "Copied"', () => {
    expect(html).toContain('<mark class="nds-ref-mark">4500</mark>')
    expect(html).toContain('role="status"')
  })
  it('without copy no buttons; with no reference nothing at all', () => {
    expect(renderToStaticMarkup(createElement(RefPair, { ours: 'SO-1', copy: false }))).not.toContain('<button')
    expect(renderToStaticMarkup(createElement(RefPair, { theirs: null, ours: '' }))).toBe('')
  })
})
