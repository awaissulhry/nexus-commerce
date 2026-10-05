import { describe, expect, it } from 'vitest'
import { OTHER_SPECIFICS_GROUP, otherItemSpecificColumns, otherSpecificHeader } from './ebay-other-specifics.js'

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
    expect(columns.map(c => c.channelLabel)).toEqual(['Caratteristiche', 'Genere', 'Team name'])
  })
  it('W3-4: the header is English (capitalised), the help names what eBay receives; key, eBay name and store path unchanged', () => {
    expect(columns.map(c => c.label)).toEqual(['Features', 'Gender', 'Team name'])
    const gender = columns.find(c => c.key === 'other_specific_genere')!
    expect(gender).toMatchObject({ label: 'Gender', channelLabel: 'Genere', channels: { [label]: { label: 'Genere', attribute: 'aspect_Genere', store: { path: ['itemSpecifics', 'Genere'] } } } })
    expect(gender.helpText).toContain('Sent to eBay as "Genere".')
    expect(gender.helpText).not.toContain('no English name')
    // Owner decision 8 — no English name yet: eBay's own name, capitalised, and the note.
    expect(columns.find(c => c.key === 'other_specific_team_name')!.helpText).toMatch(/Sent to eBay as "Team name"\. Nexus has no English name for it yet\.$/)
    expect(otherSpecificHeader('athlete')).toEqual({ label: 'Athlete', english: false })
    expect(otherSpecificHeader('Paese di fabbricazione')).toEqual({ label: 'Country of manufacture', english: true })
  })
  it('a column the ordinary writer can edit and clear: the listing\'s item specific, eBay\'s 65-character limit, one group', () => {
    expect(columns.find(c => c.channelLabel === 'Genere')).toMatchObject({ key: 'other_specific_genere', writeField: 'attr_other_specific_genere', storage: 'listing',
      editable: true, shape: 'scalar', maxLength: 65, group: OTHER_SPECIFICS_GROUP.label, groupKey: OTHER_SPECIFICS_GROUP.key,
      channels: { [label]: { store: { kind: 'platformAttributes', path: ['itemSpecifics', 'Genere'] }, cardinality: { min: 0, max: 1 }, categories: ['177104'] } } })
    expect(columns.find(c => c.channelLabel === 'Caratteristiche')).toMatchObject({ shape: 'list', cardinality: { min: 0, max: null } })
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
