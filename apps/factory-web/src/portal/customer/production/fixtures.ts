import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { formatDate, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { BRAND_BETA } from '../../../lib/testing/two-brands'
import type { PortalBand } from '../../shell/frame'
import type { ChangeRules, ImpactRead } from '../orders/api'
import { rulesOf } from '../orders/design-data'
import { NS as ORDERS_NS } from '../orders/model'
import { betaShellOf, PREFIX } from '../requests/design-data'
import type { BulkApproveDialogModel } from '../waiting/view/BulkApproveDialog'
import type { ProductionList, ProductionRow, Urgency, UrgentUse } from './api'
import type { ApprovalsToReview } from './bulk/api'
import { approveRowsOf } from './bulk/approve-model'
import { askReviewOf, askSaveOf, askTitleOf, EMPTY_ASK_FORM, type AskRowFacts } from './bulk/ask-model'
import { bulkBarOf, doneLineOf, markReviewOf, outcomeOf, pickedRowsOf, reviewLeadOf, reviewSaveOf, reviewTitleOf, type BulkFacts } from './bulk/model'
import { NS, rowName } from './model'
import type { ReportProblemModel } from './problem/view/ReportProblemDialog'
import type { AskManyReviewModel } from './view/AskManyReview'
import type { BulkReviewModel } from './view/BulkReview'
import { ProductionCase, type ProductionCaseBuilder, type ProductionCaseModel } from './view/ProductionCase'
import type { ProductionListModel } from './view/ProductionListView'

/**
 * F-PR-16 (the browser walk; F-PR-11, F-PR-23a, F-PR-23b, F-PR-24) — Portal › Production › My production (production plan §5;
 * 06-tree B.1; 09-design (d)), read by Brand Beta (brand B, the reader of every wall scan), MADE-UP data only: its orders in its own
 * order (Urgent 1 and 2, then Regular by the day sent), "2 of 3 urgent used", a row locked by us, one asked of us, one waiting on
 * the customer, one on hold; urgency off; a role that only reads; the bulk bar on a pick, its review and the result with Undo;
 * the Urgent order dialog; Approve N; Ask N (pause); Report a problem; nothing in production; a failed read. Every number is the
 * customer's own (their PO, "Your order 4"), never the office's series; nothing of another customer.
 */

const w = (en: string, it: string) => ({ en, it })
const tr = (locale: Locale, ns: string) => createTranslator(locale, CATALOGUE[locale][ns] ?? {})
const AS_OF = '2026-11-18T09:42:00.000Z'
const NOW = Date.parse('2026-11-18T10:00:00.000Z')
const id = (n: number) => `b2b2b2b2-0000-4000-8000-${String(600 + n).padStart(12, '0')}`

function urgency(over: Partial<Urgency> = {}): Urgency {
  return { code: 'REGULAR', words: w('Regular', 'Normale'), urgentRank: null, asked: false, askedWords: null, byUs: false, byUsWords: null, locked: false, lockWords: null, ...over }
}
const URGENT = (rank: number) => urgency({ code: 'URGENT', words: w('Urgent', 'Urgente'), urgentRank: rank })
const STAGES = {
  PREPARING: w('Preparing', 'In preparazione'),
  CUTTING: w('Cutting', 'Taglio'),
  SEWING: w('Sewing', 'Cucitura'),
  QUALITY: w('Quality check', 'Controllo qualità'),
  READY: w('Ready to ship', 'Pronto per la spedizione'),
} as const
type Stage = keyof typeof STAGES
const NEXT: Record<Stage, Stage | null> = { PREPARING: 'CUTTING', CUTTING: 'SEWING', SEWING: 'QUALITY', QUALITY: 'READY', READY: null }
const stage = (code: Stage, since: string) => ({ code, words: STAGES[code], since, next: NEXT[code] ? { code: NEXT[code]!, words: STAGES[NEXT[code]!] } : null })
const US = { code: 'US' as const, words: w('Waiting on us', 'Tocca a noi'), since: '2026-11-12' }
const YOU = { code: 'YOU' as const, words: w('Waiting on you', 'Tocca a voi'), since: '2026-11-15' }
const NO_MARKS = { onHold: false, paused: false, partlyShipped: false, changePending: false, words: [] }

function row(n: number, over: Partial<ProductionRow> = {}): ProductionRow {
  return {
    id: id(n),
    customerRef: `${BRAND_BETA.customerRef}-${n}`,
    // The office's own number: in the read, never drawn (B-TH-303).
    number: BRAND_BETA.numbers.order,
    yourNumber: customerNumberOf('ORDER', n),
    orderedOn: `2026-10-${String(2 + n).padStart(2, '0')}`,
    styles: [{ code: BRAND_BETA.numbers.style, name: 'Rider jacket' }],
    pieces: 40 + n * 10,
    promiseDate: '2026-12-02',
    originalPromiseDate: null,
    promiseMoved: false,
    stage: stage('PREPARING', '2026-11-10'),
    health: null,
    waiting: US,
    marks: NO_MARKS,
    urgency: urgency(),
    next: { kind: 'STAGE', stage: 'CUTTING', gate: null, date: null, words: STAGES.CUTTING },
    count: null,
    problem: null,
    ...over,
  }
}

const ROWS: ProductionRow[] = [
  row(1, { urgency: URGENT(1), stage: stage('SEWING', '2026-11-14'), next: { kind: 'STAGE', stage: 'QUALITY', gate: null, date: '2026-11-24', words: STAGES.QUALITY } }),
  row(2, {
    urgency: URGENT(2),
    promiseDate: '2026-12-09',
    originalPromiseDate: '2026-12-02',
    promiseMoved: true,
    health: { code: 'AT_RISK', words: w('At risk', 'A rischio'), reason: { code: 'MATERIAL_LATE', words: w('Material late', 'Materiale in ritardo') } },
  }),
  row(3, { waiting: YOU, next: { kind: 'GATE', stage: null, gate: 'PP_SAMPLE', date: '2026-11-21', words: w('PP sample', 'Campione di pre-produzione') } }),
  row(4, { stage: stage('CUTTING', '2026-11-16'), next: { kind: 'STAGE', stage: 'SEWING', gate: null, date: null, words: STAGES.SEWING } }),
  row(5, { urgency: urgency({ locked: true, lockWords: w('Set to Regular by us: material not in', 'Riportato a normale da noi: materiale non arrivato') }) }),
  row(6, { urgency: urgency({ asked: true, askedWords: w('Urgent – asked', 'Urgente – richiesto') }), stage: stage('CUTTING', '2026-11-17') }),
  row(7, { marks: { ...NO_MARKS, onHold: true, words: [w('On hold: waiting for your artwork', 'In attesa: aspettiamo la vostra grafica')] }, waiting: YOU }),
]

const USE: UrgentUse = { used: 2, max: 3, agreed: 0, left: 1, over: false, words: w('2 of 3 urgent used', '2 urgenti su 3') }

function read(over: Partial<ProductionList> = {}): ProductionList {
  const items = over.items ?? ROWS
  return {
    asOf: AS_OF,
    level: 'STATUS',
    levelWords: w('Status only', 'Solo lo stato'),
    urgencyOn: true,
    urgentUse: USE,
    chip: 'ALL',
    chips: [
      { chip: 'ALL', count: items.length, words: w('All in production', 'Tutti') },
      { chip: 'URGENT', count: items.filter((item) => item.urgency?.code === 'URGENT').length, words: w('Urgent', 'Urgenti') },
      { chip: 'WAITING_ON_YOU', count: items.filter((item) => item.waiting.code === 'YOU').length, words: w('Waiting on you', 'Tocca a voi') },
      { chip: 'ON_HOLD', count: items.filter((item) => item.marks.onHold).length, words: w('On hold', 'In attesa') },
    ],
    count: items.length,
    items,
    live: { events: ['brand_production.urgency_changed'] },
    ...over,
  }
}

const FACTS: BulkFacts = { urgencyOn: true, mayMark: true, mayAsk: true, mayReport: true, mayFiles: true, preview: false, offline: false, busy: false, mayApprove: true, mayAnswer: true, askKinds: ['HOLD', 'CANCEL'] }

function band(locale: Locale, over: { urgentOrder?: boolean } = {}): PortalBand {
  const t = tr(locale, NS)
  return {
    title: t('list.title'),
    status: { label: t('band.updated', { time: formatTime(AS_OF, { locale }) }), tone: 'neutral' },
    actions: over.urgentOrder === false ? [] : [{ id: 'urgent-order', label: t('band.urgentOrder'), variant: 'primary', heldReason: null }],
    more: [{ id: 'export', label: t('band.export'), description: t('band.exportHint') }],
    keys: [
      { keys: ['/'], words: t('keys.search') },
      { keys: ['↵'], words: t('keys.open') },
    ],
  }
}

function listModel(over: Partial<ProductionListModel> = {}): ProductionListModel {
  return {
    state: 'ready',
    read: read(),
    chip: null,
    q: '',
    prefix: PREFIX,
    updates: 0,
    offlineSince: null,
    mayMark: true,
    preview: false,
    busy: [],
    notice: null,
    collapsed: [],
    dialog: null,
    now: NOW,
    report: { held: null },
    problem: null,
    selected: [],
    bulk: null,
    review: null,
    mayAsk: true,
    approve: null,
    ask: null,
    ...over,
  }
}

// ── what the acts open (the same pure parts the live page's hooks use) ──
const pick = (...ns: number[]) => pickedRowsOf(ROWS, ns.map(id))

function reviewOf(locale: Locale, done: boolean): BulkReviewModel {
  const t = tr(locale, NS)
  const review = markReviewOf(pick(2, 3, 4, 5, 6), 'URGENT', USE, FACTS, locale, t)
  const results = [
    { orderId: id(3), number: BRAND_BETA.numbers.order, customerRef: null, outcome: 'DONE' as const, done: true, words: null, ask: null, urgency: 'URGENT' as const, urgentRank: 3, asked: null },
    { orderId: id(4), number: BRAND_BETA.numbers.order, customerRef: null, outcome: 'DONE' as const, done: false, words: null, ask: null, urgency: 'REGULAR' as const, urgentRank: null, asked: { requestId: 'r-1', words: w('Asked of us: we answer you.', 'Chiesto a noi: vi rispondiamo.') } },
  ]
  const outcome = outcomeOf(review, { batchId: 'batch-1', results, notFound: 0, use: USE, replayed: false, askBatchId: 'asks-1' }, locale, t)
  return {
    title: reviewTitleOf(review, t),
    lead: reviewLeadOf(review, USE, t),
    rows: review.rows,
    needBy: { value: '', min: '2026-11-18' },
    phase: done ? 'done' : 'ready',
    results: done ? outcome.results : null,
    doneLine: done ? doneLineOf(outcome, t) : null,
    save: reviewSaveOf(review, t),
    held: null,
    problem: null,
    undo: done ? { busy: false } : null,
  }
}

function approveOf(locale: Locale): BulkApproveDialogModel {
  const order = (n: number) => ({ orderId: id(n), number: BRAND_BETA.numbers.order, customerRef: null })
  const list: ApprovalsToReview = {
    orders: [
      { ...order(3), waiting: 2 },
      { ...order(7), waiting: 1 },
    ],
    items: [
      {
        requestId: 'r-sample',
        version: 2,
        kind: 'SAMPLE',
        words: w(`Sample · PP · ${BRAND_BETA.numbers.style}`, `Campione · PP · ${BRAND_BETA.numbers.style}`),
        question: locale === 'it' ? 'Approvate il campione di pre-produzione?' : 'Do you approve the PP sample?',
        dueAt: '2026-11-20T10:00:00.000Z',
        orders: [order(3), order(7)],
        facts: [{ label: locale === 'it' ? 'Colore' : 'Colour', value: 'Sand' }],
        files: [{ id: 'f-1', originalName: 'pp-sample.jpg', contentType: 'image/jpeg', sizeBytes: 2048 }],
        may: { approve: true, held: null },
      },
      {
        requestId: 'r-counter',
        version: 1,
        kind: 'COUNTER_OFFER',
        words: w('Counter-offer · Your order 3', 'Controproposta · Il vostro ordine 3'),
        question: locale === 'it' ? 'Accettate la nostra proposta?' : 'Do you accept our suggestion?',
        dueAt: '2026-11-21T10:00:00.000Z',
        orders: [order(3)],
        facts: [],
        files: [],
        may: { approve: false, held: locale === 'it' ? 'Aspetta il vostro buyer' : 'Waiting for your buyer' },
      },
    ],
    more: false,
    notFound: 0,
    undo: w('A signed approval cannot be undone here. To change it, write to us.', 'Un’approvazione firmata non si può annullare qui. Per cambiarla, scriveteci.'),
  }
  const names = new Map(ROWS.map((item) => [item.id, rowName(item, locale, tr(locale, NS))]))
  return {
    state: 'ready',
    readProblem: null,
    orders: list.orders.length,
    rows: approveRowsOf(list, (orderId) => names.get(orderId) ?? null, locale, tr(locale, NS)),
    ticked: ['r-sample'],
    more: null,
    undo: list.undo[locale],
    phase: 'edit',
    held: null,
    problem: null,
    results: null,
    doneLine: null,
    file: null,
  }
}

const BETA_RULES = (): ChangeRules =>
  rulesOf({
    order: { ...rulesOf().order, number: BRAND_BETA.numbers.order, customerRef: BRAND_BETA.customerRef },
    addresses: [],
    openRequestId: null,
    cancel: { possible: true, code: 'FREE', day: null, words: w('Free', 'Gratis') },
    asks: [
      { kind: 'HOLD', words: w('Pause', 'Pausa'), open: true, verdict: { possible: true, code: 'FREE', day: null, words: w('Free', 'Gratis') }, waitingRequestId: null },
      { kind: 'RESUME', words: w('Resume', 'Riprendi'), open: true, verdict: { possible: false, code: 'NOT_PAUSED', day: null, words: w('The order is not paused.', 'L’ordine non è in pausa.') }, waitingRequestId: null },
    ],
  })
const IMPACT: ImpactRead = { asOf: AS_OF, impact: { kind: 'HOLD', frozen: [], blocked: false, priced: false, earliest: null, notes: [] } }

function askOf(locale: Locale): AskManyReviewModel {
  const t = tr(locale, NS)
  const words = { locale, t, tOrders: tr(locale, ORDERS_NS), day: (iso: string) => formatDate(iso, { locale }), money: (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}` }
  const facts = (n: number, over: Partial<AskRowFacts> = {}): AskRowFacts => {
    const item = ROWS.find((entry) => entry.id === id(n))!
    return { id: item.id, name: rowName(item, locale, t), now: item.stage?.words[locale] ?? '', rules: { state: 'ready', rules: BETA_RULES() }, impact: { state: 'ready', read: IMPACT }, ...over }
  }
  const review = askReviewOf('HOLD', [facts(3), facts(4), facts(7, { rules: { state: 'ready', rules: { ...BETA_RULES(), asks: [] } }, impact: null })], words)
  return {
    kind: 'HOLD',
    title: askTitleOf(review, t),
    lead: t('bulk.ask.lead.HOLD'),
    rows: review.rows,
    form: EMPTY_ASK_FORM,
    reasons: [],
    formProblem: null,
    phase: 'ready',
    results: null,
    doneLine: null,
    save: askSaveOf(review, t),
    held: null,
    problem: null,
    undo: null,
  }
}

function problemOf(locale: Locale): ReportProblemModel {
  const t = tr(locale, NS)
  return {
    orders: pick(2, 7).map((item) => ({ id: item.id, name: rowName(item, locale, t) })),
    over: 0,
    text: '',
    pointer: null,
    pointerAsked: true,
    phase: 'edit',
    failure: null,
    held: t('problem.held.empty'),
    outcome: null,
  }
}

/** Every case opens the same acts (the keyboard walk); `over` sets what the case shows at first. */
function productionCase(build: (locale: Locale) => { list?: Partial<ProductionListModel>; band?: { urgentOrder?: boolean } } = () => ({})): ProductionCaseBuilder {
  return (locale): ProductionCaseModel => {
    const t = tr(locale, NS)
    const own = build(locale)
    const list = listModel(own.list)
    const rows = list.read?.items ?? []
    const facts: BulkFacts = { ...FACTS, urgencyOn: list.read?.urgencyOn ?? false, mayMark: list.mayMark }
    const urgent = rows.filter((item) => item.urgency?.code === 'URGENT').map((item) => item.id)
    return {
      shell: betaShellOf(locale, band(locale, own.band), '/production'),
      list,
      barOf: (selected) => (selected.length === 0 ? null : bulkBarOf(pickedRowsOf(rows, selected), rows.length, facts, t)),
      opens: {
        review: reviewOf(locale, false),
        approve: approveOf(locale),
        ask: askOf(locale),
        problem: problemOf(locale),
        ...(list.read?.urgencyOn && list.mayMark ? { dialog: { items: urgent, held: t('dialog.unmoved'), busy: false, problem: null } } : {}),
      },
    }
  }
}

const picked = (locale: Locale, ...ns: number[]): Partial<ProductionListModel> => ({ selected: ns.map(id), bulk: bulkBarOf(pick(...ns), ROWS.length, FACTS, tr(locale, NS)) })

export const designScreen = defineDesignScreen<ProductionCaseBuilder>({
  screen: 'SCR-184-production',
  title: 'My production (portal › Production, Brand Beta)',
  view: ProductionCase,
  cases: [
    {
      id: 'list',
      label: 'F-PR-11 · My production: Urgent 1 and 2, then Regular by the day sent; "2 of 3 urgent used"',
      model: productionCase(),
      note: 'A row locked by us with our reason, one asked of us, one waiting on you (a PP sample), one on hold. Their PO first, then "Your order 4"; never the office’s series, nothing of another customer.',
    },
    { id: 'urgency-off', label: 'F-PR-11 · Urgency off for this customer: no urgency column, group, chip or action', model: productionCase(() => ({ list: { read: read({ urgencyOn: false, urgentUse: null }) }, band: { urgentOrder: false } })) },
    { id: 'reader', label: 'F-PR-11 · A role that only reads: no mark, no Urgent order', model: productionCase(() => ({ list: { mayMark: false, report: null, mayAsk: false }, band: { urgentOrder: false } })) },
    { id: 'bulk-bar', label: 'F-PR-23a · Two rows picked: the bulk bar (Mark urgent · Mark regular · Move to top · Approve · Ask ▾ · More ▾)', model: productionCase((locale) => ({ list: picked(locale, 3, 4) })) },
    { id: 'bulk-review', label: 'F-PR-23a · The review before Send: each order, what will happen and why', model: productionCase((locale) => ({ list: { ...picked(locale, 2, 3, 4, 5, 6), review: reviewOf(locale, false) } })) },
    { id: 'bulk-done', label: 'F-PR-23a · After Send: one result per row, Undo', model: productionCase((locale) => ({ list: { ...picked(locale, 2, 3, 4, 5, 6), review: reviewOf(locale, true) } })) },
    { id: 'urgent-order', label: 'F-PR-11 · The Urgent order dialog: its own urgent orders, moved by drag, keys or buttons', model: productionCase((locale) => ({ list: { dialog: { items: [id(1), id(2)], held: tr(locale, NS)('dialog.unmoved'), busy: false, problem: null } } })) },
    { id: 'approve', label: 'F-PR-23b · Approve N: each approval once with its orders, one typed name, no Undo', model: productionCase((locale) => ({ list: { ...picked(locale, 3, 7), approve: approveOf(locale) } })) },
    { id: 'ask', label: 'F-PR-23b · Ask N (pause): one request per order with what it means; one that cannot, with why', model: productionCase((locale) => ({ list: { ...picked(locale, 3, 4, 7), ask: askOf(locale) } })) },
    { id: 'report', label: 'F-PR-24 · Report a problem on two orders', model: productionCase((locale) => ({ list: { ...picked(locale, 2, 7), problem: problemOf(locale) } })) },
    { id: 'empty', label: 'Nothing in production', model: productionCase(() => ({ list: { read: read({ items: [], count: 0, urgentUse: { ...USE, used: 0, left: 3, words: w('0 of 3 urgent used', '0 urgenti su 3') } }) } })) },
    { id: 'error', label: 'The list could not be read (never drawn as empty)', model: productionCase(() => ({ list: { state: 'error', read: null } })) },
  ],
})
