import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PARTNER_ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { Handover } from '../../shared/account/api'
import { colleagueHeld, colleagueRows, deviceOf, handoverSummary, inviteProblems, maskedEmail, raisesToAdmin, seatsHeld, sessionRows, stepUpFresh, tasksToMove } from '../../shared/account/model'
import type { DeliveryAddress } from './api'
import { designScreen } from './fixtures'
import { addressBody, addressLine, addressProblems, addressRows, addressState, companyRows, defaultHeld, EMPTY_ADDRESS, profileBody, profileChanges, profileProblem, removeHeld } from './model'

/**
 * The customer's Account page (B-W2b-196, SCR-188): the pure rules of each section, the words of every role the invite offers,
 * and every design case drawn in Italian and English with no raw key and made-up data only.
 */

const address = (over: Partial<DeliveryAddress>): DeliveryAddress => ({
  id: 'a',
  name: null,
  line1: 'Via Esempio 1',
  line2: null,
  postalCode: '20100',
  city: 'Milano',
  province: 'MI',
  country: 'IT',
  contactName: null,
  phone: null,
  deliveryNotes: null,
  isDefault: false,
  status: 'ACTIVE',
  approval: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  addedBy: { kind: 'FACTORY', name: null, you: false },
  requestedAt: null,
  decidedAt: null,
  ...over,
})
const approval = (status: 'WAITING' | 'APPROVED' | 'REFUSED', refuseReason: string | null = null) => ({ status, words: { it: '', en: '' }, refuseReason })

describe('my profile', () => {
  it('counts what changed, sends only that, and needs a name', () => {
    const saved = { displayName: 'Anna', locale: 'it' as const }
    expect(profileChanges(saved, { displayName: ' Anna ', locale: 'it' })).toBe(0)
    expect(profileChanges(saved, { displayName: 'Anna M.', locale: 'en' })).toBe(2)
    expect(profileBody(saved, { displayName: ' Anna M. ', locale: 'it' })).toEqual({ displayName: 'Anna M.' })
    expect(profileBody(saved, { displayName: 'Anna', locale: 'en' })).toEqual({ locale: 'en' })
    expect(profileProblem({ displayName: '  ', locale: 'it' })).toBe('profile.nameNeeded')
    expect(profileProblem({ displayName: 'x'.repeat(121), locale: 'it' })).toBe('profile.nameTooLong')
    expect(profileProblem({ displayName: 'Anna', locale: 'it' })).toBeNull()
  })
})

