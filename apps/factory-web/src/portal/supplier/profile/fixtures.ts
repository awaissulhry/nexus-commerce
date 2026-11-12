import { LOCKED_REASON, PARTNER_EMAIL_TOPICS, TOPIC_WORDS, isTransactional } from '@nexus/factory-domain/portal/notifications/topics'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import type { Colleague } from '../../shared/account/api'
import { colleagueRows, inviteProblems, sessionRows, type InviteDraft } from '../../shared/account/model'
import type { RoleChoice } from '../../shared/account/view/PeopleDialogs'
import { shellOf } from '../orders/design-data'
import type { ChangeRequest, ProfileAddress, ProfileContact, SupplierProfile } from './api'
import { profileBandOf } from './band'
import { addressLines, addressProblems, contactLines, contactProblems, EMPTY_ADDRESS, EMPTY_CONTACT, NO_EDITS, NS, sameEmails, sendHeld, type ChangeFacts, type ProfileEdits } from './model'
import type { ProfileDialog } from './view/ProfileDialogs'
import { ProfileCase, type ProfileCaseBuilder } from './view/ProfileCase'
// B-W2b-334: Profile › Bank details (made-up test IBANs in bank/demo.ts).
import { bankOf, IN_USE, REFUSED, TYPED as TYPED_IBAN, WAITING } from './bank/demo'
import { changeHeld as bankHeld, EMPTY_DRAFT, hasWaiting } from './bank/model'
import type { BankSectionModel } from './bank/view/BankSection'
import type { ProfileViewModel } from './view/ProfileView'

/**
 * SCR-191 — the supplier's Profile (B-W2b-193; design portal.supplier.profile), every state with MADE-UP data only: the
 * invented tannery Conceria Prova S.p.A. (its Admin Luca Prova, colleagues Sara, Paolo and Elena) working for the invented
 * Officina Demo. The Admin and a colleague who is not one, loading, still loading, a failed read, a role or kind without the
 * page, an office preview, changes typed and not sent (the EditModeBar), the send refused, two contacts with one e-mail, a
 * change waiting for our check with Withdraw and our last answers, and every pop-up (an address added or changed, with
 * problems; a contact; Withdraw; Invite a colleague; Make an admin?; Deactivate; Sign out the others; the step-up and a
 * wrong code); a receipt. Never a real company, person, address or number; never a price (C2).
 */

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-09T09:00:00Z')
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
const ME = '0190f0e2-7777-7000-8000-0000000000a1'
const id = (n: number) => `0190f0e2-7777-7000-8000-${String(n).padStart(12, '0')}`
const ADMINS = ['Luca Prova']

const address = (n: number, over: Partial<ProfileAddress>): ProfileAddress => ({
  id: id(100 + n),
  version: 2,
  kinds: ['PICKUP'],
  name: null,
  line1: 'Via delle Concerie Finte 1',
  line2: null,
  postalCode: '56029',
  city: 'Santa Croce sull’Arno',
  province: 'PI',
  country: 'IT',
  contactName: null,
  phone: null,
  deliveryNotes: null,
  isDefaultBillTo: false,
  isDefaultShipTo: false,
  waiting: false,
  ...over,
})

const ADDRESSES: ProfileAddress[] = [
  address(1, { kinds: ['REGISTERED'], name: 'Sede legale', line1: 'Via delle Concerie Finte 1' }),
  address(2, { kinds: ['PICKUP'], name: 'Magazzino ritiro', line1: 'Via del Ritiro Prova 14', contactName: 'Ufficio spedizioni', phone: '+39 0571 000000' }),
  address(3, { kinds: ['BILL_TO'], name: 'Amministrazione', line1: 'Piazza Esempio 3', isDefaultBillTo: true }),
  address(4, { kinds: ['PICKUP'], name: 'Deposito Ponte', line1: 'Via Finta 8', postalCode: '56020', city: 'Montopoli', waiting: true }),
]

