/**
 * PLC-P3 — the defect: three placement rules rendered ONE string.
 *
 * Measured before this change: `Top of Search Set to 50%`, `Product Pages Set to 50%` and
 * `Rest of Search Set to 50%` all came out of the grid's Criteria cell as `Set 50%`, because
 * `summariseRule` never read `placeTarget` — and its local `BuilderGroup` interface declared the
 * field as `target`, a name the stored shape does not use, so it was unreadable by construction.
 */
import { describe, expect, it } from 'vitest'
import { PLACEMENT_LANES, placementLaneLabel, placementThenSentence } from './placementLanes'

describe('placementLaneLabel', () => {
  it('names all three lanes in the operator’s words, never an enum', () => {
    expect(PLACEMENT_LANES.map((l) => l.label)).toEqual(['Top of Search', 'Product Pages', 'Rest of Search'])
    expect(placementLaneLabel('tos')).toBe('Top of Search')
    expect(placementLaneLabel('pdp')).toBe('Product Pages')
    expect(placementLaneLabel('ros')).toBe('Rest of Search')
  })

  it('a MISSING lane takes the builder’s own default, because that is what the engine acts on', () => {
    expect(placementLaneLabel(undefined)).toBe('Top of Search')
    expect(placementLaneLabel(null)).toBe('Top of Search')
    expect(placementLaneLabel('')).toBe('Top of Search')
  })

  it('🔴 an UNKNOWN lane returns the raw key — it never invents Top of Search', () => {
    // Inventing a lane over a value nobody recognises puts a confident wrong answer in the one
    // cell that decides what the rule does. Echoing it is visibly odd, which is the point.
    expect(placementLaneLabel('PLACEMENT_TOP')).toBe('PLACEMENT_TOP')
    expect(placementLaneLabel('sponsored-brands-top')).toBe('sponsored-brands-top')
  })
})

describe('placementThenSentence — three lanes must read as three rules', () => {
  it('🔴 the same op and value on three lanes produces three DIFFERENT strings', () => {
    const said = PLACEMENT_LANES.map((l) => placementThenSentence('set', '50', l.value))
    expect(said).toEqual([
      'Set Top of Search to 50%',
      'Set Product Pages to 50%',
      'Set Rest of Search to 50%',
    ])
    expect(new Set(said).size).toBe(3)
  })

  it('every op names its lane, so no op can reintroduce the collision', () => {
    for (const op of ['set', 'incPct', 'decPct', 'somethingNobodyHasTaughtItYet']) {
      const said = PLACEMENT_LANES.map((l) => placementThenSentence(op, '20', l.value))
      expect(new Set(said).size, `op "${op}" collapsed its three lanes into ${new Set(said).size}`).toBe(3)
      for (const s of said) expect(s).toMatch(/Top of Search|Product Pages|Rest of Search/)
    }
  })

  it('reads as English, not as arithmetic', () => {
    expect(placementThenSentence('incPct', '20', 'tos')).toBe('Increase Top of Search by 20%')
    expect(placementThenSentence('decPct', '20', 'ros')).toBe('Decrease Rest of Search by 20%')
    // never a bare verb glyph beside a number — "−20%" is the cell an operator has to decode
    expect(placementThenSentence('decPct', '20', 'ros')).not.toMatch(/^[+−-]/)
  })

  it('always carries a unit — a placement modifier with no % is a number to guess at', () => {
    for (const l of PLACEMENT_LANES) expect(placementThenSentence('set', '0', l.value)).toContain('%')
  })
})
