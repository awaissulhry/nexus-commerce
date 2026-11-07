import { describe, expect, it } from 'vitest'
import type { AddressFields } from '../../parties/addresses'
import type { ContactFields } from '../../parties/contacts'
import { acceptProblems, checkUploadDetails, documentStateOf, refuseProblems, requestReasonWords, reuploadDueOf, ruleReasonWords } from './documents'
import { changeSentence, changeSummary, planProfileChange, staleProblems, touchedKeysOf, type CurrentProfile } from './profile'

const TODAY = '2026-11-07'
const A1 = '00000000-0000-7000-8000-0000000000a1'
const A2 = '00000000-0000-7000-8000-0000000000a2'
const C1 = '00000000-0000-7000-8000-0000000000c1'
const C2 = '00000000-0000-7000-8000-0000000000c2'

const address = (patch: Partial<AddressFields> = {}): AddressFields => ({
  kinds: ['REGISTERED'],
  name: null,
  line1: 'Via Roma 1',
  line2: null,
  postalCode: '36071',
  city: 'Arzignano',
  province: 'VI',
  country: 'IT',
  contactName: null,
  phone: null,
  deliveryNotes: null,
  ...patch,
})
const contact = (patch: Partial<ContactFields> = {}): ContactFields => ({ name: 'Anna Rossi', email: 'anna@tannery.example', phone: null, roles: ['ORDERS'], language: null, ...patch })

const PROFILE: CurrentProfile = {
  addresses: [
    { id: A1, version: 3, status: 'ACTIVE', fields: address(), isDefaultBillTo: false, isDefaultShipTo: false },
    { id: A2, version: 1, status: 'ACTIVE', fields: address({ kinds: ['SHIP_TO'], line1: 'Via Kit 2' }), isDefaultBillTo: false, isDefaultShipTo: true },
  ],
  contacts: [
    { id: C1, version: 2, status: 'ACTIVE', fields: contact() },
    { id: C2, version: 1, status: 'ACTIVE', fields: contact({ name: 'Bruno Neri', email: 'bruno@tannery.example', roles: ['QUALITY'] }) },
  ],
}

describe('a supplier document sent in the portal (SCM-096)', () => {
  it('keeps what the supplier said, trimmed, the codes once', () => {
    const outcome = checkUploadDetails({ category: 'TEST_REPORT', issuer: ' Lab Uno ', number: 'R-12', issuedOn: '2026-10-01', expiresOn: '2027-10-01', articles: ['NAPPA-12', ' NAPPA-12 ', ''], lots: ['2231'] }, TODAY)
    expect(outcome).toEqual({ ok: true, details: { category: 'TEST_REPORT', issuer: 'Lab Uno', number: 'R-12', issuedOn: '2026-10-01', expiresOn: '2027-10-01', articles: ['NAPPA-12'], lots: ['2231'], note: null } })
  })

  it('refuses another kind, an expired document, a future issue date, an expiry before the issue', () => {
    const paths = (input: Parameters<typeof checkUploadDetails>[0]) => {
      const outcome = checkUploadDetails(input, TODAY)
      return outcome.ok ? [] : outcome.issues.map((issue) => issue.path)
    }
    expect(paths({ category: 'POD' })).toEqual(['body/category'])
    expect(paths({ category: 'SUPPLIER_CERTIFICATE', expiresOn: '2026-11-06' })).toEqual(['body/expiresOn'])
    expect(paths({ category: 'SUPPLIER_CERTIFICATE', issuedOn: '2026-11-08' })).toEqual(['body/issuedOn'])
    expect(paths({ category: 'DECLARATION', issuedOn: '2026-10-01', expiresOn: '2026-09-30' })).toEqual(['body/expiresOn'])
    expect(paths({ category: 'DECLARATION', lots: ['x'.repeat(61)] })).toEqual(['body/lots/0'])
  })

  it('says its state: checking, held, waiting, accepted, expired, refused', () => {
    const state = (status: string, quarantineReason: string | null, decision: 'ACCEPTED' | 'REJECTED' | null, expiresOn: string | null = null) => documentStateOf({ status, quarantineReason, decision, expiresOn, today: TODAY })
    expect(state('PENDING_UPLOAD', null, null)).toBe('NOT_RECEIVED')
    expect(state('QUARANTINED', 'scan_pending', null)).toBe('CHECKING')
    expect(state('QUARANTINED', 'virus_found', null)).toBe('HELD')
    expect(state('AVAILABLE', null, null)).toBe('WAITING')
    expect(state('AVAILABLE', null, 'ACCEPTED', '2026-11-07')).toBe('ACCEPTED')
    expect(state('AVAILABLE', null, 'ACCEPTED', '2026-11-06')).toBe('EXPIRED')
    expect(state('AVAILABLE', null, 'REJECTED')).toBe('REJECTED')
  })

  it('accepts with a kind and a date not passed; refuses with a reason', () => {
    expect(acceptProblems({ category: 'SUPPLIER_CERTIFICATE', expiresOn: '2027-01-31' }, TODAY)).toEqual([])
    expect(acceptProblems({ category: 'SUPPLIER_CERTIFICATE', expiresOn: null }, TODAY)).toEqual([])
    expect(acceptProblems({ category: 'SUPPLIER_CERTIFICATE', expiresOn: '2026-11-01' }, TODAY).map((issue) => issue.path)).toEqual(['body/expiresOn'])
    expect(refuseProblems('  ')).toHaveLength(1)
    expect(refuseProblems('The page with the signature is missing.')).toEqual([])
    expect(reuploadDueOf(TODAY)).toBe('2026-11-21')
  })

  it('says why we ask', () => {
    expect(ruleReasonWords('PurchaseOrder', 'CONFIRMED', 'PO-2026-0001')).toBe('Needed before we confirm purchase order PO-2026-0001.')
    expect(ruleReasonWords('Party', 'ACTIVE', 'S1')).toBe('Needed before we work with your company.')
    expect(requestReasonWords('EXPIRY', { label: 'S1', category: 'SUPPLIER_CERTIFICATE', expiresOn: '2026-12-01' })).toBe('Your certificate on S1 expires on 2026-12-01: send the new one.')
  })
})

