import { describe, expect, it } from 'vitest'
import { OTHER_SPECIFICS_GROUP, otherItemSpecificColumns } from './ebay-other-specifics.js'

/**
 * P1 (report 3 I-3.4, report 6 I-8b) — GALE eBay IT stores 19 item specifics and 7 had no column (Genere, Athlete, Body
 * type, Team name…), yet all 19 are published. Each stored specific no category column serves becomes a column.
 */
const label = 'eBay · IT'
const aspect = (name: string) => ({ channels: { [label]: { store: { kind: 'platformAttributes', path: ['itemSpecifics', name] } } } }) as never
const listing = (itemSpecifics: Record<string, unknown>) => ({ platformAttributes: { itemSpecifics } })

describe('otherItemSpecificColumns', () => {
  const columns = otherItemSpecificColumns({ coordinateLabel: label, category: '177104', columns: [aspect('Marca'), aspect('Paese di origine')], listings: [
    listing({ Marca: 'Xavia', Brand: 'Xavia', 'Paese di origine': 'Pakistan', Genere: 'Uomo', Condizione: 'Nuovo', Vuoto: '' }),
    listing({ Genere: 'Donna', Caratteristiche: ['Ventilato', 'Leggero'], 'Team name': null }),
  ] })
  it('serves uncovered stored keys, including an explicit clear, but never the condition or a legacy empty string', () => {
    expect(columns.map(c => c.label)).toEqual(['Caratteristiche', 'Genere', 'Team name'])
  })
  it('a column the ordinary writer can edit and clear: the listing\'s item specific, eBay\'s 65-character limit, one group', () => {
    expect(columns.find(c => c.label === 'Genere')).toMatchObject({ key: 'other_specific_genere', writeField: 'attr_other_specific_genere', storage: 'listing',
      editable: true, shape: 'scalar', maxLength: 65, group: OTHER_SPECIFICS_GROUP.label, groupKey: OTHER_SPECIFICS_GROUP.key,
      channels: { [label]: { store: { kind: 'platformAttributes', path: ['itemSpecifics', 'Genere'] }, cardinality: { min: 0, max: 1 }, categories: ['177104'] } } })
    expect(columns.find(c => c.label === 'Caratteristiche')).toMatchObject({ shape: 'list', cardinality: { min: 0, max: null } })
  })
  it('nothing stored outside the category: no column', () => {
    expect(otherItemSpecificColumns({ coordinateLabel: label, columns: [aspect('Marca')], listings: [listing({ Marca: 'Xavia' }), { platformAttributes: null }] })).toEqual([])
  })
  it('keeps explicit null editable for a new save, while a reset or absent key grants no field', () => {
    const input = { coordinateLabel: label, columns: [] }
    expect(otherItemSpecificColumns({ ...input, listings: [listing({ Genere: null })] }))
      .toEqual([expect.objectContaining({ key: 'other_specific_genere', editable: true })])
    expect(otherItemSpecificColumns({ ...input, listings: [listing({})] })).toEqual([])
  })
})
