import { defineDesignScreen } from '../../../lib/design/design-screen'
import { formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { noticesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { ApprovalRead } from '../home/api'
import type { RoundRead, StyleRead, TechPack, WaitingRead } from './api'
import { decisionHeld, NS, samplesBandOf } from './model'
import type { DecisionDialogModel } from './view/DecisionDialog'
import { SamplesCase, type SamplesCaseBuilder } from './view/SamplesCase'
import type { SamplesViewModel } from './view/SamplesView'

/**
 * SCR-225 — the brand's Samples & tech packs (design portal.customer.samples; B-W2b-262), every state with MADE-UP data only
 * (no real customer, person, number or style): an invented brand (Brand Alpha S.r.l.; its buyer Anna Esempio, its viewer
 * Marco Prova, its designer Lia Prova, its admin Paolo Esempio) and an invented maker (Pelletteria Esempio). The buyer with
 * samples waiting, a viewer who may not decide, a role that does not see approvals, the Designer, one style's rounds,
 * nothing yet, loading, still loading, a failed read, a role the page does not open, an office preview, offline, a tech
 * pack opening and refused, the keys panels, and the decision pop-up (loading, the photos beside the spec, chosen with
 * comments, a rejection without words, sending, signed, gone, held for the role and offline, a read that failed).
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
const NOW = Math.floor(Date.now() / HOUR) * HOUR
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const dayAt = (days: number) => at(days * 24).slice(0, 10)
const PREFIX = '/p/BRAND-ALPHA'
const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
const id = (n: number) => `0190f0e2-1950-7000-8000-${String(n).padStart(12, '0')}`
const both = (it: string, en: string) => ({ it, en })

const LEGAL = {
  it: { name: 'Pelletteria Esempio S.r.l.', lines: ['Sede legale: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'P. IVA IT00000000000 · C.F. 00000000000'] },
  en: { name: 'Pelletteria Esempio S.r.l.', lines: ['Registered office: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'VAT IT00000000000 · Tax code 00000000000'] },
} as const

// ── who looks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
type Can = (permission: string) => boolean
const set = (...names: string[]): Can => (permission) => names.includes(permission)
const BASE = ['portal.home.view', 'portal.search', 'threads.read', 'portal.catalogue.view', 'portal.samples.view']
const BUYER = set(...BASE, 'portal.approvals.view', 'portal.approve', 'portal.salesOrders.view', 'portal.customerDocuments.view')
const VIEWER = set(...BASE, 'portal.approvals.view', 'portal.salesOrders.view', 'portal.customerDocuments.view')
const DESIGNER = set(...BASE, 'portal.approvals.view', 'portal.approve', 'portal.colleagues.view')
const NO_APPROVALS = set(...BASE, 'portal.salesOrders.view')
const FINANCE = set('portal.home.view', 'portal.search', 'threads.read', 'portal.catalogue.view', 'portal.customerDocuments.view', 'portal.payments.view')

const PERSON: Readonly<Record<string, { displayName: string; email: string }>> = {
  buyer: { displayName: 'Anna Esempio', email: 'anna@brand-alpha.example' },
  viewer: { displayName: 'Marco Prova', email: 'marco@brand-alpha.example' },
  designer: { displayName: 'Lia Prova', email: 'lia@brand-alpha.example' },
  finance: { displayName: 'Carla Prova', email: 'carla@brand-alpha.example' },
}

// ── the made-up samples ───────────────────────────────────────────────────────────────────────────────────────────────
const style = (n: number, code: string, name: string) => ({ id: id(n), code, name })
const JACKET = style(1, 'BA-JKT-27', 'Giacca Touring Uomo')
const PANTS = style(2, 'BA-PNT-27', 'Pantalone Touring')
const GLOVE = style(3, 'BA-GLV-27', 'Guanto Estivo')
const VEST = style(4, 'BA-VST-27', 'Gilet Airbag')

const pack = (n: number, revision: number, version: number, state: TechPack['state'], language = 'it', revisionStatus: TechPack['revisionStatus'] = 'DRAFT'): TechPack => ({
  id: id(n),
  revision,
  revisionStatus,
  version,
  language,
  printed: `TP 0${n}K3Q-2XA9B`,
  createdAt: at(-24 * (10 - version)),
  state,
})

const round = (n: number, s: { id: string; code: string; name: string }, kind: RoundRead['kind'], roundNo: number, status: RoundRead['status'], over: Partial<RoundRead> = {}): RoundRead => {
  const label = { it: `SR-2026-00${n} · ${kindIt[kind]} · giro ${roundNo}`, en: `SR-2026-00${n} · ${kindEn[kind]} · round ${roundNo}` }
  return {
    id: id(100 + n),
    number: `SR-2026-00${n}`,
    kind,
    roundNo,
    label,
    style: s,
    status,
    stage: status === 'BEING_MADE' ? 'IN_MAKING' : status === 'SENT' ? 'SENT' : status === 'RECEIVED' || status === 'WAITING' ? 'UNDER_REVIEW' : status === 'CANCELLED' ? 'CANCELLED' : 'DECIDED',
    decision: status === 'APPROVED' || status === 'APPROVED_WITH_COMMENTS' || status === 'REJECTED' ? status : null,
    decidedAt: status === 'APPROVED' || status === 'APPROVED_WITH_COMMENTS' || status === 'REJECTED' ? at(-24 * n) : null,
    dueDate: dayAt(5 - n),
    pieces: 2,
    shipment: status === 'BEING_MADE' ? null : { carrierName: 'Corriere Esempio', trackingNumber: `CE00${n}4471`, trackingUrl: `https://tracking.example/CE00${n}4471`, sentAt: at(-24 * (n + 6)), receivedAt: status === 'SENT' ? null : at(-24 * (n + 4)) },
    waitingRequestId: status === 'WAITING' ? id(500 + n) : null,
    createdAt: at(-24 * (n + 10)),
    ...over,
  }
}
const kindIt: Record<RoundRead['kind'], string> = { PROTO: 'Prototipo', FIT: 'Fit', SALESMAN: 'Campionario vendita', PRE_PRODUCTION: 'Pre-produzione', CERTIFICATION: 'Campione per prova CE', BRAND: 'Campione del brand' }
const kindEn: Record<RoundRead['kind'], string> = { PROTO: 'Proto', FIT: 'Fit', SALESMAN: 'Salesman', PRE_PRODUCTION: 'Pre-production', CERTIFICATION: 'CE test sample', BRAND: 'Brand sample' }

const ROUNDS: RoundRead[] = [
  round(1, JACKET, 'FIT', 2, 'WAITING'),
  round(2, PANTS, 'PROTO', 1, 'WAITING'),
  round(3, JACKET, 'FIT', 1, 'REJECTED'),
  round(4, GLOVE, 'SALESMAN', 1, 'SENT'),
  round(5, VEST, 'PROTO', 1, 'BEING_MADE'),
  round(6, JACKET, 'PROTO', 1, 'APPROVED_WITH_COMMENTS'),
  round(7, GLOVE, 'PROTO', 1, 'APPROVED'),
  round(8, PANTS, 'FIT', 1, 'RECEIVED', { shipment: { carrierName: null, trackingNumber: null, trackingUrl: null, sentAt: at(-30), receivedAt: at(-6) } }),
]

const waitingOf = (r: RoundRead, dueHours: number, question: { it: string; en: string }): WaitingRead & { questions: { it: string; en: string } } => ({
  requestId: r.waitingRequestId ?? id(600),
  kind: 'SAMPLE',
  recordType: 'SampleRound',
  recordId: r.id,
  label: { it: `Campione · ${r.label.it}`, en: `Sample · ${r.label.en}` },
  style: r.style,
  round: { id: r.id, number: r.number, kind: r.kind, roundNo: r.roundNo, label: r.label },
  swatch: null,
  question: question.it,
  questions: question,
  askedAt: at(-48),
  dueAt: at(dueHours),
  receivedAt: r.shipment?.receivedAt ?? null,
  version: 1,
})
const WAITING_ALL: (WaitingRead & { questions: { it: string; en: string } })[] = [
  waitingOf(ROUNDS[1]!, -20, both('Approvate il prototipo del pantalone? Guardate soprattutto le ginocchiere.', 'Do you approve the trousers proto? Look at the knee pads above all.')),
  waitingOf(ROUNDS[0]!, 30, both('Approvate il secondo giro di fit della giacca? Abbiamo corretto la manica come chiesto.', 'Do you approve the jacket’s second fit round? We corrected the sleeve as you asked.')),
  {
    requestId: id(610),
    kind: 'LEATHER',
    recordType: 'SampleSwatch',
    recordId: id(710),
    label: both('Pellame · BA-JKT-27', 'Leather · BA-JKT-27'),
    style: JACKET,
    round: null,
    swatch: { id: id(710), kind: 'LEATHER' },
    question: 'Approvate il lotto di pelle nera per la giacca?',
    questions: both('Approvate il lotto di pelle nera per la giacca?', 'Do you approve the black leather lot for the jacket?'),
    askedAt: at(-24),
    dueAt: at(24 * 6),
    receivedAt: null,
    version: 1,
  },
]
/** The requests in the page's language (the office writes its question in the brand's language). */
const waitingIn = (locale: Locale): WaitingRead[] => WAITING_ALL.map(({ questions, ...row }) => ({ ...row, question: questions[locale] }))

const STYLES: StyleRead[] = [
  { ...JACKET, season: 'FW27', stage: 'FIT', latestRound: { id: ROUNDS[0]!.id, number: ROUNDS[0]!.number, kind: 'FIT', roundNo: 2, status: 'WAITING' }, nextDate: dayAt(1), waiting: 2, openRounds: 1, techPack: pack(41, 2, 3, 'DRAFT'), techPacks: [pack(41, 2, 3, 'DRAFT'), pack(42, 2, 2, 'NEWER_VERSION', 'it'), pack(43, 1, 1, 'NEWER_REVISION', 'en', 'OBSOLETE')] },
  { ...PANTS, season: 'FW27', stage: 'PROTO', latestRound: { id: ROUNDS[1]!.id, number: ROUNDS[1]!.number, kind: 'PROTO', roundNo: 1, status: 'WAITING' }, nextDate: dayAt(-1), waiting: 1, openRounds: 2, techPack: pack(44, 1, 1, 'DRAFT', 'en'), techPacks: [pack(44, 1, 1, 'DRAFT', 'en')] },
  { ...GLOVE, season: 'SS27', stage: 'SALESMAN', latestRound: { id: ROUNDS[3]!.id, number: ROUNDS[3]!.number, kind: 'SALESMAN', roundNo: 1, status: 'SENT' }, nextDate: dayAt(2), waiting: 0, openRounds: 1, techPack: pack(45, 1, 2, 'CURRENT', 'it', 'RELEASED'), techPacks: [pack(45, 1, 2, 'CURRENT', 'it', 'RELEASED')] },
  { ...VEST, season: 'FW27', stage: 'PROTO', latestRound: { id: ROUNDS[4]!.id, number: ROUNDS[4]!.number, kind: 'PROTO', roundNo: 1, status: 'BEING_MADE' }, nextDate: dayAt(4), waiting: 0, openRounds: 1, techPack: null, techPacks: [] },
  { ...style(5, 'BA-HDY-27', 'Felpa Tecnica'), season: 'SS27', stage: 'APPROVED', latestRound: null, nextDate: null, waiting: 0, openRounds: 0, techPack: pack(46, 3, 1, 'CURRENT', 'it', 'RELEASED'), techPacks: [pack(46, 3, 1, 'CURRENT', 'it', 'RELEASED')] },
]

// ── the decision pop-up ───────────────────────────────────────────────────────────────────────────────────────────────
const PHOTO = (label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><rect width="320" height="320" fill="#d9d6d0"/><path d="M110 70h100l40 40-25 30-15-12v152H110V128l-15 12-25-30z" fill="#8a8580"/><text x="160" y="300" font-family="sans-serif" font-size="18" text-anchor="middle" fill="#3d3a36">${label}</text></svg>`)}`

function approval(locale: Locale, row: WaitingRead, over: Partial<ApprovalRead['request']> = {}, may: Partial<ApprovalRead['may']> = {}): ApprovalRead {
  const en = locale === 'en'
  return {
    request: { id: row.requestId, kind: row.kind, label: row.label[locale], question: row.question, from: { companyName: 'Pelletteria Esempio' }, dueAt: row.dueAt, status: 'OPEN', answer: null, version: 1, ...over },
    content: {
      facts: [
        { label: en ? 'Sample' : 'Campione', value: row.round?.label[locale] ?? row.label[locale] },
        { label: en ? 'Style' : 'Modello', value: `${row.style?.code} · ${row.style?.name}` },
        { label: en ? 'Revision' : 'Revisione', value: '2' },
        { label: en ? 'Sizes' : 'Taglie', value: 'Nero 50 ×1, Nero 52 ×1' },
      ],
      revisedOrder: null,
    },
    files: [
      { id: id(801), originalName: 'fronte.png', contentType: 'image/png', sizeBytes: 220_000 },
      { id: id(802), originalName: 'retro.png', contentType: 'image/png', sizeBytes: 210_000 },
      { id: id(803), originalName: 'manica.png', contentType: 'image/png', sizeBytes: 190_000 },
      { id: id(804), originalName: 'misure-fit-2.pdf', contentType: 'application/pdf', sizeBytes: 90_000 },
    ],
    may: { answer: true, withChanges: true, ...may },
    locale,
    receipt: null,
  }
}

const PICTURES = (): DecisionDialogModel['pictures'] => [
  { id: id(801), name: 'fronte.png', state: 'ready', src: PHOTO('fronte'), pdf: false },
  { id: id(802), name: 'retro.png', state: 'ready', src: PHOTO('retro'), pdf: false },
  { id: id(803), name: 'manica.png', state: 'ready', src: PHOTO('manica'), pdf: false },
]

function dialogOf(locale: Locale, over: Partial<DecisionDialogModel> & { can?: Can } = {}, request: Partial<ApprovalRead['request']> = {}, may: Partial<ApprovalRead['may']> = {}): DecisionDialogModel {
  const t = words(locale)
  const row = waitingIn(locale)[1]!
  const page = approval(locale, row, request, may)
  const { can = BUYER, ...rest } = over
  const reason = decisionHeld({ preview: false, mayApprove: can('portal.approve'), offline: false, busy: false, page, admins: ['Paolo Esempio'] })
  return {
    requestId: row.requestId,
    row,
    state: 'ready',
    page,
    position: { index: 2, count: 3 },
    decision: null,
    comment: '',
    answer: 'idle',
    problem: null,
    field: null,
    held: reason ? t(reason.key, reason.params) : null,
    pictures: PICTURES(),
    pdf: null,
    now: NOW,
    ...rest,
  }
}

// ── the cases ─────────────────────────────────────────────────────────────────────────────────────────────────────────
interface CaseInput {
  can?: Can
  person?: keyof typeof PERSON
  shell?: Partial<PortalShellViewModel>
  page?: Partial<SamplesViewModel>
  closed?: boolean
  dialog?: (locale: Locale) => DecisionDialogModel
}

function shellOf(locale: Locale, input: CaseInput, page: SamplesViewModel | null): PortalShellViewModel {
  const t = words(locale)
  const can = input.can ?? BUYER
  const waiting = page?.waiting?.length ?? 0
  return {
    brand: { name: 'Pelletteria Esempio', logoUrl: null, logoDarkUrl: null, accent: '#7a1f3d' },
    companyName: 'Pelletteria Esempio',
    partyName: 'Brand Alpha S.r.l.',
    person: PERSON[input.person ?? 'buyer']!,
    nav: portalNavFor({ can, kinds: ['CUSTOMER'] }),
    path: '/samples',
    prefix: PREFIX,
    badges: null,
    bell: { unread: 1, complete: true },
    notice: null,
    band: input.closed ? { title: t('title'), back: { href: PREFIX, label: t('noAccess.home') } } : samplesBandOf({ t, asOf: page && page.state !== 'loading' ? formatTime(at(0), { locale }) : null, waiting, onDecideFirst: () => undefined, held: null }),
    live: 'live',
    legal: LEGAL[locale],
    privacyHref: '/privacy/00000000-0000-7000-8000-000000000001',
    termsHref: `${PREFIX}/terms`,
    freeForSuppliers: false,
    preview: false,
    canSearch: true,
    ...input.shell,
  }
}

function pageOf(locale: Locale, input: CaseInput): SamplesViewModel {
  const can = input.can ?? BUYER
  return {
    state: 'ready',
    now: NOW,
    prefix: PREFIX,
    waiting: can('portal.approvals.view') ? waitingIn(locale) : null,
    styles: STYLES,
    rounds: ROUNDS,
    roundsTotal: ROUNDS.length,
    styleFilter: null,
    selectedStyles: [],
    selectedRounds: [],
    openHeld: null,
    busyPack: null,
    admins: ['Paolo Esempio'],
    problem: null,
    decision: input.dialog ? input.dialog(locale) : null,
    ...input.page,
  }
}

const samplesCase =
  (input: CaseInput | ((locale: Locale) => CaseInput) = {}): SamplesCaseBuilder =>
  (locale) => {
    const resolved = typeof input === 'function' ? input(locale) : input
    if (resolved.closed) return { shell: shellOf(locale, resolved, null), page: { kind: 'closed', admins: ['Paolo Esempio'] } }
    const page = pageOf(locale, resolved)
    return { shell: shellOf(locale, resolved, page), page: { kind: 'page', model: page } }
  }

const EMPTY: Partial<SamplesViewModel> = { waiting: [], styles: [], rounds: [], roundsTotal: 0 }

export const designScreen = defineDesignScreen<SamplesCaseBuilder>({
  screen: 'SCR-225',
  title: 'Samples & tech packs (portal.customer.samples)',
  view: SamplesCase,
  cases: [
    {
      id: 'buyer',
      label: 'The buyer: samples waiting, styles, rounds',
      model: samplesCase(),
      note: 'Waiting for your decision (ActionList: overdue first, received on, the countdown, Decide opens the decision); Your styles in development (the brand’s own only: stage, latest round, next date, what waits, the tech pack PDF with its version and state — a new tab, logged; select to download); Sample rounds (status, sent and received on, tracking in a new tab). The band: “Decide 3 waiting samples” (opens the first). No money anywhere.',
    },
    { id: 'viewer', label: 'A viewer (reads, may not decide)', model: samplesCase({ can: VIEWER, person: 'viewer' }), note: 'The page is the same; the decision pop-up holds the signature with the reason and names the admin to ask.' },
    { id: 'designer', label: 'The Designer', model: samplesCase({ can: DESIGNER, person: 'designer' }), note: 'The brand’s product person: decides samples, downloads tech packs; no orders or documents in the rail.' },
    { id: 'no-approvals', label: 'A role that does not see approvals', model: samplesCase({ can: NO_APPROVALS }), note: 'Waiting for your decision says in one line that the access does not show approvals, naming the admin; styles and rounds stay.' },
    { id: 'style-rounds', label: 'One style’s rounds (a style row opened)', model: samplesCase({ page: { styleFilter: { id: JACKET.id, code: JACKET.code }, rounds: ROUNDS.filter((r) => r.style.id === JACKET.id) } }), note: '“Rounds of BA-JKT-27” with Show every round; the count says 3 of 8.' },
    { id: 'selected', label: 'Rows selected (bulk actions)', model: samplesCase({ page: { selectedStyles: [STYLES[0]!.id, STYLES[2]!.id], selectedRounds: [ROUNDS[0]!.id, ROUNDS[1]!.id, ROUNDS[3]!.id] } }), note: 'Download 2 tech packs; Decide 2 waiting rounds (the sent round does not wait: counted out). A style without a tech pack cannot be selected (it says why).' },
    { id: 'opening', label: 'A tech pack opening', model: samplesCase({ page: { busyPack: STYLES[0]!.id } }) },
    { id: 'open-refused', label: 'A tech pack no longer shared', model: samplesCase({ page: { problem: { key: 'pack.gone', params: { code: JACKET.code }, tone: 'warning' } } }) },
    { id: 'keys-styles', label: 'Keys panel (styles)', model: samplesCase({ page: { keysOpen: 'styles' } }) },
    { id: 'keys-rounds', label: 'Keys panel (rounds)', model: samplesCase({ page: { keysOpen: 'rounds' } }) },
    { id: 'empty', label: 'Nothing yet', model: samplesCase({ page: EMPTY }), note: '“No samples wait for you.”, “No styles in development.”, “No sample rounds yet.” — never a failed read.' },
    { id: 'loading', label: 'Loading', model: samplesCase({ page: { state: 'loading', waiting: null, styles: [], rounds: [] } }) },
    { id: 'slow', label: 'Still loading', model: samplesCase({ page: { state: 'loading', slow: true, waiting: null, styles: [], rounds: [] } }) },
    { id: 'error', label: 'The read failed', model: samplesCase({ page: { state: 'error', waiting: null, styles: [], rounds: [] } }), note: 'The problem in our words and Try again; a failed read is never drawn as an empty list.' },
    { id: 'no-permission', label: 'A role the page does not open', model: samplesCase({ can: FINANCE, person: 'finance', closed: true }), note: 'Not in the navigation (fails closed); a typed address says it is not part of the access, naming the admin.' },
    {
      id: 'preview',
      label: 'An office preview (read-only)',
      model: samplesCase((locale) => ({
        shell: { preview: true, notice: noticesOf({ preview: { viewer: 'Marta Verdi', company: 'Pelletteria Esempio', party: 'Brand Alpha S.r.l.' } })[0] ?? null },
        page: { openHeld: { key: 'held.preview' } },
        dialog: () => ({ ...dialogOf(locale), held: words(locale)('held.preview') }),
      })),
      note: 'Opening a tech pack and signing are held with the reason: nothing is sent from a preview.',
    },
    {
      id: 'offline',
      label: 'Offline',
      model: samplesCase((locale) => ({ shell: { live: 'offline', notice: noticesOf({ offlineSince: formatTime(at(-1), { locale }) })[0] ?? null }, page: { openHeld: { key: 'held.offline' } } })),
      note: 'The frame’s banner says since when; what sends is held with “No connection”.',
    },
    // The decision pop-up.
    { id: 'decide', label: 'Decide on Fit 2: photos beside the spec', model: samplesCase((locale) => ({ dialog: () => dialogOf(locale) })), note: 'What we ask with the countdown and when it arrived; the photos side by side, the sample’s facts beside them, the PDF on demand; Approve · Approve with comments · Reject; the typed name signs. J / K the next sample; A approves, R rejects (not while typing).' },
    { id: 'decide-loading', label: 'Decision: loading', model: samplesCase((locale) => ({ dialog: () => dialogOf(locale, { state: 'loading', page: null, pictures: [] }) })) },
    { id: 'decide-comments', label: 'Decision: approve with comments', model: samplesCase((locale) => ({ dialog: () => dialogOf(locale, { decision: 'APPROVED_WITH_CHANGES', comment: 'Manica destra 1 cm più corta in taglia 52.' }) })) },
    { id: 'decide-why', label: 'Decision: a rejection without words', model: samplesCase((locale) => ({ dialog: () => dialogOf(locale, { decision: 'REFUSED', problem: 'decide.problem.why', field: 'comment' }) })) },
    { id: 'decide-pdf', label: 'Decision: a document open', model: samplesCase((locale) => ({ dialog: () => dialogOf(locale, { pdf: { id: id(804), name: 'misure-fit-2.pdf', state: 'error', src: null, pdf: true } }) })), note: 'A PDF of the request opens in the viewer; here it failed and says so with Try again.' },
    { id: 'decide-photo-failed', label: 'Decision: a photo did not load', model: samplesCase((locale) => ({ dialog: () => dialogOf(locale, { pictures: [PICTURES()[0]!, { id: id(802), name: 'retro.png', state: 'error', src: null, pdf: false }, { id: id(803), name: 'manica.png', state: 'loading', src: null, pdf: false }] }) })) },
    { id: 'decide-busy', label: 'Decision: sending', model: samplesCase((locale) => ({ dialog: () => dialogOf(locale, { decision: 'APPROVED', answer: 'busy', held: words(locale)('held.busy') }) })) },
    {
      id: 'decide-done',
      label: 'Decision: signed',
      model: samplesCase((locale) => ({ dialog: () => dialogOf(locale, { decision: 'APPROVED_WITH_CHANGES', answer: 'done' }, { status: 'APPROVED_WITH_CHANGES', answer: { at: at(0), typedName: 'Anna Esempio', words: 'Manica destra 1 cm più corta in taglia 52.' } }) })),
      note: 'The end in words with the receipt, Next sample and Close; the round says Approved with comments in the list.',
    },
    { id: 'decide-viewer', label: 'Decision: a viewer may not sign', model: samplesCase((locale) => ({ can: VIEWER, person: 'viewer', dialog: () => dialogOf(locale, { can: VIEWER }, {}, { answer: false, withChanges: false }) })) },
    { id: 'decide-offline', label: 'Decision: offline', model: samplesCase((locale) => ({ shell: { live: 'offline' }, dialog: () => ({ ...dialogOf(locale), held: words(locale)('held.offline') }) })) },
    { id: 'decide-gone', label: 'Decision: no longer waits', model: samplesCase((locale) => ({ dialog: () => dialogOf(locale, { state: 'gone', page: null, pictures: [] }) })) },
    { id: 'decide-error', label: 'Decision: the read failed', model: samplesCase((locale) => ({ dialog: () => dialogOf(locale, { state: 'error', page: null, pictures: [] }) })) },
  ],
})
