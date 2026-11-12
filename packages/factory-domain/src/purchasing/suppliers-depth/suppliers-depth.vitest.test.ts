import { describe, expect, it } from 'vitest'
import { eachDay } from '../../calendars/dates'
import { workingCalendar, type DayException } from '../../calendars/working-time'
import { grainsOf, type RowValues } from '../../imports/importer'
import { importRecordValues, partiesImporter, TERMS_COLUMNS, type ImportedParty } from '../../parties/importer'
import { ordersContactOf, sendChecks, type SendFacts } from '../orders'
import { closuresAhead, orderedOn, spanDates } from './closures'
import { colourOfKey, SUPPLIER_COLUMN_NAMES, supplierColumnsOf, supplierOfRow, supplierPricesImporter, type ImportedSupplier } from './importer'
import { changeProfile, effectiveStatus, initialSupplierStatus, newOrderProblem, sendProblem, statusChangeProblems, supplierRoleProblem, type Standing, type SupplierProfile } from './rules'
import { copiesOf, receivesProblems, routeMail, routingSentence, takesOrders } from './routing'

/** B-W2b-311: suppliers in depth, pure. Made-up suppliers, contacts and days only. */

const standing = (extra: Partial<Standing> = {}): Standing => ({ name: 'Conceria Esempio', partyStatus: 'ACTIVE', supplierStatus: 'APPROVED', reason: null, since: '2026-11-02', ...extra })
const profile = (extra: Partial<SupplierProfile> = {}): SupplierProfile => ({ kinds: [], leadTimeDays: null, originCountry: null, originRegion: null, originNote: null, hideOriginCountries: [], tannages: [], ...extra })

describe('the supplier status lifecycle (SCM-008)', () => {
  it('moves along the lifecycle, with a reason where one is needed', () => {
    expect(statusChangeProblems(null, 'APPROVED', null)).toEqual([])
    expect(statusChangeProblems('APPROVED', 'ON_HOLD', 'Invoice dispute')).toEqual([])
    expect(statusChangeProblems('APPROVED', 'ON_HOLD', null)).toEqual([{ path: 'reason', message: expect.stringContaining('Say why the supplier is on hold') }])
    expect(statusChangeProblems('APPROVED', 'PROSPECT', null)[0]!.message).toMatch(/approved is not made a prospect/)
    expect(statusChangeProblems('INACTIVE', 'PROSPECT', null)).toEqual([])
    expect(statusChangeProblems('ON_HOLD', 'ON_HOLD', 'A better reason')).toEqual([])
    expect(statusChangeProblems('APPROVED', 'APPROVED', null)[0]!.message).toBe('The supplier is approved already.')
    expect(statusChangeProblems('APPROVED', 'BLOCKED', 'x'.repeat(501))[0]!.path).toBe('reason')
  })

  it('reads W1’s status where none is set, and W1’s block over it', () => {
    expect(initialSupplierStatus('PROSPECT')).toBe('PROSPECT')
    expect(initialSupplierStatus('ACTIVE')).toBe('APPROVED')
    expect(effectiveStatus('ACTIVE', null)).toEqual({ status: 'APPROVED', source: 'PARTY' })
    expect(effectiveStatus('ACTIVE', 'ON_HOLD')).toEqual({ status: 'ON_HOLD', source: 'SUPPLIER' })
    expect(effectiveStatus('BLOCKED', 'APPROVED')).toEqual({ status: 'BLOCKED', source: 'PARTY' })
  })

  it('says in words why no new purchase order goes to a supplier on hold, blocked or inactive', () => {
    expect(newOrderProblem(standing())).toBeNull()
    expect(newOrderProblem(standing({ supplierStatus: null }))).toBeNull()
    expect(newOrderProblem(standing({ supplierStatus: 'ON_HOLD', reason: 'Late deliveries under review' }))).toBe(
      'Conceria Esempio is on hold as a supplier since 2026-11-02 (Late deliveries under review): no new purchase order goes to it; pick another approved source.',
    )
    expect(newOrderProblem(standing({ supplierStatus: 'INACTIVE' }))).toMatch(/set it approved again/)
    expect(sendProblem(standing({ supplierStatus: 'PROSPECT' }))).toMatch(/only a sample order goes to it/)
    expect(sendProblem(standing({ supplierStatus: 'PROSPECT' }), 'SAMPLE')).toBeNull()
  })

  it('holds a draft at the send check, with the same words', () => {
    const facts: SendFacts = {
      status: 'DRAFT',
      today: '2026-11-12',
      supplier: { name: 'Conceria Esempio', status: 'ACTIVE', roles: ['SUPPLIER'], supplierStatus: 'BLOCKED', supplierStatusReason: 'Chromium VI over the limit', supplierStatusSince: '2026-11-10' },
      contact: { name: 'Ufficio ordini', email: 'ordini@example.com', roles: [], receives: ['PO'], active: true },
      companyLegal: [],
      deliveryAddress: true,
      requestedDate: null,
      lines: [{ seq: 1, itemCode: 'PELLE-1', unitPrice: '4.2', needDate: '2026-12-01', purchaseQuantity: '10', purchaseUom: 'FT2', minOrderQuantity: null, orderMultiple: null, leadTimeDays: null }],
    }
    const checks = sendChecks(facts)
    expect(checks.ready).toBe(false)
    expect(checks.checks).toEqual([{ code: 'SUPPLIER_NOT_ACTIVE', severity: 'BLOCKS', path: 'partyId', message: expect.stringContaining('blocked as a supplier since 2026-11-10 (Chromium VI over the limit)') }])
    expect(sendChecks({ ...facts, supplier: { ...facts.supplier, supplierStatus: 'APPROVED', supplierStatusReason: null } })).toMatchObject({ ready: true, checks: [] })
  })

  it('keeps a supplier role while the party has kinds or a status (B-W2b-287’s gap)', () => {
    expect(supplierRoleProblem('Conceria Esempio', ['SUPPLIER'], ['CUSTOMER'], { kinds: [], supplierStatus: 'APPROVED' })).toMatch(/Set its supplier status to inactive/)
    expect(supplierRoleProblem('Conceria Esempio', ['SUPPLIER'], ['CUSTOMER'], { kinds: ['TANNERY'], supplierStatus: null })).toMatch(/remove them on its supplier record/)
    expect(supplierRoleProblem('Conceria Esempio', ['SUPPLIER'], ['SUBCONTRACTOR'], { kinds: ['TANNERY'], supplierStatus: 'APPROVED' })).toBeNull()
    expect(supplierRoleProblem('Conceria Esempio', ['SUPPLIER'], ['CUSTOMER'], { kinds: [], supplierStatus: null })).toBeNull()
  })
})

