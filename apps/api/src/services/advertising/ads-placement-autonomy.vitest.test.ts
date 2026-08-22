/**
 * D-PLC-2 — a Placement rule may not be armed to AUTO against the rank engine.
 *
 * The verdict is pure and tested here without a database, because the part that matters to an
 * operator is the SENTENCE: a refusal that does not say what to do instead is the silent-refusal
 * defect wearing a different hat.
 */
import { describe, expect, it } from 'vitest'
import { placementAutoVerdict, ENGINE_CONTESTED_LANES, placementLanesOf } from './ads-placement-autonomy.js'

const TOP = 'PLACEMENT_TOP'
const REST = 'PLACEMENT_REST_OF_SEARCH'
const PDP = 'PLACEMENT_PRODUCT_PAGE'

describe('which lanes the engine contests', () => {
  it('🔴 Product Pages is NOT contested — 2 engine writes in 30 days against 12,197 on Top of Search', () => {
    expect(ENGINE_CONTESTED_LANES).toContain(TOP)
    expect(ENGINE_CONTESTED_LANES).toContain(REST)
    expect(ENGINE_CONTESTED_LANES).not.toContain(PDP)
  })
})

describe('the verdict', () => {
  it('refuses a Top of Search rule on a governed campaign', () => {
    const v = placementAutoVerdict([TOP], ['GALE BROAD IT'])
    expect(v.blocked).toBe(true)
    expect(v.message).toContain('Top of Search')
    expect(v.message).toContain('GALE BROAD IT')
  })

  it('🔴 ALLOWS a Product Pages rule on the same governed campaign — the exception is the point', () => {
    const v = placementAutoVerdict([PDP], ['GALE BROAD IT'])
    expect(v.blocked).toBe(false)
  })

  it('allows a contested lane when NO campaign is governed', () => {
    expect(placementAutoVerdict([TOP, REST], []).blocked).toBe(false)
  })

  it('refuses a multi-block rule if ANY block writes a contested lane', () => {
    // one block on Product Pages, one on Rest of Search: the second is a write loop on its own
    expect(placementAutoVerdict([PDP, REST], ['X']).blocked).toBe(true)
  })

  it('names both lanes when the rule writes both', () => {
    const v = placementAutoVerdict([TOP, REST], ['X'])
    expect(v.message).toContain('Top of Search and Rest of Search')
    expect(v.message).toContain('those lanes')
  })

  describe('the sentence has to be actionable, not just correct', () => {
    const v = placementAutoVerdict([TOP], ['A', 'B', 'C', 'D', 'E'])
    it('says WHY, in terms of what the operator will observe', () => {
      expect(v.message).toMatch(/reverted within the hour/)
    })
    it('offers BOTH ways out — the mode, and the picker', () => {
      expect(v.message).toMatch(/Manual/)
      expect(v.message).toMatch(/remove those campaigns/)
    })
    it('names the lane that WOULD work rather than leaving a dead end', () => {
      expect(v.message).toContain('Product Pages')
    })
    it('names a few campaigns and counts the rest, instead of printing all of them', () => {
      expect(v.message).toContain('A, B, C')
      expect(v.message).toContain('and 2 more')
    })
    it('gets the singular right for one campaign', () => {
      const one = placementAutoVerdict([TOP], ['Solo'])
      expect(one.message).toContain('1 campaign that')
      expect(one.message).toContain('remove that campaign')
    })
  })
})

describe('placementLanesOf', () => {
  it('reads the lane an engine-native rule carries on its action', () => {
    expect(placementLanesOf({ id: 'r', actions: [{ type: 'placement_apply', placement: REST }] })).toEqual([REST])
  })
  it('returns nothing for a rule that names no lane, rather than guessing Top of Search', () => {
    expect(placementLanesOf({ id: 'r', actions: [{ type: 'budget_apply' }] })).toEqual([])
  })
})
