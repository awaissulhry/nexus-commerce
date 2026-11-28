import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PARTNER_ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { Handover } from '../../shared/account/api'
import { ApiError } from '../../../lib/api/errors'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { inviteFailed } from '../../shared/account/words'
import { colleagueHeld, colleagueRows, deviceOf, handoverSummary, inviteProblems, maskedEmail, raisesToAdmin, seatsHeld, sessionRows, stepUpFresh, tasksToMove } from '../../shared/account/model'
import type { DeliveryAddress } from './api'
import { designScreen } from './fixtures'
import { designScreen as peopleScreen } from '../people/fixtures' // owb-po4.3
import { addressBody, addressLine, addressProblems, addressRows, addressState, companyRows, defaultHeld, EMPTY_ADDRESS, profileBody, profileChanges, profileProblem, removeHeld } from './model'
// F-CP-153: "Your team".
import type { ApiClient } from '../../../lib/api/client'
import { addProjectPerson, giveAccessBack, pauseAccess, resendInvitation, revokeInvitation } from '../../shared/account/api'
import { BULK_ACTS, bulkPreview, CUSTOMER_ACTS, projectsByPerson, seatsFullOf, TEAM_ACTS, teamActHeld, versionOf, type TeamFacts } from '../../shared/account/model'

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

describe('B-TH-202: a refused invitation never reveals another organisation (the brand wall, B-TH-007)', () => {
  it('answers the factory’s neutral refusal with ONE sentence in it and en, and names nobody', () => {
    const neutral = new ApiError('conflict', 409, 'conflict', 'We could not invite this address. Ask us.', 'r', [
      { path: 'email', message: 'We could not invite this address. Ask us.' },
      { path: 'refusal/NOT_INVITABLE', message: 'We could not invite this address. Ask us.' },
    ])
    for (const locale of ['it', 'en'] as const) {
      const words = (CATALOGUE[locale]['portal-account'] ?? {}) as Record<string, string>
      const t = (key: string) => words[key] ?? key
      const said = inviteFailed(neutral, t)
      expect(said).toBe(words['invite.failed.notInvitable'])
      for (const word of ['organis', 'organizz', 'office', 'ufficio', 'account']) expect(said.toLowerCase()).not.toContain(word)
      expect(scanText(said, BRAND_ALPHA)).toEqual([])
      expect(scanText(said, BRAND_BETA)).toEqual([])
      // An own colleague already in the portal is said plainly, and it names no other account either.
      const already = inviteFailed(new ApiError('conflict', 409, 'conflict', 'x', 'r', [{ path: 'email', message: 'x' }]), t)
      expect(already).toBe(words['invite.failed.address'])
      expect(already.toLowerCase()).not.toContain('account')
    }
    expect((CATALOGUE.en['portal-account'] as Record<string, string>)['invite.failed.notInvitable']).toBe('We could not invite this address. Ask us.')
  })
})

describe('the page’s words', () => {
  it('says what every customer role covers, in both languages', () => {
    const keys = PARTNER_ROLE_TEMPLATES.filter((template) => template.key.startsWith('customer-')).map((template) => `role.sees.${template.key}`)
    for (const locale of ['it', 'en'] as const) expect(keys.filter((key) => !(key in (CATALOGUE[locale]['portal-account'] ?? {}))), locale).toEqual([])
  })
})

const KEY = /\b(team|state|status|keys|unsaved|receipt|failed|held|profile|emails|users|role|invite|roleDialog|raise|deactivate|addresses|address|remove|company|security|endOthers|stepUp|dialog|closed)\.[a-zA-Z_-]+/

