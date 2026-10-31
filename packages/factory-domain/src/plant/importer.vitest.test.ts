import { describe, expect, it } from 'vitest'
import { grainsOf, keyOf, type RowValues } from '../imports/importer'
import { importRecordValues, machinesImporter, MACHINE_IMPORTER_KEY, type ImportedMachine } from './importer'

/** W2b (B-W2b-25; the B-W2a-53 gap): the machines import's plan. Made-up asset numbers and codes only. */

const machine = (extra: Partial<ImportedMachine> = {}): ImportedMachine => ({
  columns: { assetNumber: 'SEW-L1-01', site: 'A1', machineClass: 'LOCKSTITCH', make: 'Esempio', modelName: 'X-1', serialNumber: null, year: 2019, station: 'SEW-01', workCentre: null, supplier: null, purchaseCost: '1250.5', note: null },
  status: 'RUNNING',
  foreign: false,
  ...extra,
})
const existing = (value: ImportedMachine) => ({ id: '00000000-0000-7000-8000-000000000001', values: importRecordValues(value) })
const plan = (values: RowValues, record: ImportedMachine | null = null) => machinesImporter.plan(values, record ? existing(record) : null)

describe('the machines import (B-W2b-25)', () => {
  it('is keyed by the asset number; the purchase cost carries the cost grain', () => {
    expect(machinesImporter.key).toBe(MACHINE_IMPORTER_KEY)
    expect(keyOf(machinesImporter, { assetNumber: 'SEW-L1-01' })).toBe('["SEW-L1-01"]')
    expect(grainsOf(machinesImporter, Object.keys(machinesImporter.columns))).toEqual(['cost'])
    expect(machinesImporter.validateRow({ assetNumber: 'SEW L1' })).toEqual([{ column: 'assetNumber', message: expect.stringContaining('QR tag') }])
  })

  it('registers a new machine at a site with its class, and refuses one without either', () => {
    const row = { assetNumber: 'CUT-02', site: 'A1', machineClass: 'CUTTING-TABLE', year: 2021 }
    expect(plan(row)).toEqual({ action: 'CREATE', after: row })
    expect(plan({ assetNumber: 'CUT-02', make: 'X' })).toEqual({
      action: 'ERROR',
      errors: [
        { column: 'site', message: 'Site is needed for a new machine.' },
        { column: 'machineClass', message: 'Class is needed for a new machine.' },
      ],
    })
  })

  it('changes only what differs (the cost by value), never the site', () => {
    expect(plan({ assetNumber: 'SEW-L1-01', site: 'A1', year: 2019, purchaseCost: '1250.50' }, machine())).toEqual({ action: 'UNCHANGED' })
    expect(plan({ assetNumber: 'SEW-L1-01', station: 'SEW-02', note: 'Moved' }, machine())).toEqual({ action: 'UPDATE', before: { station: 'SEW-01', note: null }, after: { station: 'SEW-02', note: 'Moved' } })
    expect(plan({ assetNumber: 'SEW-L1-01', site: 'B1' }, machine())).toEqual({ action: 'ERROR', errors: [{ column: 'site', message: expect.stringContaining('never moves to another site') }] })
  })

  it("refuses another company's machine, and anything but a note on a retired one", () => {
    expect(plan({ assetNumber: 'SEW-L1-01', note: 'x' }, machine({ foreign: true }))).toMatchObject({ action: 'ERROR', errors: [{ column: 'assetNumber' }] })
    expect(plan({ assetNumber: 'SEW-L1-01', note: 'Sold' }, machine({ status: 'RETIRED' }))).toMatchObject({ action: 'UPDATE', after: { note: 'Sold' } })
    expect(plan({ assetNumber: 'SEW-L1-01', year: 2020 }, machine({ status: 'RETIRED' }))).toEqual({ action: 'ERROR', errors: [{ message: 'Machine SEW-L1-01 is retired: only its note changes.' }] })
  })
})
