import { describe, expect, it } from 'vitest'
import {
  anyMedia, filterChoices, groupChoices, groupOrderOf, isHexColour, mediaMarkKind, mergeSelection, moveChoice, nextActiveIndex, removeChoice,
  resolveChosen, selectionSummary, toggleChoice, type MediaChoice,
} from './media-choice'

const colours: MediaChoice[] = [
  { value: 'gid://c/1', label: 'Green', swatch: '#3fa34d', group: 'Store entries' },
  { value: 'gid://c/2', label: 'Black', swatch: '#000000', group: 'Store entries' },
  { value: 'std/beige', label: 'Beige', swatch: '#e8dab2', group: 'Default entries' },
  { value: 'std/blue', label: 'Blue', swatch: '#2156d9', group: 'Default entries' },
]

describe('media marks', () => {
  it('draws a picture before a swatch, and nothing when neither is real', () => {
    expect(mediaMarkKind({ image: 'https://x/y.png', swatch: '#fff' })).toBe('image')
    expect(mediaMarkKind({ image: '', swatch: '#fff' })).toBe('swatch')
    expect(mediaMarkKind({ image: null, swatch: 'red' })).toBe('none')
    expect(mediaMarkKind({})).toBe('none')
  })
  it('accepts only #RGB and #RRGGBB colours', () => {
    expect(isHexColour('#abc')).toBe(true)
    expect(isHexColour(' #A1B2C3 ')).toBe(true)
    expect(isHexColour('#abcd')).toBe(false)
    expect(isHexColour('rgb(0,0,0)')).toBe(false)
    expect(isHexColour(null)).toBe(false)
  })
  it('says whether a list needs a picture column at all', () => {
    expect(anyMedia(colours)).toBe(true)
    expect(anyMedia([{ image: null }, {}])).toBe(false)
  })
})

describe('search and groups', () => {
  it('matches the detail line too, and keeps the input order for an empty query', () => {
    const rows: MediaChoice[] = [{ value: '1', label: 'MOSS Jacket', detail: 'moss-jacket' }, { value: '2', label: 'AIREON Pant', detail: 'aireon-pant' }]
    expect(filterChoices('', rows).map(r => r.value)).toEqual(['1', '2'])
    expect(filterChoices('aireon', rows).map(r => r.value)).toEqual(['2'])
    expect(filterChoices('jacket moss', rows).map(r => r.value)).toEqual(['1'])
  })
  it('returns the flat list in the order the groups render', () => {
    const mixed = [colours[2], colours[0], colours[3], colours[1]]
    const { groups, flat } = groupChoices(mixed)
    expect(groups.map(g => g.name)).toEqual(['Default entries', 'Store entries'])
    expect(flat.map(c => c.label)).toEqual(['Beige', 'Blue', 'Green', 'Black'])
  })
  it('keeps the unfiltered group order when a search ranks a later group first', () => {
    const ranked = filterChoices('bl', colours)
    expect(ranked.map(c => c.label)).toEqual(['Blue', 'Black'])
    expect(groupChoices(ranked).groups.map(g => g.name)).toEqual(['Default entries', 'Store entries'])
    const pinned = groupChoices(ranked, groupOrderOf(colours))
    expect(pinned.groups.map(g => g.name)).toEqual(['Store entries', 'Default entries'])
    expect(pinned.flat.map(c => c.label)).toEqual(['Black', 'Blue'])
  })
  it('puts an ungrouped list in one unnamed group', () => {
    const { groups, flat } = groupChoices([{ value: 'a', label: 'A' }])
    expect(groups).toEqual([{ name: '', choices: [{ value: 'a', label: 'A' }] }])
    expect(flat).toHaveLength(1)
  })
})

describe('picking', () => {
  it('adds a new multi pick at the end and removes a picked one', () => {
    expect(toggleChoice(['a', 'b'], 'c', 'multi')).toEqual(['a', 'b', 'c'])
    expect(toggleChoice(['a', 'b', 'c'], 'b', 'multi')).toEqual(['a', 'c'])
  })
  it('refuses a pick past the cap with the SAME array', () => {
    const before = ['a', 'b']
    expect(toggleChoice(before, 'c', 'multi', 2)).toBe(before)
    expect(toggleChoice(before, 'a', 'multi', 2)).toEqual(['b'])
  })
  it('replaces a single pick, and keeps it when picked again', () => {
    const before = ['a']
    expect(toggleChoice(before, 'b', 'single')).toEqual(['b'])
    expect(toggleChoice(before, 'a', 'single')).toBe(before)
    expect(toggleChoice([], 'a', 'single')).toEqual(['a'])
  })
  it('keeps hand-made order on Done: old picks stay put, new ones follow in pick order', () => {
    expect(mergeSelection(['c', 'a', 'b'], ['b', 'x', 'c', 'y'])).toEqual(['c', 'b', 'x', 'y'])
    expect(mergeSelection(['a'], [])).toEqual([])
  })
})

describe('ordering and removal', () => {
  it('moves one value and returns the SAME array for a no-op', () => {
    const v = ['a', 'b', 'c']
    expect(moveChoice(v, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveChoice(v, 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveChoice(v, 1, 1)).toBe(v)
    expect(moveChoice(v, 0, 3)).toBe(v)
  })
  it('removes a present value and ignores an absent one', () => {
    const v = ['a', 'b']
    expect(removeChoice(v, 'a')).toEqual(['b'])
    expect(removeChoice(v, 'z')).toBe(v)
  })
})

describe('keyboard highlight', () => {
  const rows = [{}, { disabled: true }, {}, {}]
  it('moves down and up, skipping disabled rows, and never wraps', () => {
    expect(nextActiveIndex(rows, -1, 'ArrowDown')).toBe(0)
    expect(nextActiveIndex(rows, 0, 'ArrowDown')).toBe(2)
    expect(nextActiveIndex(rows, 3, 'ArrowDown')).toBe(3)
    expect(nextActiveIndex(rows, 2, 'ArrowUp')).toBe(0)
    expect(nextActiveIndex(rows, 0, 'ArrowUp')).toBe(0)
  })
  it('goes to the ends and pages', () => {
    expect(nextActiveIndex(rows, 2, 'Home')).toBe(0)
    expect(nextActiveIndex(rows, 0, 'End')).toBe(3)
    expect(nextActiveIndex(rows, 0, 'PageDown', 2)).toBe(2)
    expect(nextActiveIndex(rows, 3, 'PageUp', 2)).toBe(0)
  })
  it('answers -1 for an empty list', () => {
    expect(nextActiveIndex([], 0, 'ArrowDown')).toBe(-1)
  })
})

describe('summaries and unknown values', () => {
  it('counts in words', () => {
    const noun = { one: 'product', other: 'products' }
    expect(selectionSummary(0, noun)).toBe('No products selected')
    expect(selectionSummary(1, noun)).toBe('1 product selected')
    expect(selectionSummary(3, noun)).toBe('3 products selected')
  })
  it('shows a value no choice carries as itself, marked unknown, never dropped', () => {
    const chosen = resolveChosen(['gid://c/2', 'gid://gone/9'], colours)
    expect(chosen.map(c => c.label)).toEqual(['Black', 'gid://gone/9'])
    expect(chosen[1].unknown).toBe(true)
    expect(chosen[0].unknown).toBeUndefined()
  })
})
