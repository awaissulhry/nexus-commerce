import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import { isBlankRow, parseRow, planner, type SheetRow } from '../../imports/plan'
import { BOM_COLUMNS, bomImporter, exportedValues, lineRecordValues, pairsOf, type ExportedLine } from './importer'
import { bomPaper } from './paper'

/** Made-up styles, materials and colour codes, as an Italian office writes a BOM sheet. */
const context = { numberFormat: 'it' as const }
const LEATHER: ExportedLine = {
  style: 'GT-01',
  seq: 10,
  material: 'PL-01',
  placement: 'Outer shell',
  qty: '45',
  uom: 'FT2',
  wastagePct: '12',
  sizeDependent: true,
  sizes: [
    { size: '50', qty: '43.5' },
    { size: '52', qty: '45' },
  ],
  colourDependent: true,
  colours: [
    { colourway: 'BLK', colour: 'NER' },
    { colourway: 'RED', colour: 'ROS' },
  ],
  colour: null,
  colourway: null,
  supplier: null,
  note: null,
}
const LINING: ExportedLine = { ...LEATHER, seq: 20, material: 'FOD-01', placement: 'Body lining', qty: '1.8', uom: 'M', wastagePct: '5', sizeDependent: false, sizes: [], colourDependent: false, colours: [], colour: 'GRI', supplier: 'P2', note: 'Cut on the bias' }

function plan(headers: string[], rows: (string | number | boolean | null)[][], records: Record<string, ExportedLine> = {}) {
  const mapping = mapHeaders(bomImporter.columns, headers)
  expect(mapping.issues).toEqual([])
  const sheet: SheetRow[] = rows.map((cells, index) => ({ rowNumber: index + 2, cells }))
  const parsed = sheet.filter((row) => !isBlankRow(row)).map((row) => parseRow(bomImporter, mapping.columns, row, context))
  return planner(bomImporter).plan(parsed, new Map(Object.entries(records).map(([key, line]) => [key, { id: `0195f5d0-0000-7000-8000-0000000000${line.seq}`, values: lineRecordValues(line) }])))
}

