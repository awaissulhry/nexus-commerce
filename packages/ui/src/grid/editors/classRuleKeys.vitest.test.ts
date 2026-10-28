/**
 * 🔴 THE THREE CLASS-RULE SETS A SHEET SPREADS TOGETHER MUST NOT SHARE A KEY.
 *
 * Found the hard way on 2026-09-04: `provenanceClassRules` gained `nds-cell-is-refused` for a
 * refused FORMULA while `roundTripClassRules` had owned that exact key for a rejected SAVE since
 * the round-trip work. Master spreads `…prov, …rt` and the channel spreads them the other way, so
 * the same cell rendered the tint on one scope and not the other, and every part in isolation was
 * correct — the reader, the classifier, the rule function — because the defect was in the SPREAD:
 * the later object silently won. Four instruments and most of an afternoon.
 *
 * A shared key across these sets is never a legitimate design; it is always two mechanisms that
 * both believe they own a class. So the sets are asserted pairwise disjoint here, with stub inputs,
 * in node, where it costs nothing and fails before anyone spreads them.
 */
import { describe, expect, it } from 'vitest'

import { provenanceClassRules } from '../renderers/provenance'
import { roundTripClassRules, CellSaveTracker } from './roundTrip'
import { sheetClassRules } from './sheet'

type Row = { id: string }

describe('cell class-rule sets are pairwise disjoint', () => {
  const prov = Object.keys(provenanceClassRules<Row>(() => 'own'))
  const rt = Object.keys(roundTripClassRules<Row>(new CellSaveTracker(), (r) => r.id))
  const sheet = Object.keys(sheetClassRules<Row>({ validate: () => ({ level: null }) }))

  const overlap = (a: string[], b: string[]) => a.filter((k) => b.includes(k))

  it('provenance vs round-trip — the collision that shipped', () => {
    expect(overlap(prov, rt)).toEqual([])
  })
  it('provenance vs sheet validation', () => {
    expect(overlap(prov, sheet)).toEqual([])
  })
  it('round-trip vs sheet validation', () => {
    expect(overlap(rt, sheet)).toEqual([])
  })

  /* The denominator, so a set that came back empty (a stub that broke a constructor) cannot pass
     the disjointness vacuously. Each set must still be a set. */
  it('every set is non-empty and carries the class this suite is about', () => {
    expect(prov.length).toBeGreaterThan(3)
    expect(rt.length).toBeGreaterThan(1)
    expect(sheet.length).toBeGreaterThan(1)
    expect(prov).toContain('nds-cell-is-formula-refused')
    expect(rt).toContain('nds-cell-is-refused')
  })
})
