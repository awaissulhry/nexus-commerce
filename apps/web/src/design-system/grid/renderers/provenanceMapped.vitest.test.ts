import { describe, expect, it } from 'vitest'

import { classifyProvenance, provenanceTooltip, provenanceClassRules } from './provenance'

/*
 * §9.6 — the derived-value marks (hub #351/#355).
 *
 * The PRECEDENCE is the ruling, not a detail: `ai` > `mappedShared` > `mapped` > the existing chain.
 * The rule that fixes it — and the one these tests really defend — is that **precedence is by which
 * fact most changes the NEXT ACTION**, not by which claim is weakest.
 */
const mapped = { status: 'mapped' }

describe('§9.6 — a derived value is marked, and only when it IS one', () => {
  it('shows a stored listing override as pinned even when it passed through the mapping resolver', () => {
    expect(classifyProvenance({ mapped: { status: 'mapped', provenance: 'override' }, layer: 'channel', pinned: true }, 'channel')).toBe('pinned')
  })
  it('marks a cell the mapping engine derived', () => {
    expect(classifyProvenance({ mapped })).toBe('mapped')
  })

  it('🔴 does NOT mark `status: unmapped` — the engine RAN and matched nothing', () => {
    // Presence of the object is not derivation. Marking this would tell an operator a rule decides
    // this cell when no rule matched it. (I first modelled the input as a boolean, which would have
    // marked exactly this case; the compiler refused it against the real contract.)
    expect(classifyProvenance({ mapped: { status: 'unmapped' } })).toBe('own')
    expect(classifyProvenance({ mapped: null })).toBe('own')
    expect(classifyProvenance({})).toBe('own')
  })

  it('🔴 marks the PRODUCT-grain case separately — editing one alias changes them all', () => {
    expect(classifyProvenance({ mapped, mappedProductLevel: true })).toBe('mappedShared')
  })

  it('product-grain says nothing about a cell no rule produced', () => {
    // The flag is a fact about the RUN. Without a derived value there is no shared value to warn of.
    expect(classifyProvenance({ mappedProductLevel: true })).toBe('own')
    expect(classifyProvenance({ mapped: { status: 'unmapped' }, mappedProductLevel: true })).toBe('own')
  })
})

describe('§9.6 — precedence, which is the ruling', () => {
  it('🔴 an AI draft outranks a derived value — it demands a decision', () => {
    expect(classifyProvenance({ mapped, aiDrafted: true })).toBe('ai')
    expect(classifyProvenance({ mapped, aiDrafted: true, aiStale: true })).toBe('aiStale')
    expect(classifyProvenance({ mapped, mappedProductLevel: true, aiDrafted: true })).toBe('ai')
  })

  it('🔴 a derived value outranks INHERITED — the click that changes it is the rule, not the cell', () => {
    // Drawing this 🔗 would promise that reset returns the master's value. What is on screen was
    // never the master's value — it is a function of it. `inheritedOverride`'s defect shape (#16).
    expect(classifyProvenance({ mapped, inherited: true, layer: 'master' })).toBe('mapped')
    expect(classifyProvenance({ mapped, inherited: true, inheritedFrom: 'p1' })).toBe('mapped')
  })

  it('a derived value outranks PINNED for the same reason', () => {
    expect(classifyProvenance({ mapped, pinned: true, layer: 'variant' })).toBe('mapped')
  })

  it('product-grain outranks plain derived — editing one row changes N', () => {
    expect(classifyProvenance({ mapped, mappedProductLevel: true, inherited: true })).toBe('mappedShared')
  })

  it('§9.6b — the vocabulary does NOT multiply by layers × sources', () => {
    // "mapped-from-inherited" and "mapped-from-pinned" are the same member: in both, the cell is
    // not the place. A combination earns its own member only when it changes where the next click
    // lands — which is why `inheritedOverride` has one and these do not.
    expect(classifyProvenance({ mapped, inherited: true })).toBe(classifyProvenance({ mapped, pinned: true }))
  })
})

describe('§9.6 — the wording names the source and says where the value is decided', () => {
  it('names the source when there is one, and stays correct without it', () => {
    expect(provenanceTooltip('mapped', 'Amazon · IT')).toContain('Amazon · IT')
    expect(provenanceTooltip('mapped', 'Amazon · IT')).toBe('Derived by a mapping rule from Amazon · IT')
    expect(provenanceTooltip('mapped')).toBe('Derived by a mapping rule')
  })

  it('🔴 the shared mark always states the CONSEQUENCE of editing', () => {
    // Without it, N identical rows assert N independent resolutions when there was one.
    for (const from of ['Amazon · IT', undefined]) {
      expect(provenanceTooltip('mappedShared', from)).toMatch(/editing one changes all of them/)
    }
  })

  it('every member has a wording — a new member must not fall through to empty', () => {
    const all = ['inherited', 'inheritedOverride', 'pinned', 'ai', 'aiStale', 'mapped', 'mappedShared'] as const
    for (const p of all) expect(provenanceTooltip(p), p).not.toBe('')
  })
})

describe('§9.6 — the cell classes', () => {
  const rules = provenanceClassRules<{ p: string }>((d) => d.p as never)
  const at = (p: string) => ({ data: { p }, colDef: { colId: 'c' } })

  it('both derived states carry the base class; only the shared one carries the modifier', () => {
    expect(rules['nds-cell-is-mapped'](at('mapped'))).toBe(true)
    expect(rules['nds-cell-is-mapped'](at('mappedShared'))).toBe(true)
    expect(rules['nds-cell-is-mapped-shared'](at('mapped'))).toBe(false)
    expect(rules['nds-cell-is-mapped-shared'](at('mappedShared'))).toBe(true)
  })

  it('does not tint an ordinary cell', () => {
    expect(rules['nds-cell-is-mapped'](at('own'))).toBe(false)
    expect(rules['nds-cell-is-inherited'](at('mapped'))).toBe(false)
  })
})