describe('kinds and origin (SCM-002, SCM-016)', () => {
  it('normalises kinds, countries and tannages and says what changed', () => {
    const change = changeProfile(profile(), { kinds: ['SUBCONTRACTOR', 'TANNERY', 'TANNERY'], hideOriginCountries: ['it', 'ES', 'IT'], tannages: ['VEGETABLE', 'CHROME_FREE'], originCountry: 'it', originRegion: '  Santa Croce  sull’Arno ' }, ['SUPPLIER', 'SUBCONTRACTOR'])
    expect(change).toEqual({
      ok: true,
      profile: profile({ kinds: ['TANNERY', 'SUBCONTRACTOR'], hideOriginCountries: ['IT', 'ES'], tannages: ['VEGETABLE', 'CHROME_FREE'], originCountry: 'IT', originRegion: 'Santa Croce sull’Arno' }),
      changed: ['kinds', 'originCountry', 'originRegion', 'hideOriginCountries', 'tannages'],
    })
  })

  it('refuses kinds without a supplier role, hides without the tannery kind, a bad country and lead time', () => {
    expect(changeProfile(profile(), { kinds: ['TRIMS'] }, ['CUSTOMER'])).toEqual({ ok: false, issues: [{ path: 'kinds', message: expect.stringContaining('give the party the supplier') }] })
    const tannery = profile({ kinds: ['TANNERY'], hideOriginCountries: ['IT'], tannages: ['CHROME'] })
    expect(changeProfile(tannery, { kinds: ['TRIMS'] }, ['SUPPLIER'])).toMatchObject({ ok: false, issues: [{ path: 'hideOriginCountries', message: expect.stringContaining('a tannery’s') }] })
    expect(changeProfile(tannery, { kinds: ['TRIMS'], hideOriginCountries: [], tannages: [] }, ['SUPPLIER'])).toMatchObject({ ok: true, changed: ['kinds', 'hideOriginCountries', 'tannages'] })
    expect(changeProfile(profile(), { originCountry: 'XX', leadTimeDays: 400 }, ['SUPPLIER'])).toMatchObject({ ok: false, issues: [{ path: 'leadTimeDays' }, { path: 'originCountry' }] })
    expect(changeProfile(profile(), { tannages: ['TANNED' as never] }, ['SUPPLIER'])).toMatchObject({ ok: false, issues: [{ path: 'tannages' }] })
  })
})

