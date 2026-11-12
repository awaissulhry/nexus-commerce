import { describe, expect, it } from 'vitest'
import type { RowValues } from '../../imports/importer'
import { locationsImporter } from './importer'

/** W2b (B-W2b-25; the B-W2a-25 gap): the Workshop column of the locations import. Made-up codes only. */

const record = (values: Record<string, string | null>) => ({ id: '00000000-0000-7000-8000-000000000001', values: { site: 'A1', code: 'A1-TERZ', name: 'At the workshop', kind: 'SUBCONTRACTOR', parent: null, workshop: 'TERZ-01', ...values } })
const plan = (values: RowValues, existing: ReturnType<typeof record> | null = null) => locationsImporter.plan(values, existing)

describe('the Workshop column of the locations import (B-W2b-25)', () => {
  it('comes after the W1 columns', () => {
    expect(Object.keys(locationsImporter.columns)).toEqual(['site', 'code', 'name', 'kind', 'parent', 'workshop'])
  })

  it("makes a workshop's stock location with its workshop, and refuses one without", () => {
    const row = { site: 'A1', code: 'A1-TERZ', name: 'At the workshop', kind: 'SUBCONTRACTOR', workshop: 'TERZ-01' }
    expect(plan(row)).toEqual({ action: 'CREATE', after: row })
    expect(plan({ site: 'A1', code: 'A1-TERZ', name: 'x', kind: 'SUBCONTRACTOR' })).toEqual({ action: 'ERROR', errors: [{ column: 'workshop', message: expect.stringContaining('name it') }] })
  })

  it('refuses a workshop on another kind, a new workshop, and a kind change to or from a workshop location', () => {
    expect(plan({ site: 'A1', code: 'A1-B1', name: 'Bin', kind: 'BIN', workshop: 'TERZ-01' })).toEqual({ action: 'ERROR', errors: [{ column: 'workshop', message: expect.stringContaining('Only a Subcontractor location') }] })
    expect(plan({ site: 'A1', code: 'A1-TERZ', workshop: 'TERZ-02' }, record({}))).toEqual({ action: 'ERROR', errors: [{ column: 'workshop', message: expect.stringContaining('its workshop never changes') }] })
    expect(plan({ site: 'A1', code: 'A1-TERZ', kind: 'BIN' }, record({}))).toEqual({ action: 'ERROR', errors: [{ column: 'kind', message: expect.stringContaining('stays one') }] })
    expect(plan({ site: 'A1', code: 'A1-B1', kind: 'SUBCONTRACTOR', workshop: 'TERZ-01' }, record({ code: 'A1-B1', kind: 'BIN', workshop: null }))).toMatchObject({ action: 'ERROR', errors: [{ column: 'kind' }] })
  })

  it('keeps a CUSTOMER location with its party unchanged, refuses another party, and makes none by import (B-W2b-277)', () => {
    const customer = record({ code: 'A1-CUST', name: 'At the customer', kind: 'CUSTOMER', workshop: 'CUST-01' })
    expect(plan({ site: 'A1', code: 'A1-CUST', name: 'At the customer', kind: 'CUSTOMER', workshop: 'CUST-01' }, customer)).toEqual({ action: 'UNCHANGED' })
    expect(plan({ site: 'A1', code: 'A1-CUST', workshop: 'CUST-02' }, customer)).toEqual({ action: 'ERROR', errors: [{ column: 'workshop', message: expect.stringContaining('its party never changes') }] })
    expect(plan({ site: 'A1', code: 'A1-CUST', name: 'x', kind: 'CUSTOMER', workshop: 'CUST-01' })).toEqual({ action: 'ERROR', errors: [{ column: 'kind', message: expect.stringContaining('made on the Locations page') }] })
  })

  it('keeps the same workshop unchanged and renames the location', () => {
    expect(plan({ site: 'A1', code: 'A1-TERZ', workshop: 'TERZ-01', name: 'Renamed' }, record({}))).toEqual({ action: 'UPDATE', before: { name: 'At the workshop' }, after: { name: 'Renamed' } })
    expect(plan({ site: 'A1', code: 'A1-TERZ', workshop: 'TERZ-01' }, record({}))).toEqual({ action: 'UNCHANGED' })
  })
})
