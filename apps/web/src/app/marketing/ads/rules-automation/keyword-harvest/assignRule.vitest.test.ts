/**
 * Ads fix 5d (review 7.11) — "+ Assign rule" refuses to narrow an account-wide harvest rule.
 *
 * The engine reads any mapping as the rule's whole reach, so a look-only entry added to a rule that
 * mapped nothing limited it to one ad group, where it created nothing.
 */
import { describe, expect, it } from 'vitest'
import { accountWideRefusal, assignOptions, assignSource, isAccountWide } from './assignRule'

const ROW = { key: 'ag-new', adGroup: 'GALE AUTO IT', campaignId: 'c-auto', campaign: 'GALE AUTO IT' }
const MAPPED = [{ groups: [
  { id: 'ag-src', look: true, types: { P: false, E: false, product: false } },
  { id: 'ag-exact', look: false, types: { P: false, E: true, product: false } },
] }]

describe('isAccountWide', () => {
  it('a rule that maps no ad group is account-wide; one entry makes it mapped', () => {
    expect(isAccountWide(undefined)).toBe(true)
    expect(isAccountWide([])).toBe(true)
    expect(isAccountWide([{ groups: [] }])).toBe(true)
    expect(isAccountWide(MAPPED)).toBe(false)
  })
})

describe('assignSource', () => {
  it('refuses an account-wide rule and says why, leaving it untouched', () => {
    const r = assignSource('Harvest proven winners — GALE DE', [], ROW)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('harvests across the whole account')
      expect(r.reason).toContain('GALE AUTO IT')
      expect(r.reason).toContain('create nothing')
    }
  })

  it('adds a look-only source to a mapped rule, beside its destinations, without touching the input', () => {
    const input = structuredClone(MAPPED)
    const r = assignSource('Harvest GALE IT', input, ROW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const groups = r.mappings[0].groups!
      expect(groups.map((g) => g.id)).toEqual(['ag-src', 'ag-exact', 'ag-new'])
      expect(groups[2]).toMatchObject({ look: true, types: { P: false, E: false, product: false } })
    }
    expect(input[0].groups).toHaveLength(2)
  })

  it('joins the first mapping that has entries, not an empty one before it', () => {
    const r = assignSource('Harvest GALE IT', [{ groups: [] }, ...MAPPED], ROW)
    expect(r.ok && r.mappings[0].groups).toEqual([])
    expect(r.ok && r.mappings[1].groups!.map((g) => g.id)).toContain('ag-new')
  })

  it('assigning twice adds the ad group once', () => {
    const once = assignSource('Harvest GALE IT', MAPPED, ROW)
    const twice = once.ok ? assignSource('Harvest GALE IT', once.mappings, ROW) : once
    expect(twice.ok && twice.mappings[0].groups!.filter((g) => g.id === 'ag-new')).toHaveLength(1)
  })
})

describe('assignOptions', () => {
  const rules = [
    { id: 'r-wide', name: 'Harvest proven winners — GALE DE', actions: [{ type: 'keyword-harvesting' }] },
    { id: 'r-mapped', name: 'Harvest GALE IT', actions: [{ type: 'keyword-harvesting', mappings: MAPPED }] },
    { id: 'r-here', name: 'Already here', actions: [{ type: 'keyword-harvesting', mappings: MAPPED }] },
    { id: 'r-engine', name: 'Auto harvest & negate', actions: [{ type: 'harvest_and_negate' }] },
  ]

  it('lists an account-wide rule disabled with the reason, a mapped one enabled, and skips the rest', () => {
    const opts = assignOptions(rules, ROW, new Set(['r-here']))
    expect(opts.map((o) => o.value)).toEqual(['r-wide', 'r-mapped'])
    expect(opts[0]).toMatchObject({ disabled: true, trailing: 'whole account', title: accountWideRefusal('Harvest proven winners — GALE DE', 'GALE AUTO IT') })
    expect(opts[1].disabled).toBeUndefined()
  })
})