describe('contacts by what they receive (SCM-004)', () => {
  const contacts = [
    { id: 'a', name: 'Anna', status: 'ACTIVE', email: 'anna@example.com', roles: ['ORDERS'], receives: [] },
    { id: 'b', name: 'Bruno', status: 'ACTIVE', email: 'bruno@example.com', roles: ['QUALITY'], receives: ['PO', 'CLAIM'] },
    { id: 'c', name: 'Carla', status: 'ACTIVE', email: 'carla@example.com', roles: [], receives: ['PO'] },
    { id: 'd', name: 'Dario', status: 'ARCHIVED', email: 'dario@example.com', roles: ['ORDERS'], receives: ['PO', 'REMITTANCE'] },
    { id: 'e', name: 'Elena', status: 'ACTIVE', email: null, roles: ['INVOICES'], receives: [] },
  ]

  it('routes each kind to the contacts that receive it, else to W1’s roles, else nobody', () => {
    expect(routeMail('PO', contacts)).toMatchObject({ by: 'RECEIVES', contacts: [{ id: 'b' }, { id: 'c' }] })
    expect(routeMail('QUALITY', contacts)).toMatchObject({ by: 'ROLE', contacts: [{ id: 'b' }] })
    expect(routeMail('DOCUMENT', contacts)).toMatchObject({ by: 'ROLE', contacts: [{ id: 'b' }, { id: 'a' }] })
    expect(routeMail('REMITTANCE', contacts)).toEqual({ kind: 'REMITTANCE', by: 'NONE', contacts: [] })
    expect(routeMail('PO', contacts.map((contact) => ({ ...contact, receives: undefined })))).toMatchObject({ by: 'ROLE', contacts: [{ id: 'a' }] })
    expect(routingSentence(routeMail('PO', contacts))).toBe('Purchase orders go to Bruno, Carla (what they receive).')
    expect(routingSentence(routeMail('REMITTANCE', contacts))).toMatch(/cannot be e-mailed/)
  })

  it('makes the order’s contact the first PO receiver, the others its copies', () => {
    expect(ordersContactOf(contacts)?.id).toBe('b')
    expect(ordersContactOf(contacts.map((contact) => ({ ...contact, receives: [] })))?.id).toBe('a')
    expect(copiesOf('PO', contacts, 'bruno@example.com')).toEqual(['carla@example.com'])
    expect(copiesOf('PO', contacts.map((contact) => ({ ...contact, receives: [] })), 'anna@example.com')).toEqual([])
    expect(takesOrders({ roles: [], receives: ['PO'] })).toBe(true)
    expect(takesOrders({ roles: ['QUALITY'] })).toBe(false)
  })

  it('refuses a kind it does not know and a receiver without an e-mail', () => {
    expect(receivesProblems(['PO', 'FAX'], { email: 'x@example.com', status: 'ACTIVE' })[0]!.path).toBe('receives')
    expect(receivesProblems(['PO'], { email: null, status: 'ACTIVE' })[0]!.message).toMatch(/e-mail first/)
    expect(receivesProblems([], { email: null, status: 'ARCHIVED' })).toEqual([])
  })
})

