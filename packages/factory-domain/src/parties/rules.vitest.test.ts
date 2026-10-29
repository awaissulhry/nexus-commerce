import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition } from '../state/machine'
import { checkAddress, defaultProblems } from './addresses'
import { checkContact, duplicateEmails } from './contacts'
import { COUNTRY_CODES, isCountryCode, isItalianProvince, isLanguageCode, LANGUAGE_CODES } from './geo'
import { changeParty, isCustomer, isSupplier, newParty, partyMachine, reasonProblems } from './rules'

/** Made-up parties only. */
const TANNERY = { code: ' tan-01 ', legalName: '  Conceria   Esempio  S.r.l. ', roles: ['SUPPLIER', 'CUSTOMER', 'SUPPLIER'] as const }

describe('a party (SAL-001, SCM-001, SCM-002)', () => {
  it('normalises a new party and gives the defaults', () => {
    const outcome = newParty({ ...TANNERY, roles: [...TANNERY.roles] })
    expect(outcome).toEqual({
      ok: true,
      party: { code: 'TAN-01', kind: 'ORGANISATION', legalName: 'Conceria Esempio S.r.l.', tradeName: null, roles: ['CUSTOMER', 'SUPPLIER'], country: 'IT', currency: 'EUR', language: 'it', paymentTerms: null, internalNote: null },
    })
    if (outcome.ok) {
      expect(isCustomer(outcome.party.roles)).toBe(true)
      expect(isSupplier(outcome.party.roles)).toBe(true)
    }
  })

  it('refuses what it cannot be, with the field as the path', () => {
    const outcome = newParty({ code: 'bad code', legalName: ' ', roles: [], country: 'XX', currency: 'EURO', language: 'ita' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.path)).toEqual(['code', 'legalName', 'roles', 'country', 'currency', 'language'])
  })

  it('changes only what the patch gives and names the changed fields', () => {
    const created = newParty({ code: 'C-1', legalName: 'Cliente Esempio S.p.A.', roles: ['CUSTOMER'] })
    if (!created.ok) throw new Error('setup')
    const change = changeParty(created.party, { tradeName: 'Esempio', roles: ['CUSTOMER', 'BRAND'], country: undefined })
    expect(change).toMatchObject({ ok: true, changed: ['tradeName', 'roles'] })
    expect(changeParty(created.party, { roles: ['BRAND', 'CUSTOMER'] })).toMatchObject({ ok: true, changed: ['roles'] })
    expect(changeParty(created.party, { legalName: 'Cliente Esempio S.p.A.' })).toMatchObject({ ok: true, changed: [] })
    expect(changeParty(created.party, { roles: [] })).toMatchObject({ ok: false, issues: [{ path: 'roles' }] })
  })

  it('moves PROSPECT → ACTIVE ⇄ BLOCKED and archives only an unblocked party', () => {
    expect(canTransition(partyMachine, 'PROSPECT', 'ACTIVE').ok).toBe(true)
    expect(canTransition(partyMachine, 'ACTIVE', 'BLOCKED').ok).toBe(true)
    expect(canTransition(partyMachine, 'BLOCKED', 'ACTIVE').ok).toBe(true)
    expect(canTransition(partyMachine, 'ARCHIVED', 'ACTIVE').ok).toBe(true)
    expect(canTransition(partyMachine, 'BLOCKED', 'ARCHIVED').ok).toBe(false)
    expect(canTransition(partyMachine, 'PROSPECT', 'BLOCKED').ok).toBe(false)
    expect(() => assertTransition(partyMachine, 'ACTIVE', 'PROSPECT')).toThrow()
  })

  it('asks a reason where one is required', () => {
    expect(reasonProblems(' ', true)).toEqual([{ path: 'reason', message: 'Say why: the reason is kept with the change.' }])
    expect(reasonProblems(undefined, false)).toEqual([])
    expect(reasonProblems('x'.repeat(501), false)).toHaveLength(1)
  })
})