describe('the BOM import (PRD-090)', () => {
  it('maps Italian headers; style and place are the key; no column carries money', () => {
    const mapping = mapHeaders(bomImporter.columns, ['Modello', 'Pos', 'Materiale', 'Q.tà', 'UM', 'Sfrido %', 'Per taglia', 'Quantità per taglia', 'Colore', 'Fornitore', 'Altro'])
    expect(mapping.columns.map((entry) => entry.column)).toEqual(['style', 'seq', 'material', 'qty', 'uom', 'wastagePct', 'sizeDependent', 'sizes', 'colour', 'supplier'])
    expect(mapping.ignored.map((entry) => entry.header)).toEqual(['Altro'])
    expect(bomImporter.keyColumns).toEqual(['style', 'seq'])
    expect(Object.values(bomImporter.columns).some((column) => 'grain' in column)).toBe(false)
  })

  it('reads quantities by size in the Italian number format and colours by colourway, canonically', () => {
    const [row] = plan(['Modello', 'Pos', 'Materiale', 'UM', 'Per taglia', 'Quantità per taglia', 'Per variante', 'Colore per variante'], [['gt-01', 30, 'pl-01', 'piedi quadri', 'sì', '50=43,5; 52 = 45', 'si', 'blk=ner|red:ros']])
    expect(row).toMatchObject({ action: 'CREATE', after: { style: 'GT-01', seq: 30, material: 'PL-01', uom: 'FT2', sizeDependent: true, sizes: '50=43.5;52=45', colourDependent: true, colours: 'BLK=NER;RED=ROS' } })
  })

  it('refuses a size listed twice, a negative quantity, quantities by size on a line that is not by size, and a new line without a material', () => {
    const rows = plan(
      ['Modello', 'Pos', 'Materiale', 'Per taglia', 'Quantità per taglia', 'Q.tà'],
      [
        ['GT-01', 30, 'PL-01', 'sì', '50=1; 50=2', null],
        ['GT-01', 40, 'PL-01', 'sì', '50=-1', null],
        ['GT-01', 50, 'PL-01', 'no', '50=1', null],
        ['GT-01', 60, null, null, null, '2'],
      ],
    )
    expect(rows.map((row) => row.action)).toEqual(['ERROR', 'ERROR', 'ERROR', 'ERROR'])
    expect(rows[0]).toMatchObject({ errors: [{ column: 'sizes', message: '50 is listed twice.' }] })
    expect(rows[1]).toMatchObject({ errors: [{ column: 'sizes' }] })
    expect(rows[2]).toMatchObject({ errors: [{ column: 'sizes' }] })
    expect(rows[3]).toMatchObject({ errors: [{ column: 'material', message: 'Material is needed for a new line.' }] })
  })

  it('an exported BOM imported again changes nothing; an edited cell is the only change (pairs compared as sets)', () => {
    const header = BOM_COLUMNS.map((column) => bomImporter.columns[column].label)
    const sheetRow = (line: ExportedLine) => {
      const values = exportedValues(line, 'it')
      return BOM_COLUMNS.map((column) => {
        const value = values[column]
        if (value === undefined) return null
        if (typeof value === 'boolean') return value ? 'sì' : 'no'
        return column === 'qty' || column === 'wastagePct' ? String(value).replace('.', ',') : value
      })
    }
    const records = { [JSON.stringify(['GT-01', 10])]: LEATHER, [JSON.stringify(['GT-01', 20])]: LINING }
    const same = plan(header, [sheetRow(LEATHER), sheetRow(LINING)], records)
    expect(same.map((row) => row.action)).toEqual(['UNCHANGED', 'UNCHANGED'])

    const reordered = { ...LEATHER, sizes: [...LEATHER.sizes].reverse(), colours: [...LEATHER.colours].reverse() }
    expect(plan(header, [sheetRow(reordered)], records)[0]!.action).toBe('UNCHANGED')

    const edited = plan(header, [sheetRow({ ...LEATHER, wastagePct: '15', sizes: [{ size: '50', qty: '44' }, { size: '52', qty: '45' }] })], records)[0]!
    expect(edited).toMatchObject({ action: 'UPDATE', before: { wastagePct: '12', sizes: '50=43.5;52=45' }, after: { wastagePct: '15', sizes: '50=44;52=45' } })
  })

  it('reads the pairs back', () => {
    expect([...pairsOf('50=43.5;52=45')]).toEqual([
      ['50', '43.5'],
      ['52', '45'],
    ])
  })
})

describe('the BOM sheet (PDF)', () => {
  it('lists the lines in BOM order in the paper language, quantities by size and colours by colourway in words', () => {
    const paper = bomPaper({
      style: { code: 'GT-01', name: 'Giacca' },
      revision: { revision: 2, status: 'DRAFT' },
      sizes: ['50', '52'],
      lines: [
        { ...LINING, materialName: 'Fodera' },
        { ...LEATHER, materialName: 'Nappa' },
      ],
      printedAt: new Date('2026-10-30T09:00:00Z'),
      language: 'it',
    })
    expect(paper.title).toBe('Distinta base GT-01')
    expect(paper.facts.find((fact) => fact.label === 'Stato')?.value).toBe('bozza')
    expect(paper.rows.map((row) => row[0])).toEqual(['10', '20'])
    expect(paper.rows[0]).toEqual(['10', 'PL-01 · Nappa', 'Outer shell', 'per taglia: 50 43,5 · 52 45', 'ft²', '12', 'per variante: BLK NER · RED ROS', '', '', ''])
    expect(paper.rows[1]![3]).toBe('1,8')
    expect(paper.columns.reduce((sum, column) => sum + column.width, 0)).toBe(1000)
    expect(paper.fileName).toBe('bom-GT-01-rev2.pdf')
  })
})
