import { describe, expect, it } from 'vitest'

import { compareEntityLinks, entityCountWords, entityLinksText, entityLinksView, entityMoreWords } from './entityLinksModel'

const campaigns = { one: 'campaign', many: 'campaigns' }
const a = { id: '1', name: 'Jacket Exact', href: '/marketing/ads/campaigns/1' }
const b = { id: '2', name: 'Jacket Phrase', href: '/marketing/ads/campaigns/2' }
const c = { id: '3', name: 'Jacket Broad' }

describe('entityLinksView', () => {
  it('none → a dash that says what is missing', () => {
    expect(entityLinksView([], campaigns)).toEqual({ kind: 'none', label: 'No campaigns' })
    expect(entityLinksView(null, campaigns)).toEqual({ kind: 'none', label: 'No campaigns' })
  })
  it('one → its name as a direct link', () => {
    expect(entityLinksView([a], campaigns)).toEqual({ kind: 'one', item: a, label: 'Campaign: Jacket Exact' })
  })
  it('several → a count, and every name for the screen reader; the same id is listed once', () => {
    expect(entityLinksView([a, b, c, a], campaigns)).toEqual({
      kind: 'many', items: [a, b, c], words: '3 campaigns', label: '3 campaigns: Jacket Exact, Jacket Phrase, Jacket Broad', more: 0,
    })
  })
})

describe('entityLinks words', () => {
  it('counts in the noun\'s number', () => {
    expect(entityCountWords(1, campaigns)).toBe('1 campaign')
    expect(entityCountWords(2, { one: 'ad group', many: 'ad groups' })).toBe('2 ad groups')
  })
  it('names every thing for the CSV and the quick filter', () => {
    expect(entityLinksText([a, c])).toBe('Jacket Exact, Jacket Broad')
    expect(entityLinksText(undefined)).toBe('')
  })
  it('sorts by how many, then by the first name', () => {
    const lists = [[a, b], [c], [], [b]]
    expect(lists.sort(compareEntityLinks).map((l) => l.map((x) => x.id).join('+'))).toEqual(['', '3', '2', '1+2'])
  })
})

describe('entityLinksView — a capped list says its true count (polish round 2)', () => {
  const noun = { one: 'campaign', many: 'campaigns' }
  const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Campaign ${i}` }))

  it('the chip says the total, the list ends with what is not listed', () => {
    const v = entityLinksView(refs(3), noun, 153)
    expect(v.kind).toBe('many')
    if (v.kind !== 'many') return
    expect(v.words).toBe('153 campaigns')
    expect(v.more).toBe(150)
    expect(v.label).toBe('153 campaigns: Campaign 0, Campaign 1, Campaign 2, and 150 more not listed')
    expect(entityMoreWords(53)).toBe('53 more not listed')
  })

  it('one listed of more is a count, not a single link; none listed of some is a count too', () => {
    expect(entityLinksView(refs(1), noun, 4)).toMatchObject({ kind: 'many', words: '4 campaigns', more: 3 })
    expect(entityLinksView([], noun, 2)).toMatchObject({ kind: 'many', words: '2 campaigns', more: 2, label: '2 campaigns: 2 more not listed' })
  })

  it('no total, or a total below the list, changes nothing', () => {
    expect(entityLinksView(refs(3), noun)).toMatchObject({ words: '3 campaigns', more: 0 })
    expect(entityLinksView(refs(3), noun, 1)).toMatchObject({ words: '3 campaigns', more: 0 })
    expect(entityLinksView(refs(1), noun, 1).kind).toBe('one')
    expect(entityLinksView([], noun, 0).kind).toBe('none')
  })

  it('sorts by the true count', () => {
    expect(compareEntityLinks(refs(100), refs(3), 153, null)).toBeGreaterThan(0)
    expect(compareEntityLinks(refs(100), refs(100), 100, 153)).toBeLessThan(0)
  })
})
