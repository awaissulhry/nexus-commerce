import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PARTNER_ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { ProfileAddress, ProfileContact, SupplierProfile } from './api'
import { designScreen } from './fixtures'
import {
  addressLines,
  addressPatch,
  addressProblems,
  changeHeld,
  changeLines,
  changesBody,
  contactLines,
  contactPatch,
  contactProblems,
  EMPTY_ADDRESS,
  EMPTY_CONTACT,
  editCount,
  NO_EDITS,
  sameEmails,
  sendHeld,
  websiteProblemKey,
  withAddressEdit,
  withContactEdit,
  withoutEdit,
  type ProfileEdits,
} from './model'

/**
 * The supplier's Profile (B-W2b-193, SCR-191): the changes typed and what "Send changes for our check" sends, what holds a
 * change (the API's own rules), the rows as shown, the requests in our words, and every design case drawn in Italian and
 * English with no raw key and made-up data only (never a price).
 */

const address = (over: Partial<ProfileAddress>): ProfileAddress => ({ id: 'a1', version: 3, kinds: ['PICKUP'], name: 'Pickup', line1: 'Via Finta 1', line2: null, postalCode: '56029', city: 'Santa Croce', province: 'PI', country: 'IT', contactName: null, phone: null, deliveryNotes: null, isDefaultBillTo: false, isDefaultShipTo: false, waiting: false, ...over })
const contact = (over: Partial<ProfileContact>): ProfileContact => ({ id: 'c1', version: 2, name: 'Anna', email: 'anna@x.example', phone: null, roles: ['ORDERS'], language: null, waiting: false, ...over })
const profile = (over: Partial<SupplierProfile> = {}): SupplierProfile => ({
  company: { code: 'S', legalName: 'S S.p.A.', tradeName: null, country: 'IT', vatNumber: 'IT0', fiscalCode: null, website: null, waiting: false },
  addresses: [address({}), address({ id: 'b1', kinds: ['BILL_TO'], isDefaultBillTo: true }), address({ id: 'w1', waiting: true })],
  contacts: [contact({}), contact({ id: 'c2', name: 'Bea', email: 'bea@x.example' })],
  pending: [],
  decided: [],
  mayChange: true,
  limits: { changes: 20, addressKinds: ['REGISTERED', 'PICKUP'], contactRoles: ['ORDERS'] },
  live: { events: [] },
  ...over,
})
const FACTS = { preview: false, offline: false, mayChange: true }

describe('the changes typed', () => {
  it('sends each row at the version the supplier saw, only the fields that changed', () => {
    const value = profile()
    let edits: ProfileEdits = NO_EDITS
    edits = withAddressEdit(edits, { op: 'CHANGE', id: 'a1', version: 3, draft: { ...EMPTY_ADDRESS, kinds: ['PICKUP'], name: 'Pickup', line1: 'Via Finta 3', postalCode: '56029', city: 'Santa Croce', province: 'pi' } }, value.addresses[0])
    edits = withAddressEdit(edits, { op: 'ADD', key: 'n1', draft: { ...EMPTY_ADDRESS, line1: 'Via Nuova 2', postalCode: '56020', city: 'Montopoli', province: 'PI' } })
    edits = withContactEdit(edits, { op: 'REMOVE', id: 'c2', version: 2 })
    edits = { ...edits, website: 'https://s.example' }
    expect(editCount(edits)).toBe(4)
    expect(changesBody(edits, value, '')).toEqual({
      addresses: [
        { op: 'CHANGE', addressId: 'a1', version: 3, address: { line1: 'Via Finta 3' } },
        { op: 'ADD', address: { name: null, line1: 'Via Nuova 2', line2: null, postalCode: '56020', city: 'Montopoli', province: 'PI', country: 'IT', contactName: null, phone: null, deliveryNotes: null, kinds: ['PICKUP'] } },
      ],
      contacts: [{ op: 'REMOVE', contactId: 'c2', version: 2 }],
      company: { website: 'https://s.example' },
    })
  })

  it('a change back to what is saved is no change; Undo drops a row’s edit', () => {
    const value = profile()
    const edits = withContactEdit(NO_EDITS, { op: 'CHANGE', id: 'c1', version: 2, draft: { name: 'Anna', email: 'ANNA@x.example', phone: '', roles: ['ORDERS'], language: '' } }, value.contacts[0])
    expect(edits.contacts).toEqual([])
    expect(contactPatch(value.contacts[0]!, { name: 'Anna', email: 'anna@x.example', phone: '+39 0571 000000', roles: ['ORDERS', 'QUALITY'], language: 'en' })).toEqual({ phone: '+39 0571 000000', roles: ['ORDERS', 'QUALITY'], language: 'en' })
    expect(addressPatch(value.addresses[0]!, { ...EMPTY_ADDRESS, kinds: ['PICKUP'], name: 'Pickup', line1: 'Via Finta 1', postalCode: '56029', city: 'Santa Croce', province: 'PI' })).toEqual({})
    const removed = withContactEdit(NO_EDITS, { op: 'REMOVE', id: 'c1', version: 2 })
    expect(withoutEdit(removed, 'contacts', 'c1').contacts).toEqual([])
  })
})