describe('closures in the lead time (SCM-012)', () => {
  const closed = new Map<string, DayException>(eachDay('2026-08-03', '2026-08-28').map((date) => [date, { date, kind: 'CLOSURE', name: 'Summer closure', shiftPatternId: null }]))
  const calendar = workingCalendar({ layers: [{ id: 'cal', scope: 'SUPPLIER', name: 'Supplier', workingWeekdays: [1, 2, 3, 4, 5], shiftPatternId: null, days: closed }], patterns: new Map(), timeZone: 'Europe/Rome', window: { from: '2026-01-01', to: '2027-12-31' }, supplier: true })

  it('moves the arrival of an order past the closure, in words', () => {
    expect(orderedOn(calendar, '2026-07-27', 10)).toMatchObject({ arrives: '2026-09-01', skipped: [{ from: '2026-08-03', to: '2026-08-28', days: 26 }] })
    expect(orderedOn(calendar, '2026-07-27', 10)!.words).toBe("Ordered on 2026-07-27, it arrives on 2026-09-01 at the earliest: 10 days' lead time, closed 3–28 Aug 2026 (Summer closure).")
    expect(orderedOn(null, '2026-07-27', 10)).toMatchObject({ arrives: '2026-08-06', skipped: [] })
    expect(orderedOn(calendar, '2026-07-27', null)).toBeNull()
  })

  it('lists the closures ahead and the weekly days off', () => {
    expect(closuresAhead(calendar, '2026-07-01')).toEqual({ weeklyDaysOff: [6, 7], ahead: [expect.objectContaining({ from: '2026-08-03', to: '2026-08-28', words: 'closed 3–28 Aug 2026 (Summer closure)' })] })
    expect(closuresAhead(null, '2026-07-01')).toEqual({ weeklyDaysOff: [6, 7], ahead: [] })
    expect(spanDates({ from: '2026-12-30', to: '2027-01-02' })).toBe('30 Dec 2026 – 2 Jan 2027')
    expect(spanDates({ from: '2026-07-30', to: '2026-08-02' })).toBe('30 Jul – 2 Aug 2026')
  })
})

