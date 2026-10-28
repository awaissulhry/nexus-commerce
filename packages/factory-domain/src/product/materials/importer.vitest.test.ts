import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import { applyCheck, isBlankRow, parseRow, planner, type SheetRow } from '../../imports/plan'
import { normaliseColour } from './colours'
import { importRecordValues, materialImporter, type ImportedMaterial } from './importer'
import { newMaterial, type MaterialFields } from './rules'

/** A made-up sheet as an Italian office writes it; nothing here is a real article or supplier. */
const HEADERS = ['Codice', 'Descrizione', 'Tipo', 'UM', 'UM acquisto', 'Fattore acquisto', 'UM consumo', 'Specie', 'Concia', 'Scelta', 'Spessore da', 'Spessore a', 'Test cromo VI', 'Limite Cr6', 'Colori', 'Costo standard', 'Note']
const context = { numberFormat: 'it' as const }

const leather = (() => {
  const outcome = newMaterial({
    code: 'PL-01', name: 'Nappa', kind: 'LEATHER', baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'DM2',
    animalSpecies: 'bovine', tannage: 'CHROME', grade: 'A', thicknessMinMm: '1.1', thicknessMaxMm: '1.3', requiresCrViTest: true, crViLimitMgKg: '3',
  })
  if (!outcome.ok) throw new Error('fixture')
  return outcome.material
})()

const existing = (fields: MaterialFields, more: Partial<ImportedMaterial> = {}) => ({
  id: '0195f5d0-0000-7000-8000-000000000010',
  values: importRecordValues({ fields, status: 'ACTIVE', foreign: false, colours: [normaliseColour({ code: 'NER', name: 'Nero' })], standardCost: '2.4', ...more }),
})

function plan(rows: (string | number | boolean | null)[][], records: Record<string, ReturnType<typeof existing>> = {}) {
  const mapping = mapHeaders(materialImporter.columns, HEADERS)
  expect(mapping.issues).toEqual([])
  const sheet: SheetRow[] = rows.map((cells, index) => ({ rowNumber: index + 2, cells }))
  const parsed = sheet.filter((row) => !isBlankRow(row)).map((row) => parseRow(materialImporter, mapping.columns, row, context))
  return planner(materialImporter).plan(parsed, new Map(Object.entries(records).map(([code, record]) => [JSON.stringify([code]), record])))
}