describe('the code lists', () => {
  it('holds every ISO 3166-1 alpha-2 code once, ISO 639-1 languages and the Italian provinces', () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length)
    expect(COUNTRY_CODES).toHaveLength(250)
    expect(new Set(LANGUAGE_CODES).size).toBe(LANGUAGE_CODES.length)
    for (const code of ['IT', 'DE', 'GR', 'CH', 'GB', 'US', 'XK']) expect(isCountryCode(code)).toBe(true)
    for (const code of ['EL', 'UK', 'XI', 'it']) expect(isCountryCode(code)).toBe(false)
    for (const code of ['it', 'en', 'de', 'fr', 'es']) expect(isLanguageCode(code)).toBe(true)
    expect(isLanguageCode('xx')).toBe(false)
    for (const sigla of ['MI', 'FI', 'PI', 'RM', 'BZ', 'SU']) expect(isItalianProvince(sigla)).toBe(true)
    expect(isItalianProvince('XX')).toBe(false)
  })
})

describe('an address (SAL-003)', () => {
  const OFFICE = { kinds: ['BILL_TO', 'REGISTERED', 'BILL_TO'] as const, line1: ' Via  Esempio 10 ', postalCode: '56029', city: 'Santa Croce sull\'Arno', province: 'pi', country: 'it' }

  it('normalises and accepts an Italian registered office', () => {
    expect(checkAddress({ ...OFFICE, kinds: [...OFFICE.kinds] })).toMatchObject({ ok: true, address: { kinds: ['REGISTERED', 'BILL_TO'], line1: 'Via Esempio 10', province: 'PI', country: 'IT' } })
  })

  it('asks an Italian address its 5-digit CAP and its province sigla', () => {
    const outcome = checkAddress({ ...OFFICE, kinds: ['REGISTERED'], postalCode: '5602', province: null })
    expect(outcome.ok ? [] : outcome.issues.map((issue) => issue.path)).toEqual(['postalCode', 'province'])
    expect(checkAddress({ ...OFFICE, kinds: ['REGISTERED'], province: 'ZZ' })).toMatchObject({ ok: false, issues: [{ path: 'province' }] })
  })

  it('takes a foreign postcode and an optional region; refuses a too-long line and a bad phone', () => {
    expect(checkAddress({ kinds: ['SHIP_TO'], line1: 'Beispielstraße 1', postalCode: '10115', city: 'Berlin', country: 'DE' }).ok).toBe(true)
    expect(checkAddress({ kinds: ['SHIP_TO'], line1: '1 Example Road', postalCode: 'sw1a 1aa', city: 'London', country: 'GB' })).toMatchObject({ ok: true, address: { postalCode: 'SW1A 1AA' } })
    const outcome = checkAddress({ kinds: [], line1: 'x'.repeat(61), postalCode: '1', city: 'X', country: 'FR', phone: 'call me' })
    expect(outcome.ok ? [] : outcome.issues.map((issue) => issue.path)).toEqual(['kinds', 'line1', 'phone'])
  })

  it('makes a default only of an address with that use', () => {
    expect(defaultProblems(['REGISTERED'], { isDefaultBillTo: true, isDefaultShipTo: true }).map((issue) => issue.path)).toEqual(['isDefaultBillTo', 'isDefaultShipTo'])
    expect(defaultProblems(['BILL_TO', 'SHIP_TO'], { isDefaultBillTo: true, isDefaultShipTo: true })).toEqual([])
  })
})

describe('a contact (SAL-004, SCM-004)', () => {
  it('keeps the email in lower case and the roles in order', () => {
    expect(checkContact({ name: ' Anna  Esempio ', email: ' Anna@Example.COM ', roles: ['INVOICES', 'ORDERS'], language: 'EN' })).toEqual({
      ok: true,
      contact: { name: 'Anna Esempio', email: 'anna@example.com', phone: null, roles: ['ORDERS', 'INVOICES'], language: 'en' },
    })
  })

  it('needs an email for a contact who receives documents', () => {
    expect(checkContact({ name: 'Bruno Esempio', roles: ['ORDERS'] })).toMatchObject({ ok: false, issues: [{ path: 'email', message: 'A contact for orders has an email: the documents go to it.' }] })
    expect(checkContact({ name: 'Bruno Esempio', roles: ['OWNER'] }).ok).toBe(true)
    expect(checkContact({ name: 'Bruno Esempio', email: 'not-an-email', language: 'xx' })).toMatchObject({ ok: false, issues: [{ path: 'email' }, { path: 'language' }] })
  })

  it('finds an email used twice', () => {
    expect(duplicateEmails([{ email: 'a@example.com' }, { email: null }, { email: 'b@example.com' }, { email: 'a@example.com' }])).toEqual(['a@example.com'])
  })
})