describe('SCR-188 design cases', () => {
  it('every case draws in Italian and English with no raw key and made-up data only', () => {
    // owb-po4.3: the colleagues' cases (and their pop-ups) moved to Your people (SCR-188-people).
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(18)
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

// ---- F-CP-153 (customer page plan C6, D13; review G2, F4): "Your team" ------------------------------------------------------------
describe('F-CP-153 — Your team: acts by role and status, seats, the bulk preview, the version sent, the supplier portal held', () => {
  const CUSTOMER: TeamFacts = { customer: true, seatsFull: false, projects: 2, readOnly: false }
  const row = (status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DEACTIVATED', over: Partial<{ id: string; name: string; you: boolean }> = {}) => ({ id: over.id ?? `u-${status}`, name: over.name ?? status, you: over.you ?? false, status })
  const held = (status: Parameters<typeof row>[0], facts: TeamFacts = CUSTOMER) => Object.fromEntries(TEAM_ACTS.map((act) => [act, teamActHeld(act, row(status), facts)]))

  it('acts by status: invited → send again / withdraw; active → pause / add to a project; paused → give back; never one’s own row', () => {
    expect([...TEAM_ACTS]).toEqual(['role', 'resend', 'revoke', 'pause', 'giveBack', 'addToProject', 'deactivate'])
    expect([...BULK_ACTS]).toEqual(['pause', 'giveBack', 'addToProject', 'deactivate'])
    expect(held('INVITED')).toEqual({ role: null, resend: null, revoke: null, pause: 'team.held.notActive', giveBack: 'team.held.notPaused', addToProject: 'team.held.notActive', deactivate: null })
    expect(held('ACTIVE')).toEqual({ role: null, resend: 'team.held.notInvited', revoke: 'team.held.notInvited', pause: null, giveBack: 'team.held.notPaused', addToProject: null, deactivate: null })
    expect(held('SUSPENDED')).toMatchObject({ pause: 'team.held.notActive', giveBack: null, addToProject: 'team.held.notActive' })
    expect(held('DEACTIVATED')).toMatchObject({ role: 'held.deactivated', deactivate: 'held.deactivated', giveBack: 'team.held.notPaused' })
    for (const act of TEAM_ACTS) {
      expect(teamActHeld(act, row('ACTIVE', { you: true }), CUSTOMER), act).toBe('held.yourself')
      expect(teamActHeld(act, row('ACTIVE'), { ...CUSTOMER, readOnly: true }), act).toBe('held.preview')
    }
    // No project of the admin's own: nothing to add a colleague to.
    expect(teamActHeld('addToProject', row('ACTIVE'), { ...CUSTOMER, projects: 0 })).toBe('team.held.noProjects')
  })

  it('seats full: Give access back is held with the seats’ words (it, en)', () => {
    expect(seatsFullOf({ taken: 8, max: 8 })).toBe(true)
    expect(seatsFullOf({ taken: 7, max: 8 })).toBe(false)
    expect(seatsFullOf({ taken: 30, max: null })).toBe(false)
    expect(seatsFullOf(null)).toBe(false)
    expect(teamActHeld('giveBack', row('SUSPENDED'), { ...CUSTOMER, seatsFull: true })).toBe('team.seatsFull')
    expect(CATALOGUE.en['portal-account']?.['team.seatsFull']).toBe('All {max} places are taken: deactivate someone or ask us for more places.')
    expect(CATALOGUE.it['portal-account']?.['team.seatsFull']).toBe('Tutti i {max} posti sono occupati: disattivate qualcuno o chiedeteci più posti.')
  })

  it('the bulk preview: who an act reaches and who it leaves out (with why), said before anything is sent', () => {
    const rows = [row('ACTIVE', { id: 'a', name: 'Luca' }), row('SUSPENDED', { id: 'b', name: 'Marco' }), row('ACTIVE', { id: 'me', name: 'Anna', you: true }), row('INVITED', { id: 'c', name: 'Sara' })]
    const pause = bulkPreview('pause', rows, CUSTOMER)
    expect(pause.apply.map((entry) => entry.id)).toEqual(['a'])
    expect(pause.skip.map((entry) => [entry.row.id, entry.why])).toEqual([['b', 'team.held.notActive'], ['me', 'held.yourself'], ['c', 'team.held.notActive']])
    expect(bulkPreview('giveBack', rows, CUSTOMER).apply.map((entry) => entry.id)).toEqual(['b'])
    expect(bulkPreview('giveBack', rows, { ...CUSTOMER, seatsFull: true }).skip.find((entry) => entry.row.id === 'b')?.why).toBe('team.seatsFull')
    expect(bulkPreview('deactivate', rows, CUSTOMER).apply.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('the supplier portal shares the one section: the customer’s acts show held with why — role and deactivate stay', () => {
    const supplier: TeamFacts = { customer: false, seatsFull: false, projects: 0, readOnly: false }
    expect([...CUSTOMER_ACTS]).toEqual(['resend', 'revoke', 'pause', 'giveBack', 'addToProject'])
    for (const act of ['resend', 'revoke', 'pause', 'giveBack', 'addToProject'] as const) expect(teamActHeld(act, row(act === 'giveBack' ? 'SUSPENDED' : act === 'pause' || act === 'addToProject' ? 'ACTIVE' : 'INVITED'), supplier), act).toBe('team.held.customersOnly')
    expect(teamActHeld('role', row('ACTIVE'), supplier)).toBeNull()
    expect(teamActHeld('deactivate', row('ACTIVE'), supplier)).toBeNull()
    for (const locale of ['it', 'en'] as const) expect(CATALOGUE[locale]['portal-account']?.['team.held.customersOnly'], locale).toBeTruthy()
  })

  it('W-CP-4 / review G2: every act sends the colleague’s version (and, for a project, the colleague’s id) — never a party', async () => {
    const calls: { path: string; body: unknown }[] = []
    const api = { post: async (path: string, options: { body?: unknown }) => {
      calls.push({ path, body: options.body })
      return path.includes('/projects/') ? { members: [], choices: [] } : path.endsWith('/invitation') ? { invitation: { id: 'i', userId: 'u1', email: 'x@example.com', expiresAt: '2026-11-26T00:00:00Z' }, delivery: 'sent' } : { id: 'u1', status: 'ACTIVE', version: 4, sessionsEnded: 0 }
    } } as unknown as ApiClient
    await resendInvitation(api, 'u1', 3)
    await revokeInvitation(api, 'u1', 3)
    await pauseAccess(api, 'u1', { version: 3 })
    await giveAccessBack(api, 'u1', 4)
    await addProjectPerson(api, 'p1', { userId: 'u1', version: 4 })
    expect(calls.map((call) => call.path)).toEqual(['/portal/colleagues/u1/invitation', '/portal/colleagues/u1/invitation/revoke', '/portal/colleagues/u1/suspend', '/portal/colleagues/u1/reactivate', '/portal/projects/p1/people'])
    expect(calls.map((call) => call.body)).toEqual([{ version: 3 }, { version: 3 }, { version: 3 }, { version: 4 }, { userId: 'u1', version: 4 }])
    expect(JSON.stringify(calls)).not.toMatch(/party|company/i)
    expect(versionOf({ people: [{ id: 'u1', version: 7 } as never] }, 'u1')).toBe(7)
    expect(versionOf(null, 'u1')).toBeNull()
  })

  it('the Projects column names only the reader’s own projects each colleague is in', () => {
    const byPerson = projectsByPerson([
      { project: { id: 'p1', name: 'Rain line' }, members: [{ userId: 'u1' }, { userId: 'u2' }] },
      { project: { id: 'p2', name: 'Kit 2027' }, members: [{ userId: 'u1' }] },
    ])
    expect(byPerson).toEqual({ u1: ['Kit 2027', 'Rain line'], u2: ['Rain line'] })
    expect(projectsByPerson([])).toEqual({})
  })

  it('the team’s pop-ups draw in it and en: who is reached, who is left out and why, the step-up; Add to a project', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['team-pause', 'team-resend', 'team-project', 'team-selected', 'team-seats-full']) {
        const entry = peopleScreen.cases.find((item) => item.id === id)!
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(peopleScreen.view, { model: entry.model })))
        expect(html, `${id} (${locale})`).not.toMatch(KEY)
        expect(scanText(html, BRAND_BETA), `${id} (${locale})`).toEqual([])
      }
    }
    const draw = (id: string) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'portal']) }, createElement(peopleScreen.view, { model: peopleScreen.cases.find((item) => item.id === id)!.model })))
    // owb-po4.3: the team is on Your people now (its list: "People of your company").
    expect(draw('team-selected')).toContain('People of your company')
    // The pop-ups open in the browser only (the DS Modal draws after hydration): their words, from the catalogue.
    for (const locale of ['it', 'en'] as const) {
      const t = createTranslator(locale, CATALOGUE[locale]['portal-account'] ?? {})
      for (const act of ['resend', 'revoke', 'pause', 'giveBack'] as const) {
        for (const key of [`team.act.${act}`, `team.confirm.${act}.what`, `team.confirm.${act}.back`]) expect(t(key, { names: 'Luca Bianchi' }), `${key} ${locale}`).not.toMatch(/^team\.|\{/)
        expect(t(`team.confirm.${act}.titleN`, { count: 2 }), `${act} ${locale}`).toContain('2')
        expect(t(`team.receipt.${act}`, { names: 'Luca Bianchi', count: 1 }), `${act} ${locale}`).toContain('Luca Bianchi')
      }
    }
    const en = createTranslator('en', CATALOGUE.en['portal-account'] ?? {})
    expect(en('team.confirm.pause.titleN', { count: 2 })).toBe('Pause the access of 2 colleagues?')
    expect(en('team.skipped', { name: 'Marco Prova', why: en('team.held.notActive') })).toBe('Left out — Marco Prova: Only for an active colleague.')
    expect(en('team.project.told')).toBe('Each one is told once, in their portal.')
  })
})
// ---- end F-CP-153

