import { LOCKED_REASON, PARTNER_EMAIL_TOPICS, TOPIC_WORDS, isTransactional } from '@nexus/factory-domain/portal/notifications/topics'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import type { EmailFrequency } from '../../shell/api'
import type { PortalBand } from '../../shell/frame'
import { badgesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { Colleague } from '../../shared/account/api'
import { colleagueRows, inviteProblems, sessionRows, type InviteDraft } from '../../shared/account/model'
import type { RoleChoice } from '../../shared/account/view/PeopleDialogs'
import type { DeliveryAddress } from './api'
import { addressRows, companyRows, EMPTY_ADDRESS, addressProblems } from './model'
import type { AccountDialog } from './view/AccountDialogs'
import { AccountCase, type AccountCaseBuilder } from './view/AccountCase'
import type { AccountViewModel } from './view/AccountView'

/**
 * SCR-188 — the customer's Account (B-W2b-196), every state with MADE-UP data only (no real customer, person, address or
 * number): the organisation's admin and a colleague who is not one, loading (and still loading), every card failed, only you
 * and no addresses, a role or portal the page does not open, an office preview, a profile and e-mail settings with changes,
 * colleagues chosen for Deactivate N, and every pop-up (Invite a colleague, its problems, Change role, Make an admin?,
 * Deactivate with the hand-over and with requests only they could answer, Delivery address, Remove addresses, Sign out the
 * others, the step-up code and a wrong one), and a receipt.
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
const NOW = Math.floor(Date.now() / HOUR) * HOUR
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const PREFIX = '/p/BRAND-ALPHA'
const words = (locale: Locale, namespace = 'portal-account') => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
const ME = '00000000-0000-7000-8000-0000000000a1'
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`

const LEGAL = {
  it: { name: 'Pelletteria Esempio S.r.l.', lines: ['Sede legale: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'P. IVA IT00000000000 · C.F. 00000000000'] },
  en: { name: 'Pelletteria Esempio S.r.l.', lines: ['Registered office: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'VAT IT00000000000 · Tax code 00000000000'] },
} as const
const ALL = (permission: string) => permission.startsWith('portal.') || permission === 'files.read' || permission === 'threads.read'

function shell(locale: Locale, band: PortalBand, over: Partial<PortalShellViewModel> = {}): PortalShellViewModel {
  return {
    brand: { name: 'Pelletteria Esempio', logoUrl: null, logoDarkUrl: null, accent: '#7a1f3d' },
    companyName: 'Pelletteria Esempio',
    partyName: 'Brand Alpha S.r.l.',
    person: { displayName: 'Anna Esempio', email: 'anna@brand-alpha.example' },
    nav: portalNavFor({ can: ALL, kinds: ['CUSTOMER'], everyPage: true }),
    path: '/account',
    prefix: PREFIX,
    badges: badgesOf([{ area: 'orders', count: 2, words: { it: '2 da confermare', en: '2 to confirm' } }], locale),
    bell: { unread: 1, complete: true },
    notice: null,
    band,
    live: 'live',
    legal: LEGAL[locale],
    privacyHref: '/privacy/00000000-0000-7000-8000-000000000001',
    termsHref: `${PREFIX}/terms`,
    freeForSuppliers: false,
    preview: false,
    canSearch: true,
    ...over,
  }
}

function band(locale: Locale, over: Partial<PortalBand> = {}, inviteHeld: string | null = null): PortalBand {
  const t = words(locale)
  return { title: t('title'), actions: [{ id: 'invite', label: t('users.invite'), variant: 'primary', heldReason: inviteHeld }], ...over }
}

const ROLE_KEYS = ['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer', 'customer-admin'] as const
const PRICES: Record<string, boolean> = { 'customer-buyer': true, 'customer-finance': true, 'customer-admin': true }

function roles(locale: Locale): RoleChoice[] {
  const t = words(locale)
  const names = words(locale, 'portal')
  return ROLE_KEYS.map((key) => ({ key, name: names(`role.${key}`), sees: t(`role.sees.${key}`), seesPrices: PRICES[key] === true, admin: key === 'customer-admin' }))
}

const person = (n: number, name: string, roleKey: string | null, status: Colleague['status'], lastSignIn: number | null, over: Partial<Colleague> = {}): Colleague => ({
  id: n === 1 ? ME : id(n),
  displayName: name,
  email: `${name.split(' ')[0]!.toLowerCase()}@brand-alpha.example`,
  status,
  roleKey,
  roleName: null,
  seesPrices: roleKey ? PRICES[roleKey] === true : false,
  admin: roleKey === 'customer-admin',
  capabilities: [],
  lastSignInAt: lastSignIn === null ? null : at(lastSignIn),
  invitationExpiresAt: status === 'INVITED' ? at(24 * 6) : null,
  version: 2,
  ...over,
})

const PEOPLE: Colleague[] = [
  person(1, 'Anna Esempio', 'customer-admin', 'ACTIVE', -1),
  person(2, 'Luca Bianchi', 'customer-buyer', 'ACTIVE', -26),
  person(3, 'Giulia Finta', 'customer-finance', 'ACTIVE', -24 * 3),
  person(4, 'Marco Prova', 'customer-quality', 'SUSPENDED', -24 * 20),
  person(5, 'Sara Campione', 'customer-viewer', 'INVITED', null),
]

function colleaguesOf(locale: Locale, people: readonly Colleague[], admin: boolean, selected: readonly string[] = []): AccountViewModel['colleagues'] {
  const shown = admin ? people : people.filter((entry) => entry.status === 'ACTIVE').map((entry) => ({ ...entry, email: null, lastSignInAt: null, invitationExpiresAt: null }))
  const answer = { me: admin ? ME : id(2), canManage: admin, admins: [{ id: ME, displayName: 'Anna Esempio', email: 'anna@brand-alpha.example' }], people: [...shown], roles: [], seats: admin ? { taken: people.length, max: 8 } : null }
  return {
    state: 'ready',
    rows: colleagueRows(answer).map((row) => ({ ...row, lastSignIn: row.lastSignInAt ? formatDateTime(row.lastSignInAt, { locale }) : null, invitationEnds: row.invitationExpiresAt ? formatDate(row.invitationExpiresAt, { locale }) : null })),
    canManage: admin,
    admins: admin ? [] : ['Anna Esempio'],
    seats: answer.seats,
    selected,
    readOnly: false,
  }
}

const address = (n: number, over: Partial<DeliveryAddress>): DeliveryAddress => ({
  id: id(100 + n),
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
  createdAt: at(-24 * 200),
  addedBy: { kind: 'FACTORY', name: null, you: false },
  requestedAt: null,
  decidedAt: null,
  ...over,
})

const ADDRESSES: DeliveryAddress[] = [
  address(1, { name: 'Magazzino Milano', line1: 'Via dei Magazzini Finti 12', contactName: 'Ufficio ricevimento', phone: '+39 02 0000 0000', isDefault: true }),
  address(2, { name: 'Negozio Firenze', line1: 'Piazza Esempio 3', postalCode: '50100', city: 'Firenze', province: 'FI', approval: { status: 'APPROVED', words: { it: '', en: '' }, refuseReason: null }, addedBy: { kind: 'COLLEAGUE', name: 'Luca Bianchi', you: false }, requestedAt: at(-24 * 30), decidedAt: at(-24 * 29) }),
  address(3, { name: 'Showroom Torino', line1: 'Corso Finto 45', postalCode: '10100', city: 'Torino', province: 'TO', approval: { status: 'WAITING', words: { it: '', en: '' }, refuseReason: null }, addedBy: { kind: 'COLLEAGUE', name: 'Anna Esempio', you: true }, requestedAt: at(-5) }),
  address(4, { name: 'Deposito vecchio', line1: 'Via Prova 9', postalCode: '40100', city: 'Bologna', province: 'BO', status: 'ARCHIVED', approval: { status: 'REFUSED', words: { it: '', en: '' }, refuseReason: 'Il CAP non corrisponde alla città: scriveteci quello giusto.' }, addedBy: { kind: 'COLLEAGUE', name: 'Luca Bianchi', you: false }, requestedAt: at(-24 * 10), decidedAt: at(-24 * 9) }),
]

function addressesOf(locale: Locale, list: readonly DeliveryAddress[], admin: boolean, selected: readonly string[] = []): AccountViewModel['addresses'] {
  const t = words(locale)
  return {
    state: 'ready',
    rows: addressRows(list).map((row) => ({
      ...row,
      addedWords: row.addedBy.kind === 'FACTORY' ? t('addresses.addedByUs') : row.addedBy.you ? t('addresses.addedByYou') : t('addresses.addedBy', { name: row.addedBy.name ?? '—' }),
      checkedWords: row.state === 'WAITING' && row.requestedAt ? t('addresses.askedOn', { date: formatDate(row.requestedAt, { locale }) }) : row.state === 'APPROVED' && row.decidedAt ? t('addresses.checkedOn', { date: formatDate(row.decidedAt, { locale }) }) : null,
    })),
    canManage: admin,
    selected,
    readOnly: false,
  }
}

const COMPANY = {
  legalName: 'Brand Alpha S.r.l.',
  tradeName: 'Brand Alpha',
  kind: 'ORGANISATION',
  country: 'IT',
  currency: 'EUR',
  language: 'it',
  taxIdentity: { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000000001', fiscalCode: '00000000001', sdiRecipientCode: 'ABC1234', pec: 'fatture@brand-alpha.example', validFrom: '2024-01-01' },
  invoiceAddress: { name: 'Amministrazione', line1: 'Via Esempio 1', line2: null, postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
  registeredOffice: null,
  paymentTerms: { it: 'Bonifico 30 giorni data fattura', en: 'Bank transfer 30 days from the invoice' },
}

const SESSIONS = [
  { id: id(201), current: true, createdAt: at(-1), lastSeenAt: at(0), idleExpiresAt: at(0.5), absoluteExpiresAt: at(11), userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' },
  { id: id(202), current: false, createdAt: at(-5), lastSeenAt: at(-3), idleExpiresAt: at(0.2), absoluteExpiresAt: at(7), userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { id: id(203), current: false, createdAt: at(-9), lastSeenAt: at(-8.6), idleExpiresAt: at(0.1), absoluteExpiresAt: at(3), userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
]

function emailsOf(locale: Locale, changes = 0): AccountViewModel['emails'] {
  const chosen: Record<string, EmailFrequency> = { DATES: 'DAILY', CLAIMS: 'INSTANT', DOCUMENTS: changes > 0 ? 'OFF' : 'WEEKLY', MESSAGES: 'INSTANT', REMINDERS: 'WEEKLY' }
  return {
    state: 'ready',
    topics: PARTNER_EMAIL_TOPICS.map((topic) => ({ topic, name: TOPIC_WORDS[topic][locale], frequency: isTransactional(topic) ? 'INSTANT' : (chosen[topic] ?? 'DAILY'), locked: isTransactional(topic), reason: isTransactional(topic) ? LOCKED_REASON[locale] : null })),
    allOff: false,
    changes,
    saving: false,
    failed: null,
    readOnly: false,
  }
}

/** The organisation's admin, everything read. */
function page(locale: Locale, over: Partial<AccountViewModel> = {}): AccountViewModel {
  return {
    slow: false,
    profile: { state: 'ready', email: 'anna@brand-alpha.example', emailBy: { kind: 'us' }, draft: { displayName: 'Anna Esempio', locale }, theme: 'system', changes: 0, problem: null, saving: false, failed: null, readOnly: false },
    emails: emailsOf(locale),
    colleagues: colleaguesOf(locale, PEOPLE, true),
    addresses: addressesOf(locale, ADDRESSES, true),
    company: { state: 'ready', rows: companyRows(COMPANY, locale) },
    security: { state: 'ready', sessions: sessionRows(SESSIONS).map((row) => ({ ...row, started: formatDateTime(row.startedAt, { locale }), lastSeen: formatDateTime(row.lastSeenAt, { locale }) })), others: 2, readOnly: false },
    inviteHeld: null,
    receipt: null,
    dialog: null,
    ...over,
  }
}

/** A colleague who is not the admin: names and roles, "Your admin is …", nothing to manage. */
function colleaguePage(locale: Locale): AccountViewModel {
  const base = page(locale)
  return {
    ...base,
    profile: { ...base.profile, email: 'luca@brand-alpha.example', emailBy: { kind: 'admin', names: ['Anna Esempio'] }, draft: { displayName: 'Luca Bianchi', locale } },
    colleagues: colleaguesOf(locale, PEOPLE, false),
    addresses: addressesOf(locale, ADDRESSES, false),
    inviteHeld: words(locale)('held.adminInvites', { names: 'Anna Esempio' }),
  }
}

const loadingPage = (locale: Locale, slow: boolean): AccountViewModel => {
  const base = page(locale)
  return { ...base, slow, profile: { ...base.profile, state: 'loading' }, emails: { ...base.emails, state: 'loading' }, colleagues: { ...base.colleagues, state: 'loading', rows: [] }, addresses: { ...base.addresses, state: 'loading', rows: [] }, company: { state: 'loading', rows: [] }, security: { ...base.security, state: 'loading', sessions: [] }, inviteHeld: words(locale)('held.loading') }
}

const errorPage = (locale: Locale): AccountViewModel => {
  const base = page(locale)
  return { ...base, emails: { ...base.emails, state: 'error' }, colleagues: { ...base.colleagues, state: 'error', rows: [] }, addresses: { ...base.addresses, state: 'error', rows: [] }, company: { state: 'error', rows: [] }, security: { ...base.security, state: 'error', sessions: [] } }
}

const withDialog = (locale: Locale, dialog: AccountDialog, over: Partial<AccountViewModel> = {}): AccountCaseBuilder => () => ({ shell: shell(locale, band(locale)), page: { kind: 'account', model: page(locale, { dialog, ...over }) } })
const admin = (build: (locale: Locale) => AccountViewModel, bandOver: (locale: Locale) => Partial<PortalBand> = () => ({}), held: (locale: Locale) => string | null = () => null): AccountCaseBuilder => (locale) => ({ shell: shell(locale, band(locale, bandOver(locale), held(locale))), page: { kind: 'account', model: build(locale) } })
const dialogCase = (dialog: (locale: Locale) => AccountDialog, over: (locale: Locale) => Partial<AccountViewModel> = () => ({})): AccountCaseBuilder => (locale) => withDialog(locale, dialog(locale), over(locale))(locale)

const INVITE: InviteDraft = { displayName: '', email: '', locale: 'it', roleKey: 'customer-buyer' }
const TYPED_ADDRESS = { ...EMPTY_ADDRESS, name: 'Magazzino Verona', line1: 'Via Finta 8', postalCode: '37100', city: 'Verona', province: 'VR', contactName: 'Paolo Esempio', deliveryNotes: 'Banchina 2, 8–12' }

export const designScreen = defineDesignScreen<AccountCaseBuilder>({
  screen: 'SCR-188',
  title: 'Account (customer portal)',
  view: AccountCase,
  cases: [
    { id: 'admin', label: 'The organisation’s admin', model: admin((locale) => page(locale)), note: 'Profile + e-mail settings side by side; colleagues and addresses across the width; company data + sessions. The band’s primary: Invite a colleague.' },
    { id: 'colleague', label: 'A colleague (not the admin)', model: admin(colleaguePage, () => ({}), (locale) => words(locale)('held.adminInvites', { names: 'Anna Esempio' })), note: 'No-permission for colleagues: names and roles only, "Your admin is Anna Esempio"; Invite held with who can; addresses read-only.' },
    { id: 'loading', label: 'Loading', model: admin((locale) => loadingPage(locale, false)) },
    { id: 'loading-slow', label: 'Still loading after a second', model: admin((locale) => loadingPage(locale, true)) },
    { id: 'error', label: 'Every read failed', model: admin(errorPage), note: 'Each card says its problem with Try again; a failed read is never drawn as empty. The profile stays (it is the session’s).' },
    {
      id: 'empty',
      label: 'Only you, no addresses',
      model: admin((locale) => page(locale, { colleagues: colleaguesOf(locale, [PEOPLE[0]!], true), addresses: addressesOf(locale, [], true), security: { ...page(locale).security, sessions: page(locale).security.sessions.slice(0, 1), others: 0 } })),
      note: '"Only you so far." + Invite a colleague; "No delivery addresses yet." + Add; Sign out the others held (your only session).',
    },
    { id: 'no-permission', label: 'A role or portal without the page', model: (locale) => ({ shell: shell(locale, { title: words(locale)('title'), back: { href: PREFIX, label: words(locale)('closed.home') } }), page: { kind: 'closed', model: { homeHref: PREFIX, admins: ['Anna Esempio'] } } }) },
    {
      id: 'preview',
      label: 'Office preview (read-only)',
      model: admin(
        (locale) => {
          const base = page(locale, { inviteHeld: words(locale)('held.preview') })
          return { ...base, profile: { ...base.profile, readOnly: true }, emails: { ...base.emails, readOnly: true }, colleagues: { ...base.colleagues, readOnly: true, canManage: false }, addresses: { ...base.addresses, readOnly: true, canManage: false }, security: { ...base.security, readOnly: true, sessions: [], others: 0 } }
        },
        () => ({}),
        (locale) => words(locale)('held.preview'),
      ),
    },
    {
      id: 'profile-changed',
      label: 'Profile with a change (⌘S)',
      model: admin(
        (locale) => page(locale, { profile: { ...page(locale).profile, draft: { displayName: 'Anna M. Esempio', locale }, changes: 1 } }),
        (locale) => ({ status: { label: words(locale)('status.unsaved'), tone: 'warning' } }),
      ),
      note: 'The EditModeBar (⌘S, Discard); leaving asks Save / Discard / Stay (the frame).',
    },
    { id: 'profile-problem', label: 'Profile: the name emptied', model: admin((locale) => page(locale, { profile: { ...page(locale).profile, draft: { displayName: '', locale }, changes: 1, problem: 'profile.nameNeeded' } })) },
    { id: 'emails-changed', label: 'E-mail settings with a change', model: admin((locale) => page(locale, { emails: emailsOf(locale, 1) }), (locale) => ({ status: { label: words(locale)('status.unsaved'), tone: 'warning' } })) },
    { id: 'selected', label: 'Two colleagues chosen: Deactivate 2', model: admin((locale) => page(locale, { colleagues: colleaguesOf(locale, PEOPLE, true, [id(3), id(5)]), addresses: addressesOf(locale, ADDRESSES, true, [id(102)]) })), note: 'The bulk actions take the toolbar while rows are chosen; your own row cannot be chosen (its box says why).' },
    {
      id: 'receipt',
      label: 'After an invitation',
      model: admin((locale) => page(locale, { receipt: { tone: 'success', text: words(locale)('receipt.invited', { name: 'Paolo Esempio', email: 'paolo@brand-alpha.example', date: formatDate(at(24 * 7), { locale }) }) } })),
    },
    { id: 'invite', label: 'Pop-up: Invite a colleague', model: dialogCase((locale) => ({ kind: 'invite', draft: { ...INVITE, locale }, roles: roles(locale).filter((role) => role.key !== 'customer-admin').concat(roles(locale).filter((role) => role.key === 'customer-admin')), problems: inviteProblems(INVITE), showProblems: false, busy: false, failed: null })), note: 'Each role says what it sees (prices yes or no) before the invite.' },
    {
      id: 'invite-problems',
      label: 'Pop-up: Invite with problems',
      model: dialogCase((locale) => {
        const draft = { ...INVITE, locale, email: 'paolo@', roleKey: '' }
        return { kind: 'invite', draft, roles: roles(locale), problems: inviteProblems(draft), showProblems: true, busy: false, failed: words(locale)('invite.failed.address') }
      }),
    },
    { id: 'role', label: 'Pop-up: Change role', model: dialogCase((locale) => ({ kind: 'role', person: { id: id(2), name: 'Luca Bianchi' }, current: 'customer-buyer', choice: 'customer-admin', roles: roles(locale), busy: false, failed: null })) },
    { id: 'role-raise', label: 'Pop-up: Make Luca an admin?', model: dialogCase(() => ({ kind: 'raise', person: { id: id(2), name: 'Luca Bianchi' }, busy: false, failed: null })), note: 'Admins invite and remove colleagues and see prices; the code by e-mail follows.' },
    {
      id: 'deactivate',
      label: 'Pop-up: Deactivate Luca Bianchi?',
      model: dialogCase(() => ({ kind: 'deactivate', people: [{ id: id(2), name: 'Luca Bianchi' }], state: 'ready', summary: { open: 3, assigned: 2, alone: [], options: [{ id: ME, name: 'Anna Esempio' }, { id: id(3), name: 'Giulia Finta' }] }, choice: id(3), busy: false, failed: null })),
      note: 'He can no longer sign in; the requests handed to him move to the colleague chosen, the rest stay with everyone who can answer.',
    },
    {
      id: 'deactivate-alone',
      label: 'Pop-up: Deactivate with requests only they could answer',
      model: dialogCase((locale) => ({
        kind: 'deactivate',
        people: [
          { id: id(3), name: 'Giulia Finta' },
          { id: id(5), name: 'Sara Campione' },
        ],
        state: 'ready',
        summary: { open: 1, assigned: 0, alone: [{ label: 'INV-2026-0042', words: locale === 'it' ? 'Paga la fattura INV-2026-0042' : 'Pay invoice INV-2026-0042' }], options: [] },
        choice: '',
        busy: false,
        failed: null,
      })),
    },
    { id: 'deactivate-loading', label: 'Pop-up: Deactivate, reading their requests', model: dialogCase(() => ({ kind: 'deactivate', people: [{ id: id(2), name: 'Luca Bianchi' }], state: 'loading', summary: null, choice: '', busy: false, failed: null })) },
    { id: 'address', label: 'Pop-up: Delivery address', model: dialogCase(() => ({ kind: 'address', draft: TYPED_ADDRESS, problems: addressProblems(TYPED_ADDRESS), showProblems: false, busy: false, failed: null })), note: '"We check new or changed addresses before the next delivery."' },
    {
      id: 'address-problems',
      label: 'Pop-up: Delivery address with problems',
      model: dialogCase(() => {
        const draft = { ...EMPTY_ADDRESS, line1: 'Via Finta 8', postalCode: '371', country: 'IT' }
        return { kind: 'address', draft, problems: addressProblems(draft), showProblems: true, busy: false, failed: null }
      }),
    },
    { id: 'remove', label: 'Pop-up: Remove addresses', model: dialogCase(() => ({ kind: 'remove', lines: ['Negozio Firenze — Piazza Esempio 3, 50100 Firenze (FI), IT'], busy: false, failed: null })) },
    { id: 'end-others', label: 'Pop-up: Sign out the others', model: dialogCase(() => ({ kind: 'endOthers', count: 2, busy: false, failed: null })) },
    { id: 'step-up', label: 'Pop-up: Confirm it’s you (code by e-mail)', model: dialogCase(() => ({ kind: 'stepUp', to: 'a…a@brand-alpha.example', busy: false, error: null })), note: 'Asked before an admin act when the session has no fresh code (5 minutes).' },
    { id: 'step-up-wrong', label: 'Pop-up: a wrong code', model: dialogCase((locale) => ({ kind: 'stepUp', to: 'a…a@brand-alpha.example', busy: false, error: words(locale)('stepUp.wrong') })) },
  ],
})
