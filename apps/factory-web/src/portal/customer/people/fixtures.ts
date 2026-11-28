import { defineDesignScreen } from '../../../lib/design/design-screen'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import type { PortalBand } from '../../shell/frame'
import { badgesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { Colleague } from '../../shared/account/api'
import { colleagueRows, inviteProblems, type InviteDraft } from '../../shared/account/model'
import type { PeopleDialog, RoleChoice } from '../../shared/account/view/PeopleDialogs'
import { factoryRowsOf } from './model'
import { PeopleCase, type PeopleCaseBuilder } from './view/PeopleCase'
import type { PeopleViewModel } from './view/PeopleView'

/**
 * SCR-188-people — People › Your people (owb-po4.3; the colleagues and their pop-ups moved here from SCR-188), every state with
 * MADE-UP data only (no real customer, person or number): the organisation's admin and a colleague who is not one, loading, the
 * list failed, only you, the factory's people for the brand (some, none, and no read yet: no card), an office preview, colleagues
 * chosen (Deactivate N; Pause · Give access back · Add to a project), every place taken, a receipt, a role or portal the page does
 * not open, and every pop-up (Invite a colleague and its problems, Change role, Make an admin?, Deactivate with the hand-over and
 * with requests only they could answer, the team's acts, Add to a project, the e-mail code and a wrong one).
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
    nav: portalNavFor({ can: ALL, kinds: ['CUSTOMER'], everyPage: true, prices: true }),
    path: '/people',
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

function band(locale: Locale, inviteHeld: string | null = null): PortalBand {
  const t = words(locale)
  return { title: t('people.title'), actions: [{ id: 'invite', label: t('users.invite'), variant: 'primary', heldReason: inviteHeld }] }
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

function colleaguesOf(locale: Locale, people: readonly Colleague[], admin: boolean, selected: readonly string[] = []): PeopleViewModel['colleagues'] {
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
    // F-CP-153: a customer's admin — its further acts, the seats, the Projects column (the reader's own projects only).
    customer: true,
    seatsFull: false,
    projectCount: admin ? 2 : 0,
    projects: admin ? { [ME]: ['Kit 2027', 'Rain line'], [id(2)]: ['Kit 2027'], [id(3)]: [] } : null,
  }
}

// The factory's people for the brand (made up): office people the factory gave this customer — names and role words, letters or an icon.
const FACTORY = {
  people: [
    { id: id(801), name: 'Sam Esempio', role: { en: 'Sales for your brand', it: 'Vendite per il vostro marchio' }, picture: { kind: 'LETTERS' as const, icon: null, colour: 'blue', letters: '' } },
    { id: id(802), name: 'Dina Prova', role: { en: 'Factory designer', it: 'Designer della fabbrica' }, picture: { kind: 'ICON' as const, icon: 'image', colour: 'violet', letters: '' } },
  ],
}

/** The organisation's admin, everything read. */
function page(locale: Locale, over: Partial<PeopleViewModel> = {}): PeopleViewModel {
  return {
    slow: false,
    colleagues: colleaguesOf(locale, PEOPLE, true),
    inviteHeld: null,
    factory: factoryRowsOf(FACTORY, locale),
    receipt: null,
    dialog: null,
    ...over,
  }
}

const people = (build: (locale: Locale) => PeopleViewModel, held: (locale: Locale) => string | null = () => null): PeopleCaseBuilder => (locale) => ({ shell: shell(locale, band(locale, held(locale))), page: { kind: 'people', model: build(locale) } })
const dialogCase = (dialog: (locale: Locale) => PeopleDialog): PeopleCaseBuilder => (locale) => ({ shell: shell(locale, band(locale)), page: { kind: 'people', model: page(locale, { dialog: dialog(locale) }) } })

const INVITE: InviteDraft = { displayName: '', email: '', locale: 'it', roleKey: 'customer-buyer' }

export const designScreen = defineDesignScreen<PeopleCaseBuilder>({
  screen: 'SCR-188-people',
  title: 'Your people (customer portal)',
  view: PeopleCase,
  cases: [
    { id: 'admin', label: 'The organisation’s admin', model: people((locale) => page(locale)), note: 'People of your company: name, e-mail, role, what the role does, sees prices, last sign-in, status, projects, ⋯; the factory’s people for the brand under it; the wall in one line. The band’s primary: Invite a colleague.' },
    { id: 'colleague', label: 'A colleague (not the admin)', model: people((locale) => page(locale, { colleagues: colleaguesOf(locale, PEOPLE, false), inviteHeld: words(locale)('held.adminInvites', { names: 'Anna Esempio' }) }), (locale) => words(locale)('held.adminInvites', { names: 'Anna Esempio' })), note: 'Names, roles and what each does only; "Your admin is Anna Esempio"; Invite held with who can.' },
    { id: 'loading', label: 'Loading', model: people((locale) => page(locale, { colleagues: { ...colleaguesOf(locale, PEOPLE, true), state: 'loading', rows: [] }, inviteHeld: words(locale)('held.loading'), factory: null }), (locale) => words(locale)('held.loading')) },
    { id: 'error', label: 'The list failed', model: people((locale) => page(locale, { colleagues: { ...colleaguesOf(locale, PEOPLE, true), state: 'error', rows: [] } })), note: 'The problem in our words + Try again; a failed read is never drawn as empty.' },
    { id: 'empty', label: 'Only you so far', model: people((locale) => page(locale, { colleagues: colleaguesOf(locale, [PEOPLE[0]!], true) })), note: '"Only you so far." + Invite a colleague.' },
    { id: 'factory-none', label: 'The factory gave nobody to your brand yet', model: people((locale) => page(locale, { factory: [] })), note: 'The card stays (the read answered) and says so in one line.' },
    { id: 'factory-not-read', label: 'No factory people read (not built yet, or it failed): no card', model: people((locale) => page(locale, { factory: null })), note: 'Never an empty card that says "nobody" when nothing was read.' },
    {
      id: 'preview',
      label: 'Office preview (read-only)',
      model: people((locale) => page(locale, { colleagues: { ...colleaguesOf(locale, PEOPLE, true), readOnly: true, canManage: false }, inviteHeld: words(locale)('held.preview') }), (locale) => words(locale)('held.preview')),
    },
    { id: 'selected', label: 'Two colleagues chosen: Deactivate 2', model: people((locale) => page(locale, { colleagues: colleaguesOf(locale, PEOPLE, true, [id(3), id(5)]) })), note: 'The bulk actions take the toolbar while rows are chosen; your own row cannot be chosen (its box says why).' },
    {
      id: 'receipt',
      label: 'After an invitation',
      model: people((locale) => page(locale, { receipt: { tone: 'success', text: words(locale)('receipt.invited', { name: 'Paolo Esempio', email: 'paolo@brand-alpha.example', date: formatDate(at(24 * 7), { locale }) }) } })),
    },
    { id: 'no-permission', label: 'A role or portal without the page', model: (locale) => ({ shell: shell(locale, { title: words(locale)('people.title'), back: { href: PREFIX, label: words(locale)('closed.home') } }), page: { kind: 'closed', model: { homeHref: PREFIX, admins: ['Anna Esempio'], title: words(locale)('people.closed') } } }) },
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
    { id: 'step-up', label: 'Pop-up: Confirm it’s you (code by e-mail)', model: dialogCase(() => ({ kind: 'stepUp', to: 'a…a@brand-alpha.example', busy: false, error: null })), note: 'Asked before an admin act when the session has no fresh code (5 minutes).' },
    { id: 'step-up-wrong', label: 'Pop-up: a wrong code', model: dialogCase((locale) => ({ kind: 'stepUp', to: 'a…a@brand-alpha.example', busy: false, error: words(locale)('stepUp.wrong') })) },
    // F-CP-153 (customer page plan C6, D13): the admin's further acts, seats full, the bulk preview, Add to a project.
    { id: 'team-selected', label: 'Three chosen — Pause · Give access back · Add to a project · Deactivate', model: people((locale) => page(locale, { colleagues: colleaguesOf(locale, PEOPLE, true, [id(2), id(4), id(5)]) })), note: 'Each bulk act says who it leaves out (and why) before anything is sent; every act sends the row’s version (a change meanwhile: read again).' },
    { id: 'team-seats-full', label: 'Every place taken — Give access back held with words', model: people((locale) => page(locale, { colleagues: { ...colleaguesOf(locale, PEOPLE, true), seats: { taken: 8, max: 8 }, seatsFull: true } })), note: '“All 8 places are taken: deactivate someone or ask us for more places.” on the paused colleague’s ⋯.' },
    {
      id: 'team-pause',
      label: 'Pop-up: Pause the access of 2 colleagues (one left out, with why)',
      model: dialogCase((locale) => ({ kind: 'team', act: 'pause', people: [{ id: id(2), name: 'Luca Bianchi' }, { id: id(3), name: 'Giulia Finta' }], skipped: [{ name: 'Marco Prova', why: words(locale)('team.held.notActive') }], busy: false, failed: null })),
      note: 'Their sessions end at once; the place stays theirs. The code by e-mail first.',
    },
    { id: 'team-resend', label: 'Pop-up: Send the invitation again', model: dialogCase(() => ({ kind: 'team', act: 'resend', people: [{ id: id(5), name: 'Sara Campione' }], skipped: [], busy: false, failed: null })) },
    {
      id: 'team-project',
      label: 'Pop-up: Add to a project (its own projects, its own colleagues)',
      model: dialogCase(() => ({ kind: 'project', people: [{ id: id(2), name: 'Luca Bianchi' }], skipped: [], projects: [{ id: id(900), name: 'Kit 2027' }, { id: id(901), name: 'Rain line' }], choice: id(900), busy: false, failed: null })),
      note: 'Only the projects the admin is in; each one added is told once, in their portal.',
    },
    // F-CP-158: the admin's last two acts as their pop-ups — withdraw an invitation, give access back.
    { id: 'cp158-team-withdraw', label: 'Pop-up: Withdraw the invitation (it ends: the link no longer signs in)', model: dialogCase(() => ({ kind: 'team', act: 'revoke', people: [{ id: id(5), name: 'Sara Campione' }], skipped: [], busy: false, failed: null })) },
    { id: 'cp158-team-give-back', label: 'Pop-up: Give access back to a paused colleague (a place is free)', model: dialogCase(() => ({ kind: 'team', act: 'giveBack', people: [{ id: id(2), name: 'Luca Bianchi' }], skipped: [], busy: false, failed: null })), note: 'Held with words while every place is taken (team-seats-full); the code by e-mail first.' },
  ],
})