describe('the material import (PLT-176, PRD-028)', () => {
  it('maps Italian headers, money marked with the cost grain, the notes ignored', () => {
    const mapping = mapHeaders(materialImporter.columns, HEADERS)
    expect(mapping.columns.map((entry) => entry.column)).toEqual([
      'code', 'name', 'kind', 'baseUom', 'purchaseUom', 'purchaseFactor', 'consumptionUom', 'animalSpecies', 'tannage', 'grade',
      'thicknessMinMm', 'thicknessMaxMm', 'requiresCrViTest', 'crViLimitMgKg', 'colours', 'standardCost',
    ])
    expect(mapping.ignored.map((entry) => entry.header)).toEqual(['Note'])
    expect(materialImporter.columns.standardCost.grain).toBe('cost')
  })

  it('creates a leather article in square feet bought by the hide, with its colours and standard cost', () => {
    const [row] = plan([['pl-02', 'Nappa nera', 'pelle', 'piedi quadri', 'pelle', '52,5', 'dmq', 'bovine', 'cromo', 'A', '1,1', '1,3', 'sì', '3', 'NER=Nero|T-1; MAR=Marrone', '2,40', 'nuovo']])
    expect(row).toMatchObject({
      action: 'CREATE',
      after: { code: 'PL-02', kind: 'LEATHER', baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'DM2', tannage: 'CHROME', requiresCrViTest: true, crViLimitMgKg: '3', standardCost: '2.4' },
    })
  })

  it('refuses in the dry run what a material may not be: missing fields, a Cr VI limit above 3 mg/kg (REACH Annex XVII entry 47), bad colours', () => {
    const rows = plan([
      ['TX-1', 'Mesh', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      ['PL-03', 'Nappa', 'pelle', 'ft²', 'pelle', '52,5', null, 'bovine', 'cromo', 'A', '1,1', '1,3', 'sì', '3,5', null, null, null],
      ['PL-04', 'Nappa', 'pelle', 'ft²', 'pelle', null, null, 'bovine', 'cromo', 'A', '1,1', '1,3', 'no', null, null, null, null],
      ['TR-1', 'Zip', 'accessorio', 'pz', null, null, null, null, null, null, null, null, null, null, 'NER=Nero; ner=Black', null, null],
    ])
    expect(rows[0]!.errors).toEqual([
      { column: 'kind', message: 'Kind is needed for a new material.' },
      { column: 'baseUom', message: 'Stock unit is needed for a new material.' },
    ])
    expect(rows[1]!.errors).toEqual([{ column: 'crViLimitMgKg', message: 'The Cr VI limit is above 0 and at most 3 mg/kg (REACH Annex XVII entry 47), with at most 3 decimals.' }])
    expect(rows[2]!.errors).toEqual([{ column: 'purchaseFactor', message: 'Say how many ft² one pelle holds (its average area).' }])
    expect(rows[3]!.errors).toEqual([{ column: 'colours', message: 'Colour 2 repeats a code.' }])
  })

  it('updates only the cells that change, adds colours without removing one, and leaves the rest unchanged', () => {
    const records = { 'PL-01': existing(leather) }
    const [same, changed] = plan(
      [
        ['PL-01', 'Nappa', null, null, null, '52,50', null, null, null, null, null, null, null, null, 'NER=Nero', '2,4', null],
        ['pl-01', 'Nappa', null, null, null, '51', null, null, null, 'TR1', null, null, null, null, 'BLU=Blu', '2,55', null],
      ],
      { ...records },
    )
    expect(same).toMatchObject({ action: 'UNCHANGED' })
    expect(changed).toMatchObject({ action: 'ERROR' })
    // A second row with the same code is the duplicate; plan it alone.
    const [update] = plan([['pl-01', 'Nappa', null, null, null, '51', null, null, null, 'TR1', null, null, null, null, 'BLU=Blu', '2,55', null]], records)
    expect(update).toMatchObject({
      action: 'UPDATE',
      before: { purchaseFactor: '52.5', grade: 'A', colours: 'NER=Nero', standardCost: '2.4' },
      after: { purchaseFactor: '51', grade: 'TR1', colours: 'BLU=Blu; NER=Nero', standardCost: '2.55' },
    })
    // At apply time the record must still hold `before`.
    expect(applyCheck(materialImporter, update!, records['PL-01'])).toEqual({ apply: true })
    const moved = existing({ ...leather, grade: 'B' })
    expect(applyCheck(materialImporter, update!, moved)).toEqual({ apply: false, note: 'changed_since_dry_run' })
  })

  it('turns the Cr VI test off with its limit, and refuses a stock unit change, an archived or another company\'s material', () => {
    const [off] = plan([['PL-01', null, null, null, null, null, null, null, null, null, null, null, 'no', null, null, null, null]], { 'PL-01': existing(leather) })
    expect(off).toMatchObject({ action: 'UPDATE', before: { requiresCrViTest: true, crViLimitMgKg: '3' }, after: { requiresCrViTest: false } })
    expect(plan([['PL-01', null, null, 'mq', null, null, null, null, null, null, null, null, null, null, null, null, null]], { 'PL-01': existing(leather) })[0]!.errors).toEqual([
      { column: 'baseUom', message: "A material's stock unit changes on its page (it checks its BOM lines and its cost), not by an import." },
    ])
    expect(plan([['PL-01', 'x', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]], { 'PL-01': existing(leather, { status: 'ARCHIVED' }) })[0]!.errors).toEqual([
      { message: 'This material is archived: reactivate it on its page before importing changes.' },
    ])
    expect(plan([['PL-01', 'x', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]], { 'PL-01': existing(leather, { foreign: true }) })[0]!.errors).toEqual([
      { column: 'code', message: "This code is another company's material (or one for every company): import it with that company." },
    ])
  })
})
