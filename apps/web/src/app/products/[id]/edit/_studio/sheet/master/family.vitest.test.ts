import { describe, expect, it } from 'vitest'

import { familyAxes, familySize, familyVerbAvailability, summariseFamily, type FamilyResponse } from './family'

const member = (sku: string) => ({ id: sku, sku, name: sku, variantAttributes: null })

const parentOf = (n: number): FamilyResponse => ({
  role: 'parent',
  self: { id: 'p', sku: 'GALE-JACKET', name: 'GALE', isParent: true, parentId: null, variationTheme: 'Colore,Taglia', variationAxes: ['Colore', 'Taglia'] },
  parent: null,
  children: Array.from({ length: n }, (_, i) => member(`GALE-${i}`)),
  siblings: [],
})

const childOf = (siblings: number): FamilyResponse => ({
  role: 'child',
  self: { id: 'c', sku: 'GALE-BLACK-L', name: null, isParent: false, parentId: 'p', variationTheme: null, variationAxes: null },
  parent: { id: 'p', sku: 'GALE-JACKET', name: 'GALE', variationTheme: 'Colore,Taglia' },
  children: [],
  siblings: Array.from({ length: siblings }, (_, i) => member(`GALE-${i}`)),
})

const standalone: FamilyResponse = {
  role: 'standalone',
  self: { id: 's', sku: 'SOLO-1', name: 'Solo', isParent: false, parentId: null, variationTheme: null, variationAxes: null },
  parent: null, children: [], siblings: [],
}

describe('familyAxes', () => {
  it('reads the ARRAY, never the display string', () => {
    expect(familyAxes(parentOf(2))).toEqual(['Colore', 'Taglia'])
    // `variationTheme` is "Colore,Taglia" — a label. Splitting it would invent axes on any product
    // whose theme was written for people rather than for parsing.
    expect(familyAxes({ ...parentOf(2), self: { ...parentOf(2).self, variationAxes: null } })).toEqual([])
  })

  it('drops blank entries rather than rendering an empty axis', () => {
    const f = parentOf(1)
    expect(familyAxes({ ...f, self: { ...f.self, variationAxes: ['Colore', '  ', ''] } })).toEqual(['Colore'])
  })

  it('survives a null family', () => {
    expect(familyAxes(null)).toEqual([])
  })

  it('uses the parent declaration when opened on a child', () => {
    // 🔴 DISCLOSED ADDITION by VP.1 (docs/pes-claims.md), test-only, no source touched. This was the only
    // test of this branch and it lived in `_studio/variants/variants.vitest.test.ts`, which the variants
    // spec §6 deletes. Preserved rather than lost with the file: a child opened directly must read its
    // PARENT's declared axes, not its own — a child that carries a stale `variationAxes` of its own would
    // otherwise render the wrong axis columns for the whole family.
    expect(familyAxes({ role: 'child', self: { variationAxes: ['wrong'] }, parent: { variationAxes: ['finish', 'length'] } } as never)).toEqual(['finish', 'length'])
  })
})

describe('familySize', () => {
  it('counts the parent as one of the rows, because the sheet shows it as one', () => {
    expect(familySize(parentOf(20))).toBe(21)
  })

  it('a child counts its siblings, itself and its parent', () => {
    expect(familySize(childOf(19))).toBe(21)
  })

  it('a standalone is one', () => {
    expect(familySize(standalone)).toBe(1)
    expect(familySize(null)).toBe(0)
  })
})

describe('summariseFamily', () => {
  it('names the axes a parent varies by', () => {
    expect(summariseFamily(parentOf(20))).toMatchObject({ role: 'Parent', detail: '20 children · Colore × Taglia', childless: false })
  })

  it('says "variation" in the singular when there is one', () => {
    expect(summariseFamily(parentOf(1)).detail).toBe('1 child · Colore × Taglia')
  })

  /**
   * 🔴 22 childless parents exist on prod (the EBAY_LISTING_SHELL rows). Drawing one as an ordinary
   * parent above an empty sheet reads as a loading bug; naming the condition is the most useful
   * thing the bar can say about it.
   */
  it('a childless parent SAYS so rather than reading as a loading failure', () => {
    const s = summariseFamily(parentOf(0))
    expect(s.detail).toContain('No children yet')
    expect(s.childless).toBe(true)
  })

  it('a parent with no axes set says that too, rather than showing a dangling separator', () => {
    const f = parentOf(3)
    expect(summariseFamily({ ...f, self: { ...f.self, variationAxes: [] } }).detail).toBe('3 children · no variation axes set')
  })

  it('a variation names its parent and its siblings', () => {
    expect(summariseFamily(childOf(19))).toMatchObject({ role: 'Child', detail: 'of GALE-JACKET · 19 siblings' })
    expect(summariseFamily(childOf(1)).detail).toBe('of GALE-JACKET · 1 sibling')
    expect(summariseFamily(childOf(0)).detail).toBe('of GALE-JACKET · the only child')
  })

  it('a standalone says what it is', () => {
    expect(summariseFamily(standalone)).toMatchObject({ role: 'Standalone product', childless: false })
  })

  it('while loading it says so — never an empty bar and never a guessed role', () => {
    expect(summariseFamily(null).detail).toMatch(/loading/i)
  })
})

describe('familyVerbAvailability — the one verb the registry does not own yet', () => {
  /**
   * 🔴 It answers for `add-variation` and nothing else. promote/attach/unlink/reparent/demote all
   * live in `familyActions` now, and a second copy of their role rules here is the drift the action
   * registry exists to prevent — this test fails if one is ever added back.
   */
  it('answers for add-variation ONLY — no second copy of a registry verb’s rules', () => {
    expect(Object.keys(familyVerbAvailability(parentOf(20)))).toEqual(['add-variation'])
    expect(Object.keys(familyVerbAvailability(standalone))).toEqual(['add-variation'])
  })

  it('a parent may hold variations; anything else is told to promote first', () => {
    expect(familyVerbAvailability(parentOf(20))['add-variation']).toBeNull()
    expect(familyVerbAvailability(standalone)['add-variation']).toMatch(/promote this product first/)
    expect(familyVerbAvailability(childOf(3))['add-variation']).toMatch(/promote this product first/)
  })
})