describe('colleagues', () => {
  const answer = {
    me: 'me',
    canManage: true,
    admins: [{ id: 'me', displayName: 'Anna', email: 'a@x.example' }],
    people: [
      { id: 'z', displayName: 'Zeno', email: null, status: 'ACTIVE' as const, roleKey: 'customer-buyer', roleName: 'Buyer', seesPrices: true, admin: false, capabilities: [], lastSignInAt: null, invitationExpiresAt: null, version: 1 },
      { id: 'me', displayName: 'Anna', email: null, status: 'ACTIVE' as const, roleKey: 'customer-admin', roleName: 'Admin', seesPrices: true, admin: true, capabilities: [], lastSignInAt: null, invitationExpiresAt: null, version: 1 },
      { id: 'b', displayName: 'Bea', email: null, status: 'INVITED' as const, roleKey: 'customer-viewer', roleName: 'Viewer', seesPrices: false, admin: false, capabilities: [], lastSignInAt: null, invitationExpiresAt: null, version: 1 },
    ],
    roles: [],
    seats: { taken: 3, max: 3 },
  }

  it('puts the person first, then by name; their own row is never chosen', () => {
    const rows = colleagueRows(answer)
    expect(rows.map((row) => row.id)).toEqual(['me', 'b', 'z'])
    expect(colleagueHeld(rows[0]!)).toBe('held.yourself')
    expect(colleagueHeld(rows[1]!)).toBeNull()
  })

  it('holds the invite when every seat is taken, and asks before raising someone to the admin', () => {
    expect(seatsHeld({ taken: 3, max: 3 })).toBe('held.seats')
    expect(seatsHeld({ taken: 2, max: 3 })).toBeNull()
    expect(seatsHeld({ taken: 9, max: null })).toBeNull()
    const roles = [
      { key: 'customer-buyer', kind: 'CUSTOMER', name: 'Buyer', description: '', seesPrices: true, admin: false, capabilities: { allowed: [], byDefault: [] }, offered: true },
      { key: 'customer-admin', kind: 'CUSTOMER', name: 'Admin', description: '', seesPrices: true, admin: true, capabilities: { allowed: [], byDefault: [] }, offered: true },
    ]
    expect(raisesToAdmin(roles, 'customer-buyer', 'customer-admin')).toBe(true)
    expect(raisesToAdmin(roles, 'customer-admin', 'customer-admin')).toBe(false)
    expect(raisesToAdmin(roles, 'customer-admin', 'customer-buyer')).toBe(false)
  })

  it('checks the invite field by field', () => {
    expect(inviteProblems({ displayName: '', email: 'x@', locale: 'it', roleKey: '' })).toEqual({ displayName: 'invite.problem.name', email: 'invite.problem.email', roleKey: 'invite.problem.role' })
    expect(inviteProblems({ displayName: 'Bea', email: 'bea@brand.example', locale: 'en', roleKey: 'customer-buyer' })).toEqual({})
  })

  it('sums the hand-over of everyone leaving; the leavers are never offered to take their own requests', () => {
    const read = (colleagues: Handover['colleagues'], over: Partial<Handover> = {}): Handover => ({ open: 2, kept: 2, assigned: 1, alone: [], colleagues, ...over })
    const summary = handoverSummary(
      [
        { userId: 'b', handover: read([{ id: 'me', displayName: 'Anna', count: 2 }, { id: 'z', displayName: 'Zeno', count: 1 }]) },
        { userId: 'z', handover: read([{ id: 'b', displayName: 'Bea', count: 1 }], { alone: [{ id: 't', kind: 'PAY_INVOICE', words: { it: 'Paga', en: 'Pay' }, record: { type: 'Invoice', id: 'i', label: 'INV-1' }, dueAt: null }] }) },
      ],
      'en',
    )
    expect(summary).toEqual({ open: 4, assigned: 2, alone: [{ label: 'INV-1', words: 'Pay' }], options: [{ id: 'me', name: 'Anna' }] })
    expect(tasksToMove([{ id: '1', version: 3, assignee: { id: 'b' } }, { id: '2', version: 1, assignee: null }, { id: '3', version: 1, assignee: { id: 'me' } }], ['b'])).toEqual([{ id: '1', version: 3 }])
  })
})

