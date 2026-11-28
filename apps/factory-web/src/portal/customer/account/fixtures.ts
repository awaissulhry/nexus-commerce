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
import { sessionRows } from '../../shared/account/model'
import type { DeliveryAddress } from './api'
import { addressRows, companyRows, EMPTY_ADDRESS, addressProblems } from './model'
import type { AccountDialog } from './view/AccountDialogs'
import { AccountCase, type AccountCaseBuilder } from './view/AccountCase'
import type { AccountViewModel } from './view/AccountView'

/**
 * SCR-188 — the customer's Account (B-W2b-196), every state with MADE-UP data only (no real customer, person, address or
 * number): the organisation's admin and a colleague who is not one, loading (and still loading), every card failed, no
 * addresses, a role or portal the page does not open, an office preview, a profile and e-mail settings with changes, an address
 * chosen to remove, every pop-up (Delivery address, Remove addresses, Sign out the others) and a receipt. owb-po4.3: the
 * colleagues, their pop-ups and the e-mail code moved with them to Your people (SCR-188-people); the "Your team" card opens it.
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
const NOW = Math.floor(Date.now() / HOUR) * HOUR
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const PREFIX = '/p/BRAND-ALPHA'
const words = (locale: Locale, namespace = 'portal-account') => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
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

function band(locale: Locale, over: Partial<PortalBand> = {}): PortalBand {
  return { title: words(locale)('title'), ...over }
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
    peopleHref: `${PREFIX}/people`,
    addresses: addressesOf(locale, ADDRESSES, true),
    company: { state: 'ready', rows: companyRows(COMPANY, locale) },
    security: { state: 'ready', sessions: sessionRows(SESSIONS).map((row) => ({ ...row, started: formatDateTime(row.startedAt, { locale }), lastSeen: formatDateTime(row.lastSeenAt, { locale }) })), others: 2, readOnly: false },
    receipt: null,
    dialog: null,
    ...over,
  }
}

/** A colleague who is not the admin: the admin changes their e-mail; addresses read-only. */
function colleaguePage(locale: Locale): AccountViewModel {
  const base = page(locale)
  return {
    ...base,
    profile: { ...base.profile, email: 'luca@brand-alpha.example', emailBy: { kind: 'admin', names: ['Anna Esempio'] }, draft: { displayName: 'Luca Bianchi', locale } },
    addresses: addressesOf(locale, ADDRESSES, false),
  }
}

const loadingPage = (locale: Locale, slow: boolean): AccountViewModel => {
  const base = page(locale)
  return { ...base, slow, profile: { ...base.profile, state: 'loading' }, emails: { ...base.emails, state: 'loading' }, addresses: { ...base.addresses, state: 'loading', rows: [] }, company: { state: 'loading', rows: [] }, security: { ...base.security, state: 'loading', sessions: [] } }
}

const errorPage = (locale: Locale): AccountViewModel => {
  const base = page(locale)
  return { ...base, emails: { ...base.emails, state: 'error' }, addresses: { ...base.addresses, state: 'error', rows: [] }, company: { state: 'error', rows: [] }, security: { ...base.security, state: 'error', sessions: [] } }
}

const withDialog = (locale: Locale, dialog: AccountDialog, over: Partial<AccountViewModel> = {}): AccountCaseBuilder => () => ({ shell: shell(locale, band(locale)), page: { kind: 'account', model: page(locale, { dialog, ...over }) } })
const admin = (build: (locale: Locale) => AccountViewModel, bandOver: (locale: Locale) => Partial<PortalBand> = () => ({})): AccountCaseBuilder => (locale) => ({ shell: shell(locale, band(locale, bandOver(locale))), page: { kind: 'account', model: build(locale) } })
const dialogCase = (dialog: (locale: Locale) => AccountDialog, over: (locale: Locale) => Partial<AccountViewModel> = () => ({})): AccountCaseBuilder => (locale) => withDialog(locale, dialog(locale), over(locale))(locale)

const TYPED_ADDRESS = { ...EMPTY_ADDRESS, name: 'Magazzino Verona', line1: 'Via Finta 8', postalCode: '37100', city: 'Verona', province: 'VR', contactName: 'Paolo Esempio', deliveryNotes: 'Banchina 2, 8–12' }

export const designScreen = defineDesignScreen<AccountCaseBuilder>({
  screen: 'SCR-188',
  title: 'Account (customer portal)',
  view: AccountCase,
  cases: [
    { id: 'admin', label: 'The organisation’s admin', model: admin((locale) => page(locale)), note: 'Profile + e-mail settings side by side; the "Your team" card opens Your people (owb-po4.3: the colleagues live there now); addresses across the width; company data + sessions.' },
    { id: 'colleague', label: 'A colleague (not the admin)', model: admin(colleaguePage), note: 'The admin (Anna Esempio) changes their e-mail; addresses read-only; the "Your team" card opens Your people.' },
    { id: 'loading', label: 'Loading', model: admin((locale) => loadingPage(locale, false)) },
    { id: 'loading-slow', label: 'Still loading after a second', model: admin((locale) => loadingPage(locale, true)) },
    { id: 'error', label: 'Every read failed', model: admin(errorPage), note: 'Each card says its problem with Try again; a failed read is never drawn as empty. The profile stays (it is the session’s).' },
    {
      id: 'empty',
      label: 'No addresses, one session',
      model: admin((locale) => page(locale, { addresses: addressesOf(locale, [], true), security: { ...page(locale).security, sessions: page(locale).security.sessions.slice(0, 1), others: 0 } })),
      note: '"No delivery addresses yet." + Add; Sign out the others held (your only session).',
    },
    { id: 'no-permission', label: 'A role or portal without the page', model: (locale) => ({ shell: shell(locale, { title: words(locale)('title'), back: { href: PREFIX, label: words(locale)('closed.home') } }), page: { kind: 'closed', model: { homeHref: PREFIX, admins: ['Anna Esempio'] } } }) },
    {
      id: 'preview',
      label: 'Office preview (read-only)',
      model: admin((locale) => {
        const base = page(locale)
        return { ...base, profile: { ...base.profile, readOnly: true }, emails: { ...base.emails, readOnly: true }, addresses: { ...base.addresses, readOnly: true, canManage: false }, security: { ...base.security, readOnly: true, sessions: [], others: 0 } }
      }),
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
    { id: 'selected', label: 'An address chosen: Remove', model: admin((locale) => page(locale, { addresses: addressesOf(locale, ADDRESSES, true, [id(102)]) })), note: 'The bulk action takes the toolbar while rows are chosen.' },
    { id: 'receipt', label: 'After a new address', model: admin((locale) => page(locale, { receipt: { tone: 'success', text: words(locale)('receipt.addressAdded', { address: 'Magazzino Verona' }) } })) },
    // owb-po4.3: the "Your team" card when Your people is not built (never a door to nowhere: the words, no link).
    { id: 'people-not-built', label: 'Your team: Your people not built (no link)', model: admin((locale) => page(locale, { peopleHref: null })) },
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
  ],
})
