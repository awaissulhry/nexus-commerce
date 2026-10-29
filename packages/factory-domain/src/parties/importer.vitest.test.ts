import { describe, expect, it } from 'vitest'
import type { RowValues } from '../imports/importer'
import { importRecordValues, parseRoles, partiesImporter, type ImportedParty } from './importer'
import { partyWarnings } from './warnings'

/** The parties import's plan (SCM-289 → PLT-176) and the record's warnings. Made-up parties and numbers only. */

const IT_VAT = '12345670009'
const party = (extra: Partial<ImportedParty> = {}): ImportedParty => ({
  fields: { code: 'C-1', kind: 'ORGANISATION', legalName: 'Cliente Esempio S.r.l.', tradeName: null, roles: ['CUSTOMER'], country: 'IT', currency: 'EUR', language: 'it', paymentTerms: null, internalNote: null },
  status: 'ACTIVE',
  foreign: false,
  identity: { country: 'IT', taxMode: 'IT_B2B', vatNumber: `IT${IT_VAT}`, fiscalCode: null, sdiRecipientCode: 'ABC1234', pec: null },
  registered: { kinds: ['REGISTERED', 'BILL_TO'], name: null, line1: 'Via Esempio 1', line2: null, postalCode: '50100', city: 'Firenze', province: 'FI', country: 'IT', contactName: null, phone: null, deliveryNotes: null },
  contacts: [{ name: 'Anna Esempio', email: 'anna@example.com', phone: null, roles: ['ORDERS'], language: null }],
  ...extra,
})
const existing = (value: ImportedParty) => ({ id: '00000000-0000-7000-8000-000000000001', values: importRecordValues(value) })
const plan = (values: RowValues, record: ImportedParty | null = null) => partiesImporter.plan(values, record ? existing(record) : null)

describe('the parties import (SCM-289, PLT-176)', () => {
  it('reads roles in Italian or English', () => {
    expect(parseRoles('Cliente; fornitore')).toEqual(['CUSTOMER', 'SUPPLIER'])
    expect(parseRoles('terzista e corriere')).toEqual(['SUBCONTRACTOR', 'CARRIER'])
    expect(parseRoles('BRAND')).toEqual(['BRAND'])
    expect(parseRoles('cliente; amico')).toBeNull()
    expect(partiesImporter.validateRow({ code: 'X', roles: 'amico' })).toEqual([{ column: 'roles', message: expect.stringContaining('Expected roles') }])
  })

  it('creates a party with its tax identity, registered office and contact when every rule holds', () => {
    const row = { code: 'C-2', legalName: 'Nuovo Cliente S.r.l.', roles: 'cliente', vatNumber: IT_VAT, sdiRecipientCode: 'ABC1234', addressLine1: 'Via Nuova 2', postalCode: '20121', city: 'Milano', province: 'MI', contactName: 'Bruno Esempio', contactEmail: 'bruno@example.com' }
    expect(plan(row)).toEqual({ action: 'CREATE', after: row })
  })

  it('refuses a new row without its name or roles, or one that breaks a rule, naming the column', () => {
    expect(plan({ code: 'C-3' })).toEqual({ action: 'ERROR', errors: [{ column: 'legalName', message: 'Legal name is needed for a new party.' }, { column: 'roles', message: 'Roles is needed for a new party.' }] })
    expect(plan({ code: 'C-3', legalName: 'X S.r.l.', roles: 'cliente', vatNumber: '12345670008', addressLine1: 'Via X 1', postalCode: '123', city: 'Roma', province: 'RM' })).toEqual({
      action: 'ERROR',
      errors: [
        { column: 'vatNumber', message: expect.stringContaining('check digit') },
        { column: 'postalCode', message: 'An Italian CAP is 5 digits.' },
      ],
    })
  })

  it('updates only what differs: party fields, the identity in force, the registered office and a new contact', () => {
    const record = party()
    expect(plan({ code: 'C-1', legalName: 'Cliente Esempio S.r.l.', vatNumber: IT_VAT, city: 'Firenze', contactEmail: 'anna@example.com' }, record)).toEqual({ action: 'UNCHANGED' })
    expect(plan({ code: 'C-1', roles: 'cliente; fornitore', pec: 'Fatture@PEC.example.it', postalCode: '50121', contactName: 'Carla Esempio', contactEmail: 'carla@example.com' }, record)).toEqual({
      action: 'UPDATE',
      before: { roles: 'CUSTOMER', pec: null, postalCode: '50100', contactName: null, contactEmail: null },
      after: { roles: 'CUSTOMER; SUPPLIER', pec: 'fatture@pec.example.it', postalCode: '50121', contactName: 'Carla Esempio', contactEmail: 'carla@example.com' },
    })
  })

  it("refuses another company's party and an archived one", () => {
    expect(plan({ code: 'C-1', tradeName: 'X' }, party({ foreign: true }))).toMatchObject({ action: 'ERROR', errors: [{ column: 'code' }] })
    expect(plan({ code: 'C-1', tradeName: 'X' }, party({ status: 'ARCHIVED' }))).toMatchObject({ action: 'ERROR' })
  })
})