describe('delivery addresses', () => {
  it('says our check: ours and approved are usable; waiting, refused and removed are not', () => {
    expect(addressState(address({}))).toBe('OURS')
    expect(addressState(address({ approval: approval('APPROVED') }))).toBe('APPROVED')
    expect(addressState(address({ approval: approval('WAITING') }))).toBe('WAITING')
    expect(addressState(address({ status: 'ARCHIVED', approval: approval('REFUSED', 'Wrong postcode') }))).toBe('REFUSED')
    expect(addressState(address({ status: 'ARCHIVED', approval: approval('WAITING') }))).toBe('REMOVED')
    const rows = addressRows([address({ id: 'w', approval: approval('WAITING') }), address({ id: 'r', status: 'ARCHIVED', approval: approval('REFUSED', 'Wrong postcode') }), address({ id: 'd', isDefault: true })])
    expect(rows.map((row) => [row.id, row.usable, row.reason])).toEqual([
      ['d', true, null],
      ['w', false, null],
      ['r', false, 'Wrong postcode'],
    ])
    expect(defaultHeld(rows[0]!)).toBe('held.defaultAlready')
    expect(defaultHeld(rows[1]!)).toBe('held.defaultWaiting')
    expect(defaultHeld(rows[2]!)).toBe('held.defaultRemoved')
    expect(removeHeld(rows[1]!)).toBeNull()
    expect(removeHeld(rows[2]!)).toBe('held.removedAlready')
  })

  it('checks the form as the API does and sends it trimmed', () => {
    expect(addressProblems(EMPTY_ADDRESS)).toEqual({ line1: 'address.problem.line1', postalCode: 'address.problem.postalCode', city: 'address.problem.city' })
    expect(addressProblems({ ...EMPTY_ADDRESS, line1: 'Via 1', postalCode: '201', city: 'Milano' })).toEqual({ postalCode: 'address.problem.capIt' })
    expect(addressProblems({ ...EMPTY_ADDRESS, line1: 'Rue 1', postalCode: '75001', city: 'Paris', country: 'fra' })).toEqual({ country: 'address.problem.country' })
    expect(addressBody({ ...EMPTY_ADDRESS, line1: ' Via 1 ', postalCode: '20100', city: 'Milano', province: 'mi', country: 'it', name: ' ' })).toMatchObject({ name: null, line1: 'Via 1', province: 'MI', country: 'IT', deliveryNotes: null })
    expect(addressLine({ line1: 'Via 1', line2: null, postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' })).toBe('Via 1, 20100 Milano (MI), IT')
  })
})

describe('company data and sessions', () => {
  it('shows the SDI code, or the PEC when the code says "by PEC"', () => {
    const base = { legalName: 'Brand S.r.l.', tradeName: null, kind: 'ORGANISATION', country: 'IT', currency: 'EUR', language: 'it', invoiceAddress: null, registeredOffice: null, paymentTerms: null }
    const byPec = companyRows({ ...base, taxIdentity: { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT1', fiscalCode: null, sdiRecipientCode: '0000000', pec: 'x@pec.example', validFrom: '2024-01-01' } }, 'it')
    expect(byPec.map((row) => row.label)).toEqual(['company.legalName', 'company.vatNumber', 'company.pec', 'company.invoiceAddress', 'company.paymentTerms', 'company.currency'])
    const none = companyRows({ ...base, taxIdentity: null }, 'en')
    expect(none.find((row) => row.label === 'company.vatNumber')?.value).toBe('—')
  })

  it('names the device from the browser’s own words, this one first', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'safari', system: 'ios', phone: true })
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0')).toEqual({ browser: 'edge', system: 'windows', phone: false })
    expect(deviceOf(null)).toEqual({ browser: 'other', system: 'other', phone: false })
    const rows = sessionRows([
      { id: 'old', current: false, createdAt: 'a', lastSeenAt: '2026-01-01T08:00:00Z', idleExpiresAt: '', absoluteExpiresAt: '', userAgent: null },
      { id: 'new', current: false, createdAt: 'a', lastSeenAt: '2026-01-01T09:00:00Z', idleExpiresAt: '', absoluteExpiresAt: '', userAgent: null },
      { id: 'me', current: true, createdAt: 'a', lastSeenAt: '2026-01-01T07:00:00Z', idleExpiresAt: '', absoluteExpiresAt: '', userAgent: null },
    ])
    expect(rows.map((row) => row.id)).toEqual(['me', 'new', 'old'])
  })

  it('keeps the step-up only while it is fresh, and hides the middle of the address it went to', () => {
    expect(stepUpFresh(null, 0)).toBe(false)
    expect(stepUpFresh(new Date(60_000).toISOString(), 0)).toBe(true)
    expect(stepUpFresh(new Date(5_000).toISOString(), 0)).toBe(false)
    expect(maskedEmail('anna@brand.example')).toBe('a…a@brand.example')
  })
})

describe('the page’s words', () => {
  it('says what every customer role covers, in both languages', () => {
    const keys = PARTNER_ROLE_TEMPLATES.filter((template) => template.key.startsWith('customer-')).map((template) => `role.sees.${template.key}`)
    for (const locale of ['it', 'en'] as const) expect(keys.filter((key) => !(key in (CATALOGUE[locale]['portal-account'] ?? {}))), locale).toEqual([])
  })
})

const KEY = /\b(state|status|keys|unsaved|receipt|failed|held|profile|emails|users|role|invite|roleDialog|raise|deactivate|addresses|address|remove|company|security|endOthers|stepUp|dialog|closed)\.[a-zA-Z_-]+/

describe('SCR-188 design cases', () => {
  it('every case draws in Italian and English with no raw key and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(20)
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })

  it('the Italian page speaks Italian', () => {
    const entry = designScreen.cases.find((item) => item.id === 'admin')!
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
    expect(html).toContain('Il mio profilo')
    expect(html).toContain('Indirizzi di consegna')
    expect(html).not.toContain('Delivery addresses')
    expect(html).not.toContain('My profile')
  })
})