const contact = (n: number, over: Partial<ProfileContact>): ProfileContact => ({ id: id(200 + n), version: 1, name: '', email: null, phone: null, roles: [], language: null, waiting: false, ...over })
const CONTACTS: ProfileContact[] = [
  contact(1, { name: 'Luca Prova', email: 'luca@conceria-prova.example', phone: '+39 0571 000001', roles: ['OWNER', 'ORDERS'] }),
  contact(2, { name: 'Sara Esempio', email: 'amministrazione@conceria-prova.example', roles: ['INVOICES'], language: 'it' }),
  contact(3, { name: 'Elena Campione', email: 'qualita@conceria-prova.example', phone: '+39 0571 000003', roles: ['QUALITY'], waiting: true }),
]

const request = (n: number, over: Partial<ChangeRequest>): ChangeRequest => ({ requestId: id(300 + n), state: 'OPEN', sentAt: at(-24 * 12), sentBy: 'Luca Prova', note: null, changes: [], decidedAt: null, decidedBy: null, reason: null, ...over })
const PENDING: ChangeRequest[] = [
  request(1, {
    changes: [
      { target: 'ADDRESS', op: 'ADD', id: null, before: null, after: { name: 'Deposito Ponte', line1: 'Via Finta 8', line2: null, postalCode: '56020', city: 'Montopoli', province: 'PI', country: 'IT' }, changed: [] },
      { target: 'CONTACT', op: 'CHANGE', id: id(203), before: { name: 'Elena Campione', phone: null }, after: { name: 'Elena Campione', phone: '+39 0571 000003' }, changed: ['phone'] },
    ],
  }),
]
const DECIDED: ChangeRequest[] = [
  request(2, { state: 'APPROVED', sentAt: at(-24 * 40), decidedAt: at(-24 * 38), decidedBy: 'Giulia Demo', changes: [{ target: 'COMPANY', op: 'CHANGE', id: id(900), before: { website: null }, after: { website: 'https://conceria-prova.example' }, changed: ['website'] }] }),
  request(3, { state: 'REFUSED', sentAt: at(-24 * 60), decidedAt: at(-24 * 59), decidedBy: 'Giulia Demo', reason: 'Per cambiare la sede legale ci serve la visura camerale aggiornata.', changes: [{ target: 'ADDRESS', op: 'CHANGE', id: id(101), before: { line1: 'Via delle Concerie Finte 1' }, after: { line1: 'Via delle Concerie Finte 3' }, changed: ['line1'] }] }),
]

function profile(over: Partial<SupplierProfile> = {}): SupplierProfile {
  return {
    company: { code: 'CONCERIA-PROVA', legalName: 'Conceria Prova S.p.A.', tradeName: 'Conceria Prova', country: 'IT', vatNumber: 'IT00000000002', fiscalCode: '00000000002', website: 'https://conceria-prova.example', waiting: false },
    addresses: ADDRESSES,
    contacts: CONTACTS,
    pending: PENDING,
    decided: DECIDED,
    mayChange: true,
    limits: { changes: 20, addressKinds: ['REGISTERED', 'PICKUP'], contactRoles: ['ORDERS', 'INVOICES', 'QUALITY', 'DESIGN', 'OWNER'] },
    live: { events: ['supplier_profile.change_decided'] },
    ...over,
  }
}

const ROLE_KEYS = ['supplier-orders', 'supplier-invoices', 'supplier-quality', 'supplier-admin'] as const
function roles(locale: Locale): RoleChoice[] {
  const t = words(locale)
  const names = words(locale, 'portal')
  return ROLE_KEYS.map((key) => ({ key, name: names(`role.${key}`), sees: t(`role.sees.${key}`), seesPrices: false, admin: key === 'supplier-admin' }))
}

