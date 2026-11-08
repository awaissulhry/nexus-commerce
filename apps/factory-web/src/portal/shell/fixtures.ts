import { KIND_RULES, taskWords, type PartnerTaskKind } from '@nexus/factory-domain/portal/tasks/kinds'
import { TOPIC_WORDS, LOCKED_REASON, PARTNER_EMAIL_TOPICS, isTransactional } from '@nexus/factory-domain/portal/notifications/topics'
import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { defineDesignScreen } from '../../lib/design/design-screen'
import { formatDate, formatDateTime, formatTime } from '../../lib/i18n/format'
import type { Locale } from '../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../lib/i18n/messages'
import type { EmailFrequency } from './api'
import type { PortalBand } from './frame'
import { badgesOf, noticesOf, type TaskRow } from './model'
import { portalNavFor, type PortalKind } from './nav/portal-nav'
import type { ShortcutGroup } from './view/FrameDialogs'
import { PortalFrameCase, type PortalFrameCaseBuilder, type PortalFramePage, type PortalFramePopup } from './view/PortalFrameCase'
import type { PortalShellViewModel } from './view/PortalShellView'
import type { TasksViewModel } from './view/TasksView'
import type { ThreadViewModel } from './view/ThreadView'

/**
 * SCR-027 — the portal frame's design review (B-W2b-173), every state with MADE-UP data only (no real customer, supplier,
 * person or number): a customer's, a supplier's and a workshop's frame with every area as it will be (the live portal shows
 * only built pages: the "today" case), branded and unbranded, loading, error, empty, offline, an office preview, a record
 * with its Messages, a read-only person, every pop-up (Notifications, E-mail settings, Still there?, Keyboard shortcuts,
 * Leave without sending?, My access, Language and theme, Search, Ask a question) and the portal terms.
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render (the countdowns and "today").
const NOW = Math.floor(Date.now() / HOUR) * HOUR
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const PREFIX = '/p/BRAND-ALPHA'
const words = (locale: Locale) => createTranslator(locale, CATALOGUE[locale].portal ?? {})

const BRAND = { name: 'Pelletteria Esempio', logoUrl: null, logoDarkUrl: null, accent: '#7a1f3d' } as const
const LEGAL = {
  it: { name: 'Pelletteria Esempio S.r.l.', lines: ['Sede legale: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'P. IVA IT00000000000 · C.F. 00000000000', 'Capitale sociale versato € 10.000,00'] },
  en: { name: 'Pelletteria Esempio S.r.l.', lines: ['Registered office: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'VAT IT00000000000 · Tax code 00000000000', 'Paid-up share capital € 10,000.00'] },
} as const

const ALL = (permission: string) => permission.startsWith('portal.') || permission === 'files.read' || permission === 'threads.read'
const navFor = (kind: PortalKind, everyPage = true) => portalNavFor({ can: ALL, kinds: [kind], everyPage })

const BADGES = [
  { area: 'orders', count: 2, words: { it: '2 da confermare', en: '2 to confirm' } },
  { area: 'documents', count: 1, words: { it: '1 richiesto', en: '1 requested' } },
  { area: 'quotes', count: 1, words: { it: '1 da approvare', en: '1 to approve' } },
]

function shell(locale: Locale, over: Partial<PortalShellViewModel> = {}): PortalShellViewModel {
  return {
    brand: BRAND,
    companyName: 'Pelletteria Esempio',
    partyName: 'Brand Alpha S.r.l.',
    person: { displayName: 'Anna Esempio', email: 'anna@brand-alpha.example' },
    nav: navFor('CUSTOMER'),
    path: '/',
    prefix: PREFIX,
    badges: badgesOf(BADGES, locale),
    bell: { unread: 3, complete: true },
    notice: null,
    band: null,
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

interface FixtureTask {
  id: string
  kind: PartnerTaskKind
  record: string
  due: 'OVERDUE' | 'TODAY' | 'SOON' | 'LATER' | 'NONE'
  dueIn: number | null
  askedBy: string | null
  inline: boolean
}

const CUSTOMER_TASKS: readonly FixtureTask[] = [
  { id: 't1', kind: 'APPROVE', record: 'Campione di vestibilità FIT-0007', due: 'OVERDUE', dueIn: -30, askedBy: 'Marco Prova', inline: false },
  { id: 't2', kind: 'ACCEPT_QUOTE', record: 'QT-2026-0042', due: 'TODAY', dueIn: 5, askedBy: 'Marco Prova', inline: false },
  { id: 't3', kind: 'UPLOAD_DOCUMENT', record: 'SO-2026-0101', due: 'SOON', dueIn: 30, askedBy: 'Giulia Finta', inline: true },
  { id: 't4', kind: 'ANSWER_MESSAGE', record: 'SO-2026-0098', due: 'LATER', dueIn: 24 * 6, askedBy: null, inline: false },
]
const SUPPLIER_TASKS: readonly FixtureTask[] = [
  { id: 's1', kind: 'CONFIRM_PO', record: 'PO-2026-0311', due: 'TODAY', dueIn: 4, askedBy: null, inline: false },
  { id: 's2', kind: 'CONFIRM_PO', record: 'PO-2026-0312', due: 'LATER', dueIn: 24 * 4, askedBy: null, inline: false },
  { id: 's3', kind: 'UPLOAD_DOCUMENT', record: 'Certificato Cr VI 2026', due: 'SOON', dueIn: 40, askedBy: 'Paolo Campione', inline: true },
]

function tasksModel(locale: Locale, list: readonly FixtureTask[], done: readonly string[] = []): TasksViewModel {
  const groups = new Map<string, (TaskRow & { done?: { canUndo: boolean } | null })[]>()
  for (const task of list) {
    const rows = groups.get(task.kind) ?? []
    rows.push({
      id: task.id,
      kind: task.kind,
      title: taskWords(task.kind, task.record, locale),
      verb: KIND_RULES[task.kind].verb[locale],
      record: task.record,
      askedBy: task.askedBy,
      due: task.dueIn === null ? null : { at: at(task.dueIn), state: task.due === 'OVERDUE' ? 'overdue' : task.due === 'TODAY' ? 'today' : task.due === 'SOON' ? 'soon' : 'later', text: formatDate(at(task.dueIn), { locale }) },
      act: task.inline ? 'inline' : 'link',
      href: `${PREFIX}/open/SalesOrder/00000000-0000-7000-8000-00000000000${task.id.length}`,
      done: done.includes(task.id) ? { canUndo: true } : null,
    })
    groups.set(task.kind, rows)
  }
  return { state: 'ready', now: NOW, groups: [...groups.entries()].map(([kind, rows]) => ({ kind, rows })) }
}

const home = (locale: Locale, list: readonly FixtureTask[] = CUSTOMER_TASKS): PortalFramePage => ({ kind: 'home', tasks: tasksModel(locale, list) })

const MESSAGES = (locale: Locale): PartnerMessage[] => [
  {
    id: 'm1',
    side: 'company',
    channel: 'email',
    author: { name: 'Marco Prova', mine: false },
    body: locale === 'it' ? 'Buongiorno, la consegna di SO-2026-0101 slitta di due giorni per la tintura. Vi confermiamo la nuova data entro domani.' : 'Good morning, delivery of SO-2026-0101 moves by two days because of the dyeing. We confirm the new date by tomorrow.',
    attachments: [{ id: 'f1', name: 'piano-consegne.pdf', size: '84 KB', href: '#f1' }],
    at: at(-26),
    atText: formatDateTime(at(-26), { locale }),
  },
  {
    id: 'm2',
    side: 'partner',
    channel: 'portal',
    author: { name: 'Anna Esempio', mine: true },
    body: locale === 'it' ? 'Grazie. Possiamo ricevere una spedizione parziale venerdì?' : 'Thank you. Can we receive a part shipment on Friday?',
    at: at(-3),
    atText: formatDateTime(at(-3), { locale }),
  },
]

function thread(locale: Locale, over: Partial<ThreadViewModel> = {}): ThreadViewModel {
  const t = words(locale)
  return {
    state: 'ready',
    title: t('thread.title'),
    record: { theirs: 'BA-PO-7781', ours: 'SO-2026-0101' },
    companyName: 'Pelletteria Esempio',
    messages: MESSAGES(locale),
    composer: { value: '', busy: false, heldReason: null, hint: t('thread.hint'), limit: 20_000 },
    loadMore: null,
    accessLine: null,
    failed: null,
    ...over,
  }
}

const recordBand = (locale: Locale): PortalBand => {
  const t = words(locale)
  return {
    title: `${t('record.type.SalesOrder')} SO-2026-0101`,
    back: { href: PREFIX, label: t('nav.home') },
    refs: { theirs: 'BA-PO-7781', ours: 'SO-2026-0101' },
    tabs: { label: t('record.tabs'), active: 'messages', items: [{ id: 'messages', label: t('record.messages'), href: '#messages' }] },
    ask: { type: 'SalesOrder', id: '00000000-0000-7000-8000-000000000101', label: 'SO-2026-0101' },
  }
}

// On a record page the references are in the band: the conversation does not repeat them (PortalThread showRecord={false}).
const record = (locale: Locale, over: Partial<ThreadViewModel> = {}): PortalFramePage => ({ kind: 'record', record: { missing: false, subtitle: locale === 'it' ? 'Ordine del 3 novembre · 4 righe' : 'Order of 3 November · 4 lines', homeHref: PREFIX }, thread: thread(locale, { record: null, ...over }) })

function emailPopup(locale: Locale, changes = 0): PortalFramePopup {
  const t = words(locale)
  const chosen: Record<string, EmailFrequency> = { DATES: 'DAILY', CLAIMS: 'INSTANT', DOCUMENTS: changes > 0 ? 'OFF' : 'WEEKLY', MESSAGES: 'INSTANT', REMINDERS: 'WEEKLY' }
  return {
    kind: 'email',
    model: {
      open: true,
      state: 'ready',
      topics: PARTNER_EMAIL_TOPICS.map((topic) => ({ topic, name: TOPIC_WORDS[topic][locale], frequency: isTransactional(topic) ? 'INSTANT' : (chosen[topic] ?? 'DAILY'), locked: isTransactional(topic), reason: isTransactional(topic) ? LOCKED_REASON[locale] : null })),
      allOff: false,
      changes,
      saving: false,
      failed: changes > 1 ? t('email.saveFailed') : null,
    },
  }
}

function shortcuts(locale: Locale): ShortcutGroup[] {
  const t = words(locale)
  return [
    {
      title: t('keys.global'),
      keys: [
        { keys: ['/'], words: t('keys.search') },
        { keys: ['g', 'h'], words: t('keys.go', { area: t('nav.home') }) },
        { keys: ['g', 'o'], words: t('keys.go', { area: t('nav.orders') }) },
        { keys: ['g', 'd'], words: t('keys.go', { area: t('nav.documents') }) },
        { keys: ['?'], words: t('keys.help') },
        { keys: ['Esc'], words: t('keys.escape') },
      ],
    },
    { title: t('keys.page'), keys: [{ keys: ['Ctrl', 'Enter'], words: locale === 'it' ? 'Invia il messaggio' : 'Send the message' }] },
  ]
}

const notificationsPopup = (locale: Locale, state: 'ready' | 'loading' | 'error' = 'ready'): PortalFramePopup => ({
  kind: 'notifications',
  model: {
    open: true,
    state,
    unread: 2,
    rows: [
      { id: 'n1', sentence: locale === 'it' ? 'Ti chiediamo di approvare il campione FIT-0007' : 'We ask you to approve sample FIT-0007', record: 'FIT-0007', when: formatTime(at(-1), { locale }), read: false, href: `${PREFIX}/open/Quote/x#task:t1`, more: 0 },
      { id: 'n2', sentence: locale === 'it' ? 'La data promessa di SO-2026-0101 è cambiata' : 'The promised date of SO-2026-0101 changed', record: 'SO-2026-0101', when: formatTime(at(-2), { locale }), read: false, href: `${PREFIX}/open/SalesOrder/x`, more: 1 },
      { id: 'n3', sentence: locale === 'it' ? 'SO-2026-0098 è stato spedito' : 'SO-2026-0098 was shipped', record: 'SO-2026-0098', when: formatDateTime(at(-30), { locale }), read: true, href: `${PREFIX}/open/SalesOrder/y`, more: 0 },
    ],
  },
})

const searchPopup = (locale: Locale, state: 'ready' | 'error' | 'tooShort' = 'ready'): PortalFramePopup => {
  const t = words(locale)
  return {
    kind: 'search',
    model: {
      open: true,
      query: state === 'tooShort' ? 'B' : 'BA-PO-77',
      state,
      found: state === 'ready' ? 3 : 0,
      capped: false,
      single: null,
      groups:
        state === 'ready'
          ? [
              {
                group: 'orders',
                label: t('search.group.orders'),
                count: 2,
                results: [
                  { key: 'o1', href: `${PREFIX}/open/SalesOrder/a`, theirs: 'BA-PO-7781', ours: 'SO-2026-0101', subtitle: null, when: formatDate(at(-120), { locale }) },
                  { key: 'o2', href: `${PREFIX}/open/SalesOrder/b`, theirs: 'BA-PO-7702', ours: 'SO-2026-0098', subtitle: null, when: formatDate(at(-400), { locale }) },
                ],
              },
              { group: 'documents', label: t('search.group.documents'), count: 1, results: [{ key: 'd1', href: `${PREFIX}/open/Ddt/c`, theirs: 'BA-PO-7702', ours: 'DDT-2026-0450', subtitle: 'SO-2026-0098', when: formatDate(at(-300), { locale }) }] },
            ]
          : [],
    },
  }
}

const caseOf = (build: PortalFrameCaseBuilder): PortalFrameCaseBuilder => build

const notice = (facts: Parameters<typeof noticesOf>[0]) => noticesOf(facts)[0] ?? null

export const designScreen = defineDesignScreen<PortalFrameCaseBuilder>({
  screen: 'SCR-027',
  title: 'Portal frame',
  view: PortalFrameCase,
  cases: [
    {
      id: 'customer',
      label: 'Customer: Home, what waits for you (branded)',
      model: caseOf((locale) => ({ shell: shell(locale), page: home(locale) })),
      note: 'The rail labelled at rest (6 areas, badges with their nouns: "Orders, 2 to confirm"), search, the bell (3 unread), the person menu. Tasks overdue first, due today with a countdown, a safe verb in place. Phone: the bottom bar (Home, Orders, Documents, Returns + More). Keys: / search, g h / g o / g d, ?.',
    },
    {
      id: 'today',
      label: 'Customer as the portal opens today (only built pages)',
      model: caseOf((locale) => ({ shell: shell(locale, { nav: navFor('CUSTOMER', false) }), page: home(locale) })),
      note: 'Navigation fails closed AND never shows a door to a page not built yet: until the area steps land, only Home.',
    },
    {
      id: 'supplier',
      label: 'Supplier (unbranded): free for suppliers',
      model: caseOf((locale) => ({ shell: shell(locale, { brand: null, nav: navFor('SUPPLIER'), partyName: 'Conceria Prova S.p.A.', person: { displayName: 'Luca Prova', email: 'luca@conceria-prova.example' }, freeForSuppliers: true }), page: home(locale, SUPPLIER_TASKS) })),
      note: 'Supplier areas: Home, Purchase orders, Deliveries, Documents, Profile; the company name in text and the DS colours; the foot says "Free for suppliers".',
    },
    {
      id: 'workshop',
      label: 'Subcontractor: Home, Jobs, Documents, Profile',
      model: caseOf((locale) => ({ shell: shell(locale, { nav: navFor('SUBCONTRACTOR'), partyName: 'Laboratorio Esempio', freeForSuppliers: true, badges: null }), page: home(locale, []) })),
      note: 'A workshop: four areas, no More on a phone. Nothing waits: the empty words. No badge known: no badge (never 0).',
    },
    {
      id: 'loading',
      label: 'Loading',
      model: caseOf((locale) => ({ shell: shell(locale, { badges: null, bell: null }), page: { kind: 'home', tasks: { state: 'loading', groups: [] } } })),
      note: 'Skeletons in the shape of the rows; no badge and no bell count until they are read.',
    },
    {
      id: 'error',
      label: 'The task list failed',
      model: caseOf((locale) => ({ shell: shell(locale, { badges: null }), page: { kind: 'home', tasks: { state: 'error', groups: [] } } })),
      note: 'The problem in our words + Try again; a failed read is never drawn as an empty list.',
    },
    {
      id: 'offline',
      label: 'Offline',
      model: caseOf((locale) => ({ shell: shell(locale, { live: 'offline', notice: notice({ offlineSince: formatTime(at(-1), { locale }) }) }), page: home(locale) })),
      note: 'One banner: "No connection — showing what was loaded at …"; the band says Offline.',
    },
    {
      id: 'preview',
      label: 'Office preview (read-only)',
      model: caseOf((locale) => ({ shell: shell(locale, { preview: true, notice: notice({ preview: { viewer: 'Marco Prova', company: 'Pelletteria Esempio', party: 'Brand Alpha S.r.l.' } }) }), page: { kind: 'home', tasks: { ...tasksModel(locale, CUSTOMER_TASKS), groups: tasksModel(locale, CUSTOMER_TASKS).groups.map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row, held: words(locale)('preview.held') })) })) } } })),
      note: 'Staff support: the preview notice, every verb held with its reason, no E-mail settings in the menu.',
    },
    {
      id: 'access-ends',
      label: 'Access ends soon',
      model: caseOf((locale) => ({ shell: shell(locale, { notice: notice({ accessEnds: formatDate(at(24 * 5), { locale }) }) }), page: home(locale) })),
      note: 'Dismissal is kept by value: a new end date shows again.',
    },
    {
      id: 'record',
      label: 'Any record: band with RefPair, Messages',
      model: caseOf((locale) => ({ shell: shell(locale, { band: recordBand(locale), path: '/open/SalesOrder/x' }), page: record(locale) })),
      note: 'Their reference first, ours second; the ⋯ ends with "Ask a question" (focuses the box below); "You can also answer our e-mails".',
    },
    {
      id: 'record-readonly',
      label: 'A read-only person on a record',
      model: caseOf((locale) => {
        const t = words(locale)
        return { shell: shell(locale, { band: { ...recordBand(locale), readOnly: { key: 'notice.readOnly' } }, notice: notice({ record: { key: 'notice.readOnly' } }), path: '/open/SalesOrder/x' }), page: record(locale, { composer: { value: '', busy: false, heldReason: t('thread.held.NO_COMMENT'), hint: t('thread.hint'), limit: 20_000 }, accessLine: t('thread.whoCan', { names: 'Anna Esempio' }) }) }
      }),
      note: 'Fail closed and say who can: the reason in place of the box, and "Ask your admin (…)".',
    },
    {
      id: 'record-missing',
      label: 'A record that is not theirs',
      model: caseOf((locale) => ({ shell: shell(locale, { band: { title: words(locale)('record.missingTitle'), back: { href: PREFIX, label: words(locale)('nav.home') } }, path: '/open/SalesOrder/z' }), page: { kind: 'record', record: { missing: true, subtitle: null, homeHref: PREFIX }, thread: thread(locale) } })),
      note: 'The same answer for another partner’s record and one that does not exist.',
    },
    {
      id: 'terms',
      label: 'Portal terms (new tab)',
      model: caseOf((locale) => ({
        shell: shell(locale, { band: { title: words(locale)('terms.title'), back: { href: PREFIX, label: words(locale)('nav.home') } }, path: '/terms' }),
        page: { kind: 'terms', terms: { state: 'ready', label: '2026-11', published: formatDate(at(-24 * 10), { locale }), acknowledged: true, otherLanguage: false, body: locale === 'it' ? 'ESEMPIO — condizioni del portale.\n\n1. Il portale serve a seguire ordini e documenti.\n2. Ogni accesso è personale.' : 'SAMPLE — portal terms.\n\n1. The portal is for following orders and documents.\n2. Every access is personal.' } },
      })),
    },
    { id: 'notifications', label: 'Pop-up: Notifications', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: notificationsPopup(locale) })), note: '↑ ↓ between rows, Enter opens, Esc closes; Mark all as read. A full-height sheet on a phone.' },
    { id: 'notifications-error', label: 'Pop-up: Notifications failed', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: notificationsPopup(locale, 'error') })) },
    { id: 'email', label: 'Pop-up: E-mail settings', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: emailPopup(locale) })), note: 'Orders, shipped and invoices locked on with the reason; one switch for all non-essential mail.' },
    { id: 'email-changed', label: 'Pop-up: E-mail settings with a change', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: emailPopup(locale, 1) })), note: 'The EditModeBar: ⌘S saves; closing asks Save / Discard / Stay.' },
    { id: 'still-there', label: 'Pop-up: Still there?', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: { kind: 'still', endsInMs: 110_000, canStay: true } })), note: 'Two minutes before the idle sign-out; Enter = Stay signed in.' },
    { id: 'still-there-end', label: 'Pop-up: Still there? at the 12 hours', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: { kind: 'still', endsInMs: 110_000, canStay: false } })), note: 'Stay is held with the reason: only a new sign-in helps.' },
    { id: 'shortcuts', label: 'Pop-up: Keyboard shortcuts', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: { kind: 'shortcuts', groups: shortcuts(locale) } })) },
    { id: 'unsaved', label: 'Pop-up: Leave without sending?', model: caseOf((locale) => ({ shell: shell(locale, { band: recordBand(locale) }), page: record(locale), popup: { kind: 'unsaved', model: { open: true, what: words(locale)('unsaved.message'), canSave: true } } })) },
    {
      id: 'access',
      label: 'Pop-up: My access',
      model: caseOf((locale) => {
        const t = words(locale)
        return {
          shell: shell(locale),
          page: home(locale),
          popup: { kind: 'access', model: { open: true, state: 'ready', role: t('role.customer-buyer'), prices: true, capabilities: [t('access.capability.comment'), t('access.capability.approve')], allows: ['portal_home_view', 'portal_salesOrders_view', 'portal_customerDocuments_view', 'portal_search', 'portal_comment'].map((key) => t(`access.permission.${key}`)), until: null, admins: ['Giorgio Esempio'], preview: false } },
        }
      }),
    },
    { id: 'display', label: 'Pop-up: Language and theme', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: { kind: 'display', model: { open: true, locale, theme: 'system', preview: false } } })), note: 'The language is the person’s own (the portal and our mails speak it); the theme is this device’s.' },
    { id: 'search', label: 'Pop-up: Search by their PO number', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: searchPopup(locale) })), note: 'Grouped as the portal shows them; their reference first, the typed words marked; Enter opens; ⌘-click a new tab.' },
    { id: 'search-error', label: 'Pop-up: Search not answering', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: searchPopup(locale, 'error') })) },
    { id: 'ask', label: 'Pop-up: Ask a question (no record)', model: caseOf((locale) => ({ shell: shell(locale), page: home(locale), popup: { kind: 'ask', thread: thread(locale, { record: null, messages: [], title: words(locale)('thread.accountHeading') }) } })), note: 'On a page with no record the question is about the account; the box is focused.' },
  ],
})
