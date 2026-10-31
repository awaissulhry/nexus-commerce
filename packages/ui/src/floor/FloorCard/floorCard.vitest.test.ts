import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FloorCard } from './FloorCard'
import { FLOOR_CARD_MAX_FACTS, floorCardFacts, floorFlagIcon, type FloorCardFact } from './floorCardModel'

/** B-W2b-28 — FloorCard: the typed card of a scanned thing at floor size. */
const facts = (n: number): FloorCardFact[] => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, label: `Fact ${i}`, value: i }))

describe('floorCardFacts', () => {
  it('draws at most 8 facts and says how many were left out', () => {
    expect(FLOOR_CARD_MAX_FACTS).toBe(8)
    expect(floorCardFacts(facts(5))).toMatchObject({ left: 0 })
    const r = floorCardFacts(facts(10))
    expect(r.shown.map((f) => f.id)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'])
    expect(r.left).toBe(2)
  })
  it('leaves out a fact with no value, but keeps a zero', () => {
    const r = floorCardFacts([
      { id: 'a', label: 'A', value: null },
      { id: 'b', label: 'B', value: '' },
      { id: 'c', label: 'C', value: 0 },
      { id: 'd', label: 'D', value: undefined },
    ])
    expect(r.shown.map((f) => f.id)).toEqual(['c'])
  })
  it('a flag without an icon gets its tone’s icon', () => {
    expect(floorFlagIcon()).toBe('alert')
    expect(floorFlagIcon('danger')).toBe('alert')
    expect(floorFlagIcon('info')).toBe('info')
    expect(floorFlagIcon('success')).toBe('check')
    expect(floorFlagIcon('neutral')).toBe('flag')
  })
})

describe('FloorCard', () => {
  const base = {
    icon: h('svg'),
    kind: 'Bundle',
    code: 'B-000123',
    title: 'Demo jacket · Black',
    status: { label: 'Ready', tone: 'success' as const },
    facts: [
      { id: 'qty', label: 'Pieces', value: 20 },
      { id: 'missing', label: 'Missing', value: 'Short 1', tone: 'danger' as const },
    ],
    flags: [{ id: 'qc', label: 'Waiting for a check' }],
  }
  it('is an article named by its code, with the status said as a word', () => {
    const html = render(h(FloorCard, base))
    expect(html).toMatch(/<article[^>]*aria-labelledby="([^"]+)"/)
    expect(html).toContain('<h2')
    expect(html).toContain('B-000123')
    expect(html).toContain('Status: </span>Ready')
    expect(html).toContain('<dt>Pieces</dt><dd>20</dd>')
    expect(html).toContain('data-tone="danger"><dt>Missing</dt><dd>Short 1</dd>')
    expect(html).toContain('Waiting for a check')
  })
  it('says when cached facts were read; a live card shows no time', () => {
    expect(render(h(FloorCard, base))).not.toContain('Saved on this tablet')
    const html = render(h(FloorCard, { ...base, asOf: '2026-11-03T09:42:00Z', formatTime: () => '10:42' }))
    expect(html).toContain('Saved on this tablet · as of 10:42')
  })
  it('speaks the host’s language and takes a heading level', () => {
    const html = render(h(FloorCard, { ...base, headingLevel: 3, asOf: '2026-11-03T09:42:00Z', formatTime: () => '10:42', labels: { status: 'Stato', cachedAt: (t: string) => `Salvato sul tablet · alle ${t}` } }))
    expect(html).toContain('<h3')
    expect(html).toContain('Stato: </span>Ready')
    expect(html).toContain('Salvato sul tablet · alle 10:42')
  })
})