describe('what holds a change', () => {
  it('a preview, not the admin, no connection', () => {
    expect(changeHeld({ ...FACTS, preview: true })).toBe('held.previewChange')
    expect(changeHeld({ ...FACTS, mayChange: false })).toBe('held.adminChanges')
    expect(changeHeld({ ...FACTS, offline: true })).toBe('held.offline')
    expect(changeHeld(FACTS)).toBeNull()
  })

  it('a waiting row cannot change again; our invoice address is ours to set; a removed row cannot be edited', () => {
    const rows = addressLines(profile(), withAddressEdit(NO_EDITS, { op: 'REMOVE', id: 'a1', version: 3 }), null)
    expect(rows.map((row) => [row.id, row.state, row.editHeld, row.removeHeld])).toEqual([
      ['a1', 'REMOVE', 'held.removing', null],
      ['b1', 'CURRENT', null, 'held.ours'],
      ['w1', 'WAITING', 'held.waitingCheck', 'held.waitingCheck'],
    ])
  })

  it('checks addresses and contacts with the parties module’s rules, in our words', () => {
    expect(addressProblems({ ...EMPTY_ADDRESS, kinds: [], postalCode: '5602', city: '' }, true)).toEqual({ kinds: 'profile.problem.kinds', line1: 'profile.problem.line1', postalCode: 'profile.problem.cap', city: 'profile.problem.city', province: 'profile.problem.sigla' })
    expect(addressProblems({ ...EMPTY_ADDRESS, kinds: ['BILL_TO'], line1: 'Via 1', postalCode: '56029', city: 'X', province: 'PI' }, true)).toEqual({ kinds: 'profile.problem.kinds' })
    expect(addressProblems({ ...EMPTY_ADDRESS, line1: 'Via 1', postalCode: '56029', city: 'X', province: 'PI' }, true)).toEqual({})
    expect(contactProblems({ ...EMPTY_CONTACT, name: 'Marco', roles: ['INVOICES'] })).toEqual({ email: 'profile.problem.emailNeeded' })
    expect(contactProblems({ ...EMPTY_CONTACT, name: '', email: 'not-mail' })).toMatchObject({ name: 'profile.problem.name', email: 'profile.problem.email' })
    expect(websiteProblemKey('www.example')).toBe('profile.problem.website')
    expect(websiteProblemKey('https://s.example')).toBeNull()
  })

  it('holds the send while two contacts would share an e-mail', () => {
    const edits = withContactEdit(NO_EDITS, { op: 'ADD', key: 'n', draft: { ...EMPTY_CONTACT, name: 'Carla', email: 'anna@x.example', roles: ['ORDERS'] } })
    const rows = contactLines(profile(), edits, null)
    expect(sameEmails(rows)).toEqual(['anna@x.example'])
    expect(sendHeld(edits, rows, FACTS, false)).toEqual({ key: 'held.sameEmail', params: { emails: 'anna@x.example' } })
  })
})

describe('requests in our words', () => {
  it('names what changes and each field old → new', () => {
    const lines = changeLines([
      { target: 'CONTACT', op: 'CHANGE', id: 'c1', before: { name: 'Anna', phone: null }, after: { name: 'Anna', phone: '+39 1' }, changed: ['phone'] },
      { target: 'COMPANY', op: 'CHANGE', id: 'p', before: { website: null }, after: { website: 'https://s.example' }, changed: ['website'] },
    ])
    expect(lines).toEqual([
      { words: { key: 'profile.change.CONTACT.CHANGE', params: { what: 'Anna' } }, fields: [{ field: 'phone', before: '—', after: '+39 1' }] },
      { words: { key: 'profile.change.website' }, fields: [{ field: 'website', before: '—', after: 'https://s.example' }] },
    ])
  })
})

describe('the page’s words', () => {
  it('says what every supplier and workshop role covers, in both languages', () => {
    const keys = PARTNER_ROLE_TEMPLATES.filter((template) => template.key.startsWith('supplier-') || template.key.startsWith('subcontractor-')).map((template) => `role.sees.${template.key}`)
    expect(keys.length).toBeGreaterThan(0)
    for (const locale of ['it', 'en'] as const) expect(keys.filter((key) => !(key in (CATALOGUE[locale]['portal-supplier-profile'] ?? {}))), locale).toEqual([])
  })
})

const KEY = /\b(profile|held|receipt|keys|status|users|role|invite|roleDialog|raise|deactivate|security|endOthers|stepUp|dialog|emails|state)\.[a-zA-Z_.-]+/

describe('SCR-191 design cases', () => {
  it('every case draws in Italian and English with no raw key, no price and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(20)
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
        expect(html, `${entry.id} (${locale})`).not.toMatch(/sees prices|vede i prezzi|Sees prices|Vede i prezzi/)
      }
    }
  })

  it('the Italian page speaks Italian', () => {
    const entry = designScreen.cases.find((item) => item.id === 'admin')!
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
    expect(html).toContain('Utenti del portale')
    expect(html).toContain('In attesa della nostra verifica dal')
    expect(html).not.toContain('Portal users')
    expect(html).not.toContain('Contacts')
  })
})