describe('the supplier columns of the parties import (SCM-289)', () => {
  const supplier: ImportedSupplier = { ...profile({ kinds: ['TANNERY'], leadTimeDays: 21, originCountry: 'IT', hideOriginCountries: ['IT'], tannages: ['CHROME'] }), supplierStatus: 'APPROVED', supplierStatusReason: null }
  const party = (extra: Partial<ImportedParty> = {}): ImportedParty => ({
    fields: { code: 'S-1', kind: 'ORGANISATION', legalName: 'Conceria Esempio S.r.l.', tradeName: null, roles: ['SUPPLIER'], country: 'IT', currency: 'EUR', language: 'it', paymentTerms: null, internalNote: null, website: null },
    status: 'ACTIVE',
    foreign: false,
    identity: null,
    registered: null,
    contacts: [],
    supplier,
    ...extra,
  })
  const plan = (values: RowValues, record: ImportedParty | null = null) => partiesImporter.plan(values, record ? { id: '00000000-0000-7000-8000-000000000001', values: importRecordValues(record) } : null)

  it('come after the terms columns, none with money', () => {
    const names = Object.keys(partiesImporter.columns)
    expect(names.slice(-SUPPLIER_COLUMN_NAMES.length)).toEqual([...SUPPLIER_COLUMN_NAMES])
    expect(names.slice(-SUPPLIER_COLUMN_NAMES.length - TERMS_COLUMNS.length, -SUPPLIER_COLUMN_NAMES.length)).toEqual([...TERMS_COLUMNS])
    expect(grainsOf(partiesImporter, SUPPLIER_COLUMN_NAMES)).toEqual([])
  })

  it('load as the record shows them, blank for a customer, so a file for re-import plans UNCHANGED', () => {
    expect(supplierColumnsOf(supplier, ['SUPPLIER'])).toMatchObject({ supplierKinds: 'TANNERY', supplierStatus: 'APPROVED', leadTimeDays: 21, hideOriginCountries: 'IT', tannages: 'CHROME' })
    expect(Object.values(supplierColumnsOf(supplier, ['CUSTOMER'])).every((value) => value === null)).toBe(true)
    const values = importRecordValues(party())
    const row = Object.fromEntries(Object.entries(values).filter(([name, value]) => !name.startsWith('$') && value !== null)) as RowValues
    expect(plan(row, party())).toEqual({ action: 'UNCHANGED' })
  })

  it('read a record’s kinds and tannages back as the same set, whatever order it holds them in (a file for re-import)', () => {
    const unordered = party({ supplier: { ...supplier, kinds: ['SUBCONTRACTOR', 'TANNERY'], tannages: ['CHROME_FREE', 'VEGETABLE'] } })
    const values = importRecordValues(unordered)
    expect(values).toMatchObject({ supplierKinds: 'TANNERY; SUBCONTRACTOR', tannages: 'VEGETABLE; CHROME_FREE' })
    const row = Object.fromEntries(Object.entries(values).filter(([name, value]) => !name.startsWith('$') && value !== null)) as RowValues
    expect(plan(row, unordered)).toEqual({ action: 'UNCHANGED' })
    expect(plan({ code: 'S-1', tannages: 'vegetale; senza cromo' }, unordered)).toEqual({ action: 'UNCHANGED' })
  })

  it('create a supplier with Italian words for its kinds, status and tannages', () => {
    const row = { code: 'S-2', legalName: 'Laboratorio Esempio', roles: 'fornitore; terzista', supplierKinds: 'Conceria; terzista', supplierStatus: 'approvato', tannages: 'vegetale; senza cromo', hideOriginCountries: 'it; es' }
    const parsed = { ...row, supplierStatus: partiesImporter.columns.supplierStatus.type.parse({ raw: 'approvato', context: { numberFormat: 'it' } }) }
    expect(parsed.supplierStatus).toBe('APPROVED')
    expect(plan(parsed)).toEqual({ action: 'CREATE', after: parsed })
    expect(supplierOfRow(parsed, ['SUPPLIER', 'SUBCONTRACTOR'], null)).toMatchObject({ ok: true, plan: { profile: { kinds: ['TANNERY', 'SUBCONTRACTOR'], tannages: ['VEGETABLE', 'CHROME_FREE'], hideOriginCountries: ['IT', 'ES'] }, status: { from: null, to: 'APPROVED', reason: null } } })
  })

  it('update only what differs, a status move with its reason', () => {
    expect(plan({ code: 'S-1', supplierStatus: 'ON_HOLD', supplierStatusReason: 'Invoice dispute', leadTimeDays: 28, tannages: 'cromo' }, party())).toEqual({
      action: 'UPDATE',
      before: { supplierStatus: 'APPROVED', supplierStatusReason: null, leadTimeDays: 21 },
      after: { supplierStatus: 'ON_HOLD', supplierStatusReason: 'Invoice dispute', leadTimeDays: 28 },
    })
  })

  it('refuse supplier columns for a customer, a status without its reason, an unknown kind and hides without a tannery', () => {
    const customer = party({ fields: { ...party().fields, roles: ['CUSTOMER'] }, supplier: null })
    expect(plan({ code: 'S-1', leadTimeDays: 5 }, customer)).toEqual({ action: 'ERROR', errors: [{ column: 'leadTimeDays', message: expect.stringContaining('Supplier columns are a supplier’s') }] })
    expect(plan({ code: 'S-1', supplierStatus: 'BLOCKED' }, party())).toEqual({ action: 'ERROR', errors: [{ column: 'supplierStatusReason', message: expect.stringContaining('Say why') }] })
    expect(plan({ code: 'S-1', supplierKinds: 'conceria; panetteria' }, party())).toEqual({ action: 'ERROR', errors: [{ column: 'supplierKinds', message: expect.stringContaining('panetteria') }] })
    expect(plan({ code: 'S-1', supplierKinds: 'accessori' }, party())).toEqual({ action: 'ERROR', errors: [{ column: 'hideOriginCountries', message: expect.stringContaining('a tannery’s') }] })
    expect(plan({ code: 'S-2', legalName: 'Nuovo', roles: 'fornitore', supplierStatusReason: 'why' })).toEqual({ action: 'ERROR', errors: [{ column: 'supplierStatusReason', message: expect.stringContaining('needs a supplier status') }] })
  })
})

describe('the supplier price list import (SCM-289)', () => {
  it('is keyed by supplier, material and colour (* for every colour), the price a cost', () => {
    expect(supplierPricesImporter.keyColumns).toEqual(['supplier', 'material', 'colour'])
    expect(grainsOf(supplierPricesImporter, ['unitPrice', 'minOrderQty'])).toEqual(['cost'])
    expect(supplierPricesImporter.columns.colour.type.parse({ raw: 'tutti', context: { numberFormat: 'it' } })).toBe('*')
    expect(colourOfKey('*')).toBeNull()
    expect(colourOfKey('BLK')).toBe('BLK')
    expect(supplierPricesImporter.columns.preference.type.parse({ raw: 'Riserva', context: { numberFormat: 'it' } })).toBe('BACKUP')
  })
})
