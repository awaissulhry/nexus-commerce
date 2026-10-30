import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import { isBlankRow, parseRow, planner, type SheetRow } from '../../imports/plan'
import { importRecordValues, operationsImporter, type ImportedOperation } from './importer'
import { newOperation, type OperationFields } from './operations'
import { planSubcontract, sameSubcontract } from './subcontract'

/** Made-up workshops, operations and minutes. */
const id = (n: number) => `0195f5d0-0000-7000-8000-${String(n).padStart(12, '0')}`

describe('a subcontracted routing step (PRD-120)', () => {
  it('names the workshop first; the fee and the days go with it', () => {
    expect(planSubcontract(null, { pricePerPiece: '4.5' })).toMatchObject({ ok: false, issues: [{ path: 'subcontract/supplierId' }] })
    expect(planSubcontract(null, { supplierId: id(1), pricePerPiece: '4.500', transitDays: 6 })).toEqual({ ok: true, subcontract: { supplierId: id(1), pricePerPiece: '4.5', transitDays: 6 } })
    expect(planSubcontract(null, { supplierId: id(1) })).toEqual({ ok: true, subcontract: { supplierId: id(1), pricePerPiece: null, transitDays: null } })
  })

  it('keeps what a change leaves out for the same workshop, starts empty for another, clears with null', () => {
    const current = { supplierId: id(1), pricePerPiece: '4.5', transitDays: 6 }
    expect(planSubcontract(current, { transitDays: 8 })).toEqual({ ok: true, subcontract: { ...current, transitDays: 8 } })
    expect(planSubcontract(current, { pricePerPiece: null })).toEqual({ ok: true, subcontract: { ...current, pricePerPiece: null } })
    expect(planSubcontract(current, { supplierId: id(2) })).toEqual({ ok: true, subcontract: { supplierId: id(2), pricePerPiece: null, transitDays: null } })
    expect(planSubcontract(current, null)).toEqual({ ok: true, subcontract: null })
  })

  it('refuses a negative or too precise fee and days outside 0 to 365', () => {
    const outcome = planSubcontract(null, { supplierId: id(1), pricePerPiece: '-1', transitDays: 366 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.issues.map((issue) => issue.path)).toEqual(['subcontract/pricePerPiece', 'subcontract/transitDays'])
    expect(planSubcontract(null, { supplierId: id(1), pricePerPiece: '1.1234567' }).ok).toBe(false)
    expect(planSubcontract(null, { supplierId: id(1), transitDays: 0 }).ok).toBe(true)
  })

  it('compares fees by value', () => {
    expect(sameSubcontract({ supplierId: id(1), pricePerPiece: '4.50', transitDays: 6 }, { supplierId: id(1), pricePerPiece: '4.5', transitDays: 6 })).toBe(true)
    expect(sameSubcontract(null, null)).toBe(true)
    expect(sameSubcontract({ supplierId: id(1), pricePerPiece: null, transitDays: null }, null)).toBe(false)
  })
})

describe('the operation library import (PRD-109, PLT-176)', () => {
  const HEADERS = ['Codice', 'Descrizione', 'Nome (it)', 'Reparto', 'Macchina', 'Minuti standard', 'Istruzioni']
  const context = { numberFormat: 'it' as const }
  const sew = (() => {
    const outcome = newOperation({ code: 'CUC-01', name: 'Sew the body', workCentreKind: 'SEWING', standardMinutes: '12' })
    if (!outcome.ok) throw new Error('fixture')
    return outcome.operation
  })()
  const existing = (fields: OperationFields, more: Partial<ImportedOperation> = {}) => ({ id: id(10), values: importRecordValues({ fields, status: 'ACTIVE', foreign: false, used: true, ...more }) })

  function plan(rows: (string | number | null)[][], records: Record<string, ReturnType<typeof existing>> = {}) {
    const mapping = mapHeaders(operationsImporter.columns, HEADERS)
    expect(mapping.issues).toEqual([])
    const sheet: SheetRow[] = rows.map((cells, index) => ({ rowNumber: index + 2, cells }))
    const parsed = sheet.filter((row) => !isBlankRow(row)).map((row) => parseRow(operationsImporter, mapping.columns, row, context))
    return planner(operationsImporter).plan(parsed, new Map(Object.entries(records).map(([code, record]) => [JSON.stringify([code]), record])))
  }

  it('maps Italian headers and departments, and creates an operation with its minutes rounded to 3 decimals', () => {
    const [row] = plan([['tag-01', 'Taglio pannelli', 'Taglio pannelli', 'taglio', 'Tavolo', '0,16667', null]])
    expect(row).toMatchObject({ action: 'CREATE', after: { code: 'TAG-01', name: 'Taglio pannelli', nameIt: 'Taglio pannelli', workCentreKind: 'CUTTING', machineType: 'Tavolo', standardMinutes: '0.16667' } })
  })

  it('refuses a new code without its department or minutes, and minutes of 0', () => {
    const [missing, zero] = plan([
      ['TAG-02', 'Taglio', null, null, null, null, null],
      ['TAG-03', 'Taglio', null, 'taglio', null, '0', null],
    ])
    expect(missing).toMatchObject({ action: 'ERROR', errors: [{ column: 'workCentreKind' }, { column: 'standardMinutes' }] })
    expect(zero).toMatchObject({ action: 'ERROR', errors: [{ column: 'standardMinutes' }] })
  })

  it('changes only the cells that differ (minutes by value, names merged per language), UNCHANGED when none does', () => {
    const [changed] = plan([['CUC-01', null, 'Cucitura corpo', 'cucitura', null, '12,5', null]], { 'CUC-01': existing(sew) })
    const [same] = plan([['CUC-01', 'Sew the body', null, null, null, '12,000', null]], { 'CUC-01': existing(sew) })
    expect(changed).toMatchObject({ action: 'UPDATE', before: { nameIt: null, standardMinutes: '12' }, after: { nameIt: 'Cucitura corpo', standardMinutes: '12.5' } })
    expect(same).toMatchObject({ action: 'UNCHANGED' })
  })

  it("refuses another company's or an archived operation", () => {
    const [foreign] = plan([['CUC-01', 'X', null, null, null, null, null]], { 'CUC-01': existing(sew, { foreign: true }) })
    expect(foreign).toMatchObject({ action: 'ERROR', errors: [{ column: 'code' }] })
    const [archived] = plan([['CUC-01', 'X', null, null, null, null, null]], { 'CUC-01': existing(sew, { status: 'ARCHIVED' }) })
    expect(archived).toMatchObject({ action: 'ERROR', errors: [{ message: expect.stringMatching(/archived/) }] })
  })
})
