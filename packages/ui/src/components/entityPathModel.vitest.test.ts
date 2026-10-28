import { describe, expect, it } from 'vitest'

import { compareEntityPath, entityPathPlace, entityPathSteps, entityPathText } from './entityPathModel'

const p = { id: 'p1', name: 'Jackets', href: '/p/1' }
const c = { id: 'c1', name: 'Jackets Exact' }
const g = { id: 'g1', name: 'Exact group', href: '/g/1' }

describe('entityPathModel (H7)', () => {
  it('keeps the steps that exist, top first: a missing portfolio is left out, not a blank between arrows', () => {
    expect(entityPathSteps([null, c, g])).toEqual([c, g])
    expect(entityPathSteps([p, { id: 'x', name: '  ' }, g])).toEqual([p, g])
    expect(entityPathSteps(undefined)).toEqual([])
  })
  it('the CSV / clipboard / hover text is "A › B › C"; empty is ""', () => {
    expect(entityPathText([p, c, g])).toBe('Jackets › Jackets Exact › Exact group')
    expect(entityPathText([undefined, c])).toBe('Jackets Exact')
    expect(entityPathText(null)).toBe('')
  })
  it('the middle steps are the ones cut first', () => {
    expect([0, 1, 2].map((i) => entityPathPlace(i, 3))).toEqual(['first', 'middle', 'last'])
    expect(entityPathPlace(0, 1)).toBe('only')
    expect([0, 1].map((i) => entityPathPlace(i, 2))).toEqual(['first', 'last'])
  })
  it('sorts by the whole path; an empty path first', () => {
    expect(compareEntityPath([], [c])).toBeLessThan(0)
    expect(compareEntityPath([p, c], [p, g])).toBeGreaterThan(0)
  })
})