describe('a supplier profile change (SCM-097)', () => {
  it('plans additions, changes and removals, old → new', () => {
    const plan = planProfileChange(
      {
        addresses: [
          { op: 'ADD', address: { kinds: ['PICKUP'], line1: 'Via Conce 7', postalCode: '36071', city: 'Arzignano', province: 'vi', country: 'it' } },
          { op: 'CHANGE', addressId: A1, version: 3, address: { line1: 'Via Roma 3' } },
        ],
        contacts: [
          { op: 'CHANGE', contactId: C1, version: 2, contact: { phone: '+39 0444 123456' } },
          { op: 'REMOVE', contactId: C2, version: 1 },
          { op: 'ADD', contact: { name: 'Carla Bianchi', email: 'Carla@Tannery.example', roles: ['INVOICES'] } },
        ],
        note: ' We moved the warehouse. ',
      },
      PROFILE,
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.note).toBe('We moved the warehouse.')
    expect(plan.changes.map((change) => `${change.target}:${change.op}`)).toEqual(['ADDRESS:ADD', 'ADDRESS:CHANGE', 'CONTACT:CHANGE', 'CONTACT:REMOVE', 'CONTACT:ADD'])
    expect(plan.changes[0]!.after).toMatchObject({ kinds: ['PICKUP'], province: 'VI', country: 'IT' })
    expect(plan.changes[1]!.changed).toEqual(['line1'])
    expect(plan.changes[4]!.after).toMatchObject({ email: 'carla@tannery.example' })
    expect(touchedKeysOf(plan.changes)).toEqual([`address:${A1}`, `contact:${C1}`, `contact:${C2}`])
    expect(changeSummary(plan.changes)).toBe('2 addresses and 3 contacts')
    expect(changeSentence(plan.changes[1]!)).toBe('Registered office Via Roma 1, 36071 Arzignano VI (IT): line1 Via Roma 1 → Via Roma 3.')
    expect(changeSentence(plan.changes[3]!)).toBe('Remove the contact Bruno Neri, bruno@tannery.example.')
  })

  it('refuses what is not the supplier’s to set, a stale version, nothing changed, one row twice, one e-mail twice', () => {
    const paths = (input: Parameters<typeof planProfileChange>[0]) => {
      const plan = planProfileChange(input, PROFILE)
      return plan.ok ? [] : plan.issues.map((issue) => issue.path)
    }
    expect(paths({})).toEqual(['body'])
    expect(paths({ addresses: [{ op: 'ADD', address: { kinds: ['BILL_TO'], line1: 'Via X 1', postalCode: '36071', city: 'Arzignano', province: 'VI', country: 'IT' } }] })).toEqual(['body/addresses/0/address/kinds'])
    expect(paths({ addresses: [{ op: 'REMOVE', addressId: A2, version: 1 }] })).toEqual(['body/addresses/0'])
    expect(paths({ addresses: [{ op: 'CHANGE', addressId: A1, version: 2, address: { line1: 'Via Roma 3' } }] })).toEqual(['body/addresses/0/addressId'])
    expect(paths({ addresses: [{ op: 'CHANGE', addressId: A1, version: 3, address: { line1: 'Via Roma 1' } }] })).toEqual(['body/addresses/0/address'])
    expect(paths({ contacts: [{ op: 'REMOVE', contactId: C1, version: 2 }, { op: 'CHANGE', contactId: C1, version: 2, contact: { phone: '+39 0444 1' } }] })).toEqual(['body/contacts/1'])
    expect(paths({ contacts: [{ op: 'ADD', contact: { name: 'Twin', email: 'bruno@tannery.example', roles: [] } }] })).toEqual(['body/contacts'])
    expect(paths({ contacts: [{ op: 'ADD', contact: { name: 'Rider', roles: ['RIDER'] } }] })).toEqual(['body/contacts/0/contact/roles'])
  })

  it('stops an approval when a row changed after the supplier sent it', () => {
    const plan = planProfileChange({ contacts: [{ op: 'CHANGE', contactId: C1, version: 2, contact: { phone: '+39 0444 123456' } }] }, PROFILE)
    if (!plan.ok) throw new Error('planned')
    expect(staleProblems(plan.changes, PROFILE)).toEqual([])
    const moved: CurrentProfile = { ...PROFILE, contacts: PROFILE.contacts.map((row) => (row.id === C1 ? { ...row, version: 3 } : row)) }
    expect(staleProblems(plan.changes, moved)).toEqual(['the contact Anna Rossi changed after the supplier sent this'])
  })
})