const person = (n: number, name: string, roleKey: string, status: Colleague['status'], lastSignIn: number | null): Colleague => ({
  id: n === 1 ? ME : id(n),
  displayName: name,
  email: `${name.split(' ')[0]!.toLowerCase()}@conceria-prova.example`,
  status,
  roleKey,
  roleName: null,
  seesPrices: false,
  admin: roleKey === 'supplier-admin',
  capabilities: [],
  lastSignInAt: lastSignIn === null ? null : at(lastSignIn),
  invitationExpiresAt: status === 'INVITED' ? at(24 * 6) : null,
  version: 2,
})
const PEOPLE: Colleague[] = [person(1, 'Luca Prova', 'supplier-admin', 'ACTIVE', -1), person(2, 'Sara Esempio', 'supplier-invoices', 'ACTIVE', -30), person(3, 'Elena Campione', 'supplier-quality', 'ACTIVE', -24 * 2), person(4, 'Paolo Finto', 'supplier-orders', 'INVITED', null)]

function colleaguesOf(locale: Locale, admin: boolean, selected: readonly string[] = []): ProfileViewModel['colleagues'] {
  const shown = admin ? PEOPLE : PEOPLE.filter((entry) => entry.status === 'ACTIVE').map((entry) => ({ ...entry, email: null, lastSignInAt: null, invitationExpiresAt: null }))
  const answer = { me: admin ? ME : id(3), canManage: admin, admins: [{ id: ME, displayName: 'Luca Prova', email: 'luca@conceria-prova.example' }], people: shown, roles: [], seats: admin ? { taken: PEOPLE.length, max: 10 } : null }
  return {
    state: 'ready',
    rows: colleagueRows(answer).map((row) => ({ ...row, lastSignIn: row.lastSignInAt ? formatDateTime(row.lastSignInAt, { locale }) : null, invitationEnds: row.invitationExpiresAt ? formatDate(row.invitationExpiresAt, { locale }) : null })),
    canManage: admin,
    admins: admin ? [] : ADMINS,
    seats: answer.seats,
    selected,
    readOnly: false,
  }
}