describe("a party's warnings (SCR-033, SCR-057)", () => {
  const IDENTITY = { country: 'IT', taxMode: 'IT_B2B' as const, vatNumber: `IT${IT_VAT}`, fiscalCode: null, sdiRecipientCode: 'ABC1234', pec: null }
  const facts = (extra: Partial<Parameters<typeof partyWarnings>[0]> = {}) => ({
    party: { kind: 'ORGANISATION' as const, roles: ['CUSTOMER' as const], country: 'IT', legalName: 'Cliente Esempio S.r.l.' },
    identity: IDENTITY,
    vies: { state: 'NOT_APPLICABLE' as const, message: 'n/a' },
    addresses: [{ kinds: ['REGISTERED' as const, 'BILL_TO' as const, 'SHIP_TO' as const], isDefaultBillTo: true, isDefaultShipTo: true, line1: 'Via Esempio 1', line2: null, city: 'Firenze' }],
    contacts: [{ email: 'anna@example.com', roles: ['ORDERS' as const] }],
    ...extra,
  })

  it('has none for a complete Italian customer', () => {
    expect(partyWarnings(facts())).toEqual([])
  })

  it('says what an invoice still needs, and what only warns', () => {
    const codes = partyWarnings(facts({ identity: null, addresses: [], contacts: [] })).map((warning) => [warning.code, warning.blocksInvoice])
    expect(codes).toEqual([['NO_TAX_IDENTITY', true], ['NO_REGISTERED_ADDRESS', true], ['NO_DEFAULT_BILL_TO', false], ['NO_DEFAULT_SHIP_TO', false], ['NO_ORDERS_CONTACT', false]])
    expect(partyWarnings(facts({ identity: { ...IDENTITY, sdiRecipientCode: '0000000' } })).map((warning) => warning.code)).toEqual(['FISCAL_DRAWER'])
    expect(partyWarnings(facts({ party: { ...facts().party, legalName: `Cliente ${'Ü'.repeat(4)} ${'x'.repeat(80)} 中` } })).map((warning) => warning.code)).toEqual(['NAME_TOO_LONG', 'NOT_LATIN1'])
  })

  it('warns an EU business customer without a current VIES proof, with the standing in words', () => {
    const eu = facts({ party: { ...facts().party, country: 'DE' }, identity: { country: 'DE', taxMode: 'EU_B2B', vatNumber: 'DE100000000', fiscalCode: null, sdiRecipientCode: null, pec: null }, vies: { state: 'HELD', message: 'Held.' } })
    expect(partyWarnings(eu)).toEqual([{ code: 'VIES_NOT_PROVEN', message: 'Held.', blocksInvoice: false }])
    expect(partyWarnings({ ...eu, vies: { state: 'VALID', message: 'ok' } })).toEqual([])
  })
})
