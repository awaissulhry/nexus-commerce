import { describe, expect, it } from 'vitest'
import { grainsOf, markValues, type RowValues } from '../imports/importer'
import { importRecordValues, partiesImporter, termsOfRow, TERMS_COLUMNS, type ImportedParty } from './importer'

/** W2b (B-W2b-25; the B-W2a-49 gap): the commercial terms columns of the customers and suppliers import. Made-up parties only. */

const party = (extra: Partial<ImportedParty> = {}): ImportedParty => ({
  fields: { code: 'C-1', kind: 'ORGANISATION', legalName: 'Cliente Esempio S.r.l.', tradeName: null, roles: ['CUSTOMER'], country: 'IT', currency: 'EUR', language: 'it', paymentTerms: null, internalNote: null },
  status: 'ACTIVE',
  foreign: false,
  identity: null,
  registered: null,
  contacts: [],
  terms: { paymentTermsCode: 'BB30', priceList: 'LIST-A', defaultDepositPct: '30', invoiceTiming: 'PER_SHIPMENT', incoterm: 'EXW', preferredCarrierCode: null, minimumOrderAmount: 15000 },
  ...extra,
})
const existing = (value: ImportedParty) => ({ id: '00000000-0000-7000-8000-000000000001', values: importRecordValues(value) })
const plan = (values: RowValues, record: ImportedParty | null = null) => partiesImporter.plan(values, record ? existing(record) : null)

describe('the commercial terms columns of the parties import (B-W2b-25)', () => {
  it('come after the W1 columns, the minimum order with the price grain', () => {
    const names = Object.keys(partiesImporter.columns)
    expect(names.slice(-TERMS_COLUMNS.length)).toEqual([...TERMS_COLUMNS])
    expect(names.indexOf('contactPhone')).toBe(names.length - TERMS_COLUMNS.length - 1)
    expect(grainsOf(partiesImporter, ['minimumOrder', 'list', 'defaultDepositPct'])).toEqual(['price'])
    expect(markValues(partiesImporter, { minimumOrder: '150', list: 'LIST-A' })).toEqual({ minimumOrder: { $money: 'price', value: '150' }, list: 'LIST-A' })
  })

  it('load as the card shows them: codes, the minimum in the currency’s units, per shipment by default', () => {
    expect(importRecordValues(party())).toMatchObject({ paymentTermsCode: 'BB30', list: 'LIST-A', defaultDepositPct: '30', invoicing: 'PER_SHIPMENT', incoterm: 'EXW', preferredCarrier: null, minimumOrder: '150' })
    expect(importRecordValues(party({ terms: undefined }))).toMatchObject({ paymentTermsCode: null, list: null, invoicing: 'PER_SHIPMENT', minimumOrder: null })
  })

  it('create a customer with its terms, reading Italian words for the invoicing', () => {
    const row = { code: 'C-2', legalName: 'Nuovo Cliente S.r.l.', roles: 'cliente', paymentTermsCode: 'BB60', list: 'LIST-B', defaultDepositPct: '25', invoicing: 'MONTHLY', incoterm: 'DAP', preferredCarrier: 'BRT', minimumOrder: '200.5' }
    expect(plan(row)).toEqual({ action: 'CREATE', after: row })
    expect(partiesImporter.columns.invoicing.type.safeParse({ raw: 'Mensile', context: { numberFormat: 'it' } })).toMatchObject({ success: true, data: 'MONTHLY' })
    expect(partiesImporter.columns.invoicing.type.safeParse({ raw: 'TD01', context: { numberFormat: 'it' } })).toMatchObject({ success: true, data: 'PER_SHIPMENT' })
  })

  it('update only the terms that differ, the minimum compared by value', () => {
    expect(plan({ code: 'C-1', paymentTermsCode: 'BB30', minimumOrder: '150.00', defaultDepositPct: '30.0' }, party())).toEqual({ action: 'UNCHANGED' })
    expect(plan({ code: 'C-1', list: 'LIST-B', incoterm: 'FCA', minimumOrder: '99.9', invoicing: 'MONTHLY' }, party())).toEqual({
      action: 'UPDATE',
      before: { list: 'LIST-A', incoterm: 'EXW', minimumOrder: '150', invoicing: 'PER_SHIPMENT' },
      after: { list: 'LIST-B', incoterm: 'FCA', minimumOrder: '99.9', invoicing: 'MONTHLY' },
    })
  })

  it("refuse terms for a party that is no customer, a rule the terms card refuses, and more decimals than the currency's", () => {
    const supplier = party({ fields: { ...party().fields, roles: ['SUPPLIER'] }, terms: null })
    expect(plan({ code: 'C-1', incoterm: 'EXW' }, supplier)).toEqual({ action: 'ERROR', errors: [{ column: 'incoterm', message: expect.stringContaining("Commercial terms are a customer's") }] })
    expect(plan({ code: 'C-1', roles: 'fornitore; cliente', incoterm: 'EXW' }, supplier)).toMatchObject({ action: 'UPDATE', after: { roles: 'CUSTOMER; SUPPLIER', incoterm: 'EXW' } })
    expect(plan({ code: 'C-1', incoterm: 'XYZ', defaultDepositPct: '120' }, party())).toEqual({
      action: 'ERROR',
      errors: [
        { column: 'defaultDepositPct', message: expect.stringContaining('at most 100 percent') },
        { column: 'incoterm', message: expect.stringContaining('Incoterms 2020') },
      ],
    })
    expect(termsOfRow({ code: 'C-1', minimumOrder: '10.005' }, { roles: ['CUSTOMER'], currency: 'EUR' })).toEqual({ ok: false, issues: [{ column: 'minimumOrder', message: 'At most 2 decimals in EUR.' }] })
    expect(termsOfRow({ code: 'C-1', minimumOrder: '1500' }, { roles: ['CUSTOMER'], currency: 'JPY' })).toEqual({ ok: true, patch: { minimumOrderAmount: 1500 } })
    expect(termsOfRow({ code: 'C-1', tradeName: 'X' }, { roles: ['SUPPLIER'], currency: 'EUR' })).toBeNull()
  })
})