const SESSIONS = [
  { id: id(401), current: true, createdAt: at(-1), lastSeenAt: at(0), idleExpiresAt: at(0.5), absoluteExpiresAt: at(11), userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
  { id: id(402), current: false, createdAt: at(-6), lastSeenAt: at(-4), idleExpiresAt: at(0.2), absoluteExpiresAt: at(6), userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' },
]

function page(locale: Locale, input: { read?: SupplierProfile; edits?: ProfileEdits; facts?: Partial<ChangeFacts>; admin?: boolean; over?: Partial<ProfileViewModel> } = {}): ProfileViewModel {
  const read = input.read ?? profile()
  const admin = input.admin ?? true
  const facts: ChangeFacts = { preview: false, offline: false, mayChange: read.mayChange, ...input.facts }
  const held = facts.preview ? 'held.previewChange' : !facts.mayChange ? 'held.adminChanges' : facts.offline ? 'held.offline' : null
  const edits = input.edits ?? NO_EDITS
  const addresses = addressLines(read, edits, held)
  const contacts = contactLines(read, edits, held)
  const count = (edits.website !== null ? 1 : 0) + edits.addresses.length + edits.contacts.length
  return {
    slow: false,
    company: { state: 'ready', company: read.company, website: edits.website ?? read.company.website ?? '', websiteChanged: edits.website !== null, websiteProblem: null, addresses, selected: [], held, admins: ADMINS },
    contacts: { state: 'ready', rows: contacts, selected: [], held, admins: ADMINS, sameEmails: sameEmails(contacts) },
    changes: { pending: read.pending, decided: read.decided, held, admins: ADMINS },
    colleagues: colleaguesOf(locale, admin),
    inviteHeld: admin ? null : words(locale, 'portal-account')('held.adminInvites', { names: 'Luca Prova' }),
    emails: {
      state: 'ready',
      topics: PARTNER_EMAIL_TOPICS.map((topic) => ({ topic, name: TOPIC_WORDS[topic][locale], frequency: isTransactional(topic) ? 'INSTANT' : 'DAILY', locked: isTransactional(topic), reason: isTransactional(topic) ? LOCKED_REASON[locale] : null })),
      allOff: false,
      changes: 0,
      saving: false,
      failed: null,
      readOnly: facts.preview,
    },
    security: { state: 'ready', sessions: facts.preview ? [] : sessionRows(SESSIONS).map((row) => ({ ...row, started: formatDateTime(row.startedAt, { locale }), lastSeen: formatDateTime(row.lastSeenAt, { locale }) })), others: facts.preview ? 0 : 1, readOnly: facts.preview },
    edit: { count, sending: false, held: sendHeld(edits, contacts, facts, false), failed: null },
    receipt: null,
    dialog: null,
    ...input.over,
  }
}

function pageCase(build: (locale: Locale) => Parameters<typeof page>[1] & { preview?: boolean }): ProfileCaseBuilder {
  return (locale) => {
    const input = build(locale)
    const model = page(locale, input)
    const t = words(locale)
    const band = profileBandOf({ t, sending: model.edit.sending, unsaved: model.edit.count > 0, waiting: model.changes.pending.length > 0, saved: false, inviteHeld: input.preview ? words(locale, 'portal-account')('held.preview') : model.inviteHeld })
    return { shell: shellOf(locale, { path: '/profile', preview: input.preview ?? false, band }), body: { kind: 'page', model } }
  }
}

const TYPED: ProfileEdits = {
  website: 'https://www.conceria-prova.example',
  addresses: [
    { op: 'CHANGE', id: id(102), version: 2, draft: { ...EMPTY_ADDRESS, kinds: ['PICKUP'], name: 'Magazzino ritiro', line1: 'Via del Ritiro Prova 16', postalCode: '56029', city: 'Santa Croce sull’Arno', province: 'PI', country: 'IT', contactName: 'Ufficio spedizioni', phone: '+39 0571 000000', line2: '', deliveryNotes: '' } },
  ],
  contacts: [
    { op: 'ADD', key: 'new-1', draft: { ...EMPTY_CONTACT, name: 'Marco Prova', email: 'ordini@conceria-prova.example', roles: ['ORDERS'] } },
    { op: 'REMOVE', id: id(202), version: 1 },
  ],
}
const SAME_EMAIL: ProfileEdits = { ...NO_EDITS, contacts: [{ op: 'ADD', key: 'new-2', draft: { ...EMPTY_CONTACT, name: 'Marco Prova', email: 'luca@conceria-prova.example', roles: ['ORDERS'] } }] }

const dialogCase = (dialog: (locale: Locale) => ProfileDialog, over: Parameters<typeof page>[1] = {}): ProfileCaseBuilder => pageCase((locale) => ({ ...over, over: { ...over.over, dialog: dialog(locale) } }))
const NEW_ADDRESS = { ...EMPTY_ADDRESS, name: 'Deposito Nord', line1: 'Via Esempio 20', postalCode: '56020', city: 'San Miniato', province: 'PI' }
const BAD_ADDRESS = { ...EMPTY_ADDRESS, kinds: [], line1: 'Via Esempio 20', postalCode: '5602', city: '' }
const INVITE: InviteDraft = { displayName: '', email: '', locale: 'it', roleKey: 'supplier-orders' }

/** B-W2b-334: a case with the Bank details section (its own model beside the page's). */
const bankCase = (bank: (locale: Locale) => Partial<BankSectionModel> & { read?: ReturnType<typeof bankOf> | null }, over: { admin?: boolean; preview?: boolean } = {}): ProfileCaseBuilder => {
  const base = pageCase(() => ({ ...(over.admin === false ? { admin: false, read: profile({ mayChange: false }) } : {}), ...(over.preview ? { preview: true, facts: { preview: true } } : {}) }))
  return (locale) => {
    const built = base(locale)
    if (built.body.kind !== 'page') return built
    const input = bank(locale)
    const read = input.read === undefined ? bankOf([IN_USE]) : input.read
    const value = read ? { ...read, mayPropose: over.admin === false ? false : read.mayPropose } : null
    const model: BankSectionModel = {
      state: value ? 'ready' : 'loading',
      slow: false,
      bank: value,
      held: value ? bankHeld({ preview: over.preview === true, offline: false, mayPropose: value.mayPropose, waiting: hasWaiting(value) }) : null,
      dialog: null,
      receipt: null,
      ...input,
    }
    return { ...built, body: { ...built.body, bank: model } }
  }
}

export const designScreen = defineDesignScreen<ProfileCaseBuilder>({
  screen: 'SCR-191',
  title: 'Profile (supplier portal)',
  view: ProfileCase,
  cases: [
    { id: 'admin', label: 'The supplier’s admin', model: pageCase(() => ({})), note: 'Company (legal name and VAT read-only, website, addresses: ours to set marked), a change waiting for our check since 28 Oct with Withdraw and our last answers, contacts, portal users (no prices column, C2), e-mail settings and sessions. Band: “Changes waiting for our check” + Invite a colleague.' },
    { id: 'colleague', label: 'A colleague (not the admin)', model: pageCase(() => ({ admin: false, read: profile({ mayChange: false }) })), note: 'Read-only: “Only your admin (Luca Prova) sends changes of your company data”; names and roles of colleagues; Invite held with who can.' },
    { id: 'loading', label: 'Loading', model: pageCase((locale) => ({ over: { company: { ...page(locale).company, state: 'loading', company: null, addresses: [] }, contacts: { ...page(locale).contacts, state: 'loading', rows: [] }, changes: { pending: [], decided: [], held: null, admins: ADMINS }, colleagues: { ...colleaguesOf(locale, true), state: 'loading', rows: [] }, emails: { ...page(locale).emails, state: 'loading' }, security: { ...page(locale).security, state: 'loading', sessions: [] } } })) },
    { id: 'loading-slow', label: 'Still loading after a second', model: pageCase((locale) => ({ over: { slow: true, company: { ...page(locale).company, state: 'loading', company: null, addresses: [] }, contacts: { ...page(locale).contacts, state: 'loading', rows: [] }, changes: { pending: [], decided: [], held: null, admins: ADMINS } } })) },
    { id: 'error', label: 'Every read failed', model: pageCase((locale) => ({ over: { company: { ...page(locale).company, state: 'error', company: null, addresses: [] }, contacts: { ...page(locale).contacts, state: 'error', rows: [] }, changes: { pending: [], decided: [], held: null, admins: ADMINS }, colleagues: { ...colleaguesOf(locale, true), state: 'error', rows: [] }, emails: { ...page(locale).emails, state: 'error' }, security: { ...page(locale).security, state: 'error', sessions: [] } } })), note: 'Each card says its problem with Try again; a failed read is never drawn as empty.' },
    { id: 'no-permission', label: 'Not part of the person’s access', model: (locale) => ({ shell: shellOf(locale, { path: '/profile', band: { title: words(locale)('profile.title') } }), body: { kind: 'noAccess', admins: ADMINS } }) },
    { id: 'preview', label: 'An office preview', model: pageCase(() => ({ preview: true, facts: { preview: true } })), note: 'Every change, Withdraw and Invite are held: “This is a preview of the portal: nothing can be changed here.”; e-mail settings and sessions are each person’s own.' },
    { id: 'typed', label: 'Changes typed, not sent yet (⌘S)', model: pageCase(() => ({ edits: TYPED })), note: 'Website, a pickup address changed, a contact added and one to remove: marked on their rows; the EditModeBar “Send changes for our check” (4); Undo on each row.' },
    { id: 'send-refused', label: 'The send refused (a change of it waits already)', model: pageCase((locale) => ({ edits: TYPED, over: { edit: { ...page(locale, { edits: TYPED }).edit, failed: 'profile.failed.clash' } } })) },
    { id: 'same-email', label: 'Two contacts with one e-mail', model: pageCase(() => ({ edits: SAME_EMAIL })), note: 'Send is held: one address per contact.' },
    { id: 'nothing-waiting', label: 'Nothing waiting, no answers yet', model: pageCase(() => ({ read: profile({ pending: [], decided: [], addresses: ADDRESSES.map((row) => ({ ...row, waiting: false })), contacts: CONTACTS.map((row) => ({ ...row, waiting: false })) }) })) },
    { id: 'receipt', label: 'After sending changes', model: pageCase((locale) => ({ over: { receipt: { tone: 'success', text: words(locale)('receipt.changesSent', { count: 4 }) } } })) },
    { id: 'address', label: 'Pop-up: add an address', model: dialogCase(() => ({ kind: 'address', id: null, draft: NEW_ADDRESS, adding: true, problems: addressProblems(NEW_ADDRESS, true), showProblems: false })), note: 'Your registered office or a pickup address; invoices and deliveries are ours to set. Nothing is sent until “Send changes for our check”.' },
    { id: 'address-problems', label: 'Pop-up: an address with problems', model: dialogCase(() => ({ kind: 'address', id: null, draft: BAD_ADDRESS, adding: true, problems: addressProblems(BAD_ADDRESS, true), showProblems: true })) },
    { id: 'address-edit', label: 'Pop-up: change an address', model: dialogCase(() => ({ kind: 'address', id: id(102), draft: { ...EMPTY_ADDRESS, name: 'Magazzino ritiro', line1: 'Via del Ritiro Prova 14', postalCode: '56029', city: 'Santa Croce sull’Arno', province: 'PI', contactName: 'Ufficio spedizioni', phone: '+39 0571 000000' }, adding: false, problems: {}, showProblems: false })) },
    { id: 'contact', label: 'Pop-up: add a contact', model: dialogCase(() => ({ kind: 'contact', id: null, draft: { ...EMPTY_CONTACT, name: 'Marco Prova', email: 'ordini@conceria-prova.example', roles: ['ORDERS'] }, adding: true, problems: {}, showProblems: false })) },
    {
      id: 'contact-problems',
      label: 'Pop-up: a contact with problems',
      model: dialogCase(() => {
        const draft = { ...EMPTY_CONTACT, name: 'Marco Prova', roles: ['INVOICES'], phone: 'abc' }
        return { kind: 'contact', id: null, draft, adding: true, problems: contactProblems(draft), showProblems: true }
      }),
      note: 'A contact for invoices has an e-mail (the documents go to it).',
    },
    { id: 'withdraw', label: 'Pop-up: withdraw a change', model: dialogCase((locale) => ({ kind: 'withdraw', requestId: id(301), lines: [words(locale)('profile.change.ADDRESS.ADD', { what: 'Deposito Ponte' }), words(locale)('profile.change.CONTACT.CHANGE', { what: 'Elena Campione' })], busy: false, failed: null })) },
    { id: 'invite', label: 'Pop-up: Invite a colleague', model: dialogCase((locale) => ({ kind: 'invite', draft: { ...INVITE, locale }, roles: roles(locale), problems: inviteProblems(INVITE), showProblems: false, busy: false, failed: null })), note: 'Each role says what it covers; never a price (C2).' },
    { id: 'role-raise', label: 'Pop-up: Make Elena an admin?', model: dialogCase(() => ({ kind: 'raise', person: { id: id(3), name: 'Elena Campione' }, busy: false, failed: null })) },
    { id: 'deactivate', label: 'Pop-up: Deactivate Sara Esempio?', model: dialogCase(() => ({ kind: 'deactivate', people: [{ id: id(2), name: 'Sara Esempio' }], state: 'ready', summary: { open: 2, assigned: 1, alone: [], options: [{ id: ME, name: 'Luca Prova' }, { id: id(3), name: 'Elena Campione' }] }, choice: ME, busy: false, failed: null })) },
    { id: 'end-others', label: 'Pop-up: Sign out the others', model: dialogCase(() => ({ kind: 'endOthers', count: 1, busy: false, failed: null })) },
    { id: 'step-up', label: 'Pop-up: Confirm it’s you (code by e-mail)', model: dialogCase(() => ({ kind: 'stepUp', to: 'l…a@conceria-prova.example', busy: false, error: null })), note: 'Asked before an admin act when the session has no fresh code (5 minutes).' },
    { id: 'w2b-334-bank', label: 'W2b Bank details: the account in use (masked), Last changed', model: bankCase(() => ({})), note: 'Between the contacts and the portal users; Change bank details asks a code by e-mail first.' },
    { id: 'w2b-334-bank-waiting', label: 'W2b Bank details: a change waiting for our call-back', model: bankCase(() => ({ read: bankOf([IN_USE, WAITING]) })), note: '"Waiting: we call you on your registered number …"; Change bank details held: one change at a time.' },
    { id: 'w2b-334-bank-refused', label: 'W2b Bank details: the last change refused, with why', model: bankCase(() => ({ read: bankOf([IN_USE, REFUSED]) })) },
    { id: 'w2b-334-bank-none', label: 'W2b Bank details: no account with us yet', model: bankCase(() => ({ read: bankOf([]) })) },
    { id: 'w2b-334-bank-colleague', label: 'W2b Bank details: a colleague (only the admin changes them)', model: bankCase(() => ({}), { admin: false }) },
    { id: 'w2b-334-bank-preview', label: 'W2b Bank details: an office preview (held)', model: bankCase(() => ({}), { preview: true }) },
    { id: 'w2b-334-bank-step-up', label: 'W2b Bank details: Confirm it’s you (a code by e-mail)', model: bankCase(() => ({ dialog: { kind: 'stepUp', to: 'l…a@conceria-prova.example', busy: false, error: null } })) },
    { id: 'w2b-334-bank-form', label: 'W2b New bank details: the IBAN checked as typed (a digit wrong)', model: bankCase(() => ({ dialog: { kind: 'form', draft: { ...EMPTY_DRAFT, iban: 'IT11 X000 0000 0000 0000 0315 002', holder: 'Conceria Prova S.p.A.' }, tried: true } })) },
    { id: 'w2b-334-bank-review', label: 'W2b New bank details: the review old → new, both masked', model: bankCase(() => ({ dialog: { kind: 'review', draft: { ...EMPTY_DRAFT, iban: TYPED_IBAN, holder: 'Conceria Prova S.p.A.', bankName: 'Banca Prova' }, sending: false, failed: null } })) },
    { id: 'w2b-334-bank-refused-send', label: 'W2b New bank details: the send refused (a change waits already)', model: bankCase(() => ({ dialog: { kind: 'review', draft: { ...EMPTY_DRAFT, iban: TYPED_IBAN, holder: 'Conceria Prova S.p.A.' }, sending: false, failed: 'portalBank.failed.clash' } })) },
    { id: 'w2b-334-bank-sent', label: 'W2b Bank details: sent for our check', model: bankCase((locale) => ({ read: bankOf([IN_USE, WAITING]), receipt: words(locale, 'purchasing-suppliers-depth')('portalBank.sent') })) },
    { id: 'w2b-334-bank-loading', label: 'W2b Bank details: loading', model: bankCase(() => ({ read: null })) },
    { id: 'w2b-334-bank-error', label: "W2b Bank details: couldn't load", model: bankCase(() => ({ read: null, state: 'error' })) },
    { id: 'step-up-wrong', label: 'Pop-up: a wrong code', model: dialogCase((locale) => ({ kind: 'stepUp', to: 'l…a@conceria-prova.example', busy: false, error: words(locale, 'portal-account')('stepUp.wrong') })) },
  ],
})
