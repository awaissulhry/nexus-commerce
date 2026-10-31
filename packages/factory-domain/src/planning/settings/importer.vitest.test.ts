import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import { isBlankRow, parseRow, planner, type SheetRow } from '../../imports/plan'
import { EMPTY_ITEM_PLANNING, type ItemPlanningValues } from './items'
import { importRecordValues, itemParametersImporter, planItemParametersRow } from './importer'

/** Made-up sites, materials, colours and suppliers, as an Italian planner writes the sheet. */
const context = { numberFormat: 'it' as const }
const HEADER = ['Sito', 'Articolo', 'Colore', 'Metodo', 'Origine', 'Fornitore', 'Lead time acquisto', 'Scorta di sicurezza', 'Punto di riordino', 'Lotto', 'Scorta minima', 'Scorta massima', 'Nota']

function plan(rows: (string | number | null)[][], records: Record<string, ItemPlanningValues> = {}) {
  const mapping = mapHeaders(itemParametersImporter.columns, HEADER)
  expect(mapping.issues).toEqual([])
  const sheet: SheetRow[] = rows.map((cells, index) => ({ rowNumber: index + 2, cells }))
  const parsed = sheet.filter((row) => !isBlankRow(row)).map((row) => parseRow(itemParametersImporter, mapping.columns, row, context))
  return planner(itemParametersImporter).plan(parsed, new Map(Object.entries(records).map(([key, values], index) => [key, { id: `0195f5d0-0000-7000-8000-00000000000${index}`, values: importRecordValues(values) }])))
}

describe('the item parameters import (B-W2b-20)', () => {
  it('reads the Italian headers and words, the colour * for every colour, and plans a new row per method', () => {
    const rows = plan([
      ['a1', 'pl-01', 'tutti', 'ordini', 'acquisto', 'for-01', 14, '2,5', null, null, null, null, 'Pelle per ogni giacca'],
      ['A1', 'PRO-03', '*', 'punto di riordino', null, null, null, '12', '24', '48', null, null, null],
      ['A1', 'FOD-02', 'gri', 'min max', null, null, null, null, null, null, '50', '300', null],
      ['A1', 'ETI-09', 'NER', 'manuale', 'produzione', null, null, null, null, null, null, null, null],
    ])
    expect(rows.map((row) => [row.action, row.key])).toEqual([
      ['CREATE', '["A1","PL-01","*"]'],
      ['CREATE', '["A1","PRO-03","*"]'],
      ['CREATE', '["A1","FOD-02","GRI"]'],
      ['CREATE', '["A1","ETI-09","NER"]'],
    ])
    expect(rows[0]!.after).toEqual({ site: 'A1', item: 'PL-01', colour: '*', method: 'ORDERS', source: 'BUY', supplier: 'FOR-01', buyLeadTimeDays: 14, safetyStock: '2.5', note: 'Pelle per ogni giacca' })
    expect(rows[1]!.after).toMatchObject({ method: 'REORDER_POINT', safetyStock: '12', reorderPoint: '24', lotSize: '48' })
    expect(rows[2]!.after).toMatchObject({ method: 'MIN_MAX', minStock: '50', maxStock: '300' })
  })

  it('refuses a method it does not know, a reorder point without a lot size, a supplier without BUY, and the same key twice', () => {
    const rows = plan([
      ['A1', 'PL-01', '*', 'a occhio', null, null, null, null, null, null, null, null, null],
      ['A1', 'PRO-03', '*', 'REORDER_POINT', null, null, null, null, '24', null, null, null, null],
      ['A1', 'FOD-02', 'GRI', null, 'MAKE', 'FOR-01', null, null, null, null, null, null, null],
      ['A1', 'FOD-03', 'GRI', 'MIN_MAX', null, null, null, null, null, null, '300', '50', null],
      ['A1', 'PL-01', 'tutti i colori', null, null, null, null, '1', null, null, null, null, null],
      ['A1', 'PL-01', 'NERO SCURO', null, null, null, null, '1', null, null, null, null, null],
      ['A1', 'FOD-02', 'gri', 'MANUAL', null, null, null, null, null, null, null, null, null],
    ])
    expect(rows.map((row) => row.action)).toEqual(['ERROR', 'ERROR', 'ERROR', 'ERROR', 'CREATE', 'ERROR', 'ERROR'])
    expect(rows[0]!.errors).toEqual([{ column: 'method', message: 'Expected one of ORDERS, REORDER_POINT, MIN_MAX, MANUAL.' }])
    expect(rows[1]!.errors).toEqual([{ column: 'lotSize', message: 'A reorder-point rule needs the lot size: how much to order each time.' }])
    expect(rows[2]!.errors).toEqual([{ column: 'supplier', message: 'A preferred supplier goes with an item bought here (source BUY).' }])
    expect(rows[3]!.errors).toEqual([{ column: 'maxStock', message: 'The maximum stock (50) is above the minimum (300).' }])
    // The first PL-01 row was an error, so the key is still free; the colour "NERO SCURO" has a space.
    expect(rows[5]!.errors).toEqual([{ column: 'colour', message: 'A colour code has no spaces (write * for every colour).' }])
    expect(rows[6]!.errors).toEqual([{ message: 'The same Site and Item and Colour as row 4; only the first one is imported.' }])
  })

  it('changes only the cells that differ (quantities by value), clears what a method change clears, and says UNCHANGED', () => {
    const stored: ItemPlanningValues = { ...EMPTY_ITEM_PLANNING, method: 'MIN_MAX', source: 'BUY', supplierId: 'FOR-01', buyLeadTimeDays: 10, minStock: '50.0000', maxStock: '300.0000' }
    const rows = plan(
      [
        ['A1', 'FOD-02', 'GRI', 'MIN_MAX', 'BUY', 'FOR-01', 10, null, null, null, '50', '300', null],
        ['A1', 'PL-01', '*', 'REORDER_POINT', null, null, 12, null, '24', '48', null, null, null],
        ['A1', 'PRO-03', '*', null, 'articolo', null, null, null, null, null, null, null, null],
      ],
      { '["A1","FOD-02","GRI"]': stored, '["A1","PL-01","*"]': stored, '["A1","PRO-03","*"]': stored },
    )
    expect(rows.map((row) => row.action)).toEqual(['UNCHANGED', 'UPDATE', 'UPDATE'])
    expect(rows[1]).toMatchObject({
      before: { method: 'MIN_MAX', buyLeadTimeDays: 10, reorderPoint: null, lotSize: null, minStock: '50.0000', maxStock: '300.0000' },
      after: { method: 'REORDER_POINT', buyLeadTimeDays: 12, reorderPoint: '24', lotSize: '48' },
    })
    // ITEM = follow the item's own sourcing: the source and the BUY supplier go.
    expect(rows[2]).toMatchObject({ before: { source: 'BUY', supplier: 'FOR-01' }, after: { source: 'ITEM' } })
  })

  it('plans a row against a stored one whose source is none as ITEM', () => {
    const stored: ItemPlanningValues = { ...EMPTY_ITEM_PLANNING }
    expect(planItemParametersRow({ site: 'A1', item: 'PL-01', colour: '*', source: 'ITEM' }, { id: 'x', values: importRecordValues(stored) })).toEqual({ action: 'UNCHANGED' })
  })
})
