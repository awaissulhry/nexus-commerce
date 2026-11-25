import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { addressProblems, EMPTY_ADDRESS } from '../account/model'
import { templateHref } from './api'
import { newOrderBandOf, type NewOrderPhase } from './band'
import { ADDRESSES, at, catalogueRead, DRAFTS, draftRecord, LINE_TROUSERS, lineOf, orderingWords, PAST_ORDERS, pastOrder, PREFIX, shellOf, styleDetail, TODAY, uploadAnswer } from './design-data'
import { headerDraftOf } from './model'
// ---- F-CP-150 (customer page plan C5, D9–D11; picture 22): the draft order page — docked conversation, held Send, every state.
import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { formatDateTime } from '../../../lib/i18n/format'
import type { ThreadViewModel } from '../../shell/view/ThreadView'
import { draftDiscardHeld, draftSendHeld, draftTitleOf } from './model'
// ---- end F-CP-150
// ---- F-CP-151 (B-CP-072; D14): the draft's files (made-up names; a line's file names its line by seq on the page).
import type { DraftFile } from './api'
import type { UploadRow } from '../../../lib/order-draft/view/files'

// ---- end F-CP-151
// ---- F-CP-154 (B-CP-075, B-CP-076; picture 22): lines of every kind, the roster, "Your price", their windows (made-up riders).
import { describedLine, kindsRecord, mtmLine, RIDERS, SHEET_ON_MTM } from './design-data'
import { EMPTY_PERSON, personProblems } from './model'
import { draftViewOf, productRowsOf } from '../../../lib/order-draft/model'
import { DRAFT_NS } from '../../../lib/order-draft/words'
import { piecesModesOf } from '../../../lib/order-draft/view/RowWindows'
import type { PersonDialogModel } from '../../../lib/order-draft/view/PeopleRoster'
// ---- end F-CP-154
import type { NewOrderViewModel } from './view/NewOrderView'
import { OrderingCase, type OrderingCaseBuilder } from './view/OrderingCase'
// B-TH-220: New order as an e-mail, read by Brand Beta (brand B), the made-up reader of every wall scan.
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { COMPOSE_NS, EMPTY_COMPOSE, problemsOf, sendHeld as composeHeld, type ComposeDraft } from '../../../lib/request-compose/model'
import type { RequestComposeModel } from '../../../lib/request-compose/view/RequestCompose'
import type { ComposeFilesModel } from '../../../lib/request-compose/view/ComposeFiles' // B-TH-282
import type { HeldFile } from '../../../lib/request-compose/files' // B-TH-282
import { BRAND_BETA } from '../../../lib/testing/two-brands'
import { at as requestAt, betaShellOf, PREFIX as BETA, REQUESTS, requestView } from '../requests/design-data'
import { requestBandOf } from './band'
import { goesToOf, openItems } from './request-model'
// B-TH-304: the catalogue door, open again, read by Brand Beta (the customer's own order numbers, never the office's series).
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { RequestPageModel } from './view/RequestPageView'

/**
 * SCR-185 › New order & reorder (design portal.customer.neworder: sec:start, sec:order-head, sec:lines, sec:reorder,
 * sec:upload, sec:summary, sec:sent; pop:style-picker, pop:new-address, pop:discard; tab:template (the band's ⋯ and the
 * upload's link), tab:style-sheet (case `style-sheet`); B-W2b-194), MADE-UP data only: the three ways in with and without
 * drafts, a draft with its lines and summary, its problems, prices that changed, a role without prices, the reorder of a
 * past order with every difference, the sheet's dry run, the pop-ups, the request sent, a request no longer a draft, a
 * draft gone, loading, a failed read, no connection, an office preview, and the page for a person without it.
 */

type Over = Partial<NewOrderViewModel>

function model(over: Over = {}): NewOrderViewModel {
  const record = over.record === undefined ? draftRecord() : over.record
  return {
    state: 'ready',
    phase: 'draft',
    prefix: PREFIX,
    today: TODAY,
    start: { state: 'ready', drafts: [] },
    way: null,
    record,
    header: headerDraftOf(record?.request ?? null),
    headerErrors: {},
    save: { kind: 'saved', at: at(-1) },
    saving: [],
    writeHeld: null,
    addAddressHeld: null,
    reorder: null,
    upload: null,
    problem: null,
    stale: false,
    notice: null,
    sendHeld: null,
    sent: null,
    closed: null,
    offlineSince: null,
    pending: false,
    styles: [],
    dialogs: { picker: null, address: null, discard: null },
    frame: { mode: 'docked' }, // F-CP-150: the record frame's docked layout whatever the window (the design review)
    ...over,
  }
}

// F-CP-150: who may order in the made-up company (a Designer's Send names them).
const ORDERERS = ['Dora Esempio', 'Marta Esempio']

function held(locale: Locale, view: NewOrderViewModel): string | null {
  if (!view.record) return null
  const t = orderingWords(locale).t
  const reason = draftSendHeld(view.record.request, { preview: false, offline: view.offlineSince !== null, busy: false }, ORDERERS)
  return reason ? t(reason.key, reason.count !== undefined ? { count: reason.count } : reason.names !== undefined ? { names: reason.names } : undefined) : null
}

// ---- F-CP-150: the draft's conversation (the brand's colleague and the factory; made-up names, no brand named) ----------------
function draftThread(locale: Locale): ThreadViewModel {
  const it = locale === 'it'
  const messages: PartnerMessage[] = [
    {
      id: 'd1',
      side: 'partner',
      channel: 'portal',
      author: { name: 'Marta Esempio', mine: true },
      body: it ? 'Le righe sono pronte; il logo arriva domani. Va bene la taglia 54 anche sui pantaloni?' : 'The lines are ready; the logo comes tomorrow. Is size 54 fine on the trousers too?',
      attachments: [],
      at: at(-3),
      atText: formatDateTime(at(-3), { locale }),
    },
    {
      id: 'd2',
      side: 'company',
      channel: 'portal',
      author: { name: 'Giulia Esempio', mine: false },
      body: it ? 'Sì, la 54 c’è per entrambi. Leggiamo la bozza: il lavoro parte quando la inviate.' : 'Yes, 54 is there for both. We read the draft: work starts when you send it.',
      attachments: [],
      at: at(-2),
      atText: formatDateTime(at(-2), { locale }),
    },
  ]
  return { state: 'ready', title: orderingWords(locale).t('draftPage.thread'), record: null, companyName: 'Pelletteria Esempio', messages, composer: { value: '', busy: false, heldReason: null, hint: null, limit: 20_000 }, loadMore: null, accessLine: null, failed: null }
}
// ---- end F-CP-150

// ---- F-CP-151: the made-up files of a draft.
const fileOf = (n: number, originalName: string, contentType: string, lineId: string | null = null, status = 'AVAILABLE'): DraftFile => ({
  id: `0194f0e2-1940-7000-8000-0000000009${String(n).padStart(2, '0')}`,
  lineId,
  originalName,
  kind: contentType.startsWith('image/') ? 'PHOTO' : 'DOCUMENT',
  contentType,
  sizeBytes: 180_000 + n * 1_000,
  status,
  version: 1,
  createdAt: at(-4 + n * 0.1),
})
const LINE_TWO = '0194f0e2-1940-7000-8000-000000000302'
const FILES = {
  logos: [fileOf(1, 'logo-front.ai', 'application/postscript'), fileOf(2, 'sponsor-back.png', 'image/png', LINE_TWO)],
  references: [fileOf(3, 'pit-shirt-reference.jpg', 'image/jpeg', LINE_TWO), fileOf(4, 'sleeve-stripes.pdf', 'application/pdf', null, 'QUARANTINED')],
  sheets: [fileOf(5, 'measures-rider-12.pdf', 'application/pdf')],
}
const UPLOADS = (locale: Locale): UploadRow[] => [
  { key: 'u1', part: 'LOGO', name: 'logo-sleeve.eps', state: 'uploading' },
  { key: 'u2', part: 'LOGO', name: 'logo.svg', state: 'failed', failure: createTranslator(locale, CATALOGUE[locale][COMPOSE_NS] ?? {})('files.problem.page') },
  { key: 'u3', part: 'REFERENCE', name: 'pit-photo.jpg', state: 'failed', failure: orderingWords(locale).t('draftPage.files.notNow') },
]
const many = (count: number) => Array.from({ length: count }, (_, index) => fileOf(10 + (index % 80), `reference-${index + 1}.jpg`, 'image/jpeg'))
// ---- end F-CP-151

/** od-fx2: the shared draft part's own words (the draft's name). */
const draftWords = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][DRAFT_NS] ?? {})

function page(build: (locale: Locale) => Over = () => ({}), phase: NewOrderPhase = 'draft', beta = false): OrderingCaseBuilder {
  return (locale) => {
    const words = orderingWords(locale)
    const over = build(locale)
    // B-TH-304: `beta` — the catalogue door read by Brand Beta (brand B), the made-up reader of every wall scan.
    const base = model({ phase, ...(beta ? { prefix: BETA } : {}), ...over })
    const view = { ...base, sendHeld: over.sendHeld !== undefined ? over.sendHeld : held(locale, base) }
    // F-CP-150: Discard… held for a colleague who neither orders nor started the draft; the band names the draft and asks about it.
    const discardKey = view.record ? draftDiscardHeld(view.record.request, { preview: false, offline: view.offlineSince !== null, busy: false }) : null
    const band = newOrderBandOf({
      words,
      phase: view.phase,
      prefix: beta ? BETA : PREFIX,
      template: templateHref(locale),
      customerRef: view.sent?.customerRef ?? view.record?.request.customerRef ?? null,
      discardHeld: view.writeHeld ?? (discardKey ? words.t(discardKey) : null),
      // od-fx2: the draft's name is a word of the shared draft part (order-draft), as the page reads it (NewOrderPage).
      title: view.record ? draftTitleOf(view.record.request, draftWords(locale), locale) : null,
      ask: view.record ? { type: 'PortalOrderRequest', id: view.record.request.id } : null,
    })
    // F-CP-150: the draft's conversation docked beside the draft and beside a draft no longer a draft (never on the start).
    const thread = view.phase !== 'start' && view.record && view.state === 'ready' ? draftThread(locale) : null
    return { shell: beta ? betaShellOf(locale, band, '/orders/new') : shellOf(locale, band, '/orders/new'), body: { kind: 'neworder', model: view, thread } }
  }
}

const start = (over: (locale: Locale) => Partial<NewOrderViewModel['start']> = () => ({})) => page((locale) => ({ record: null, start: { state: 'ready', drafts: [], ...over(locale) } }), 'start')

const problems = () => {
  const jacket = lineOf(1, {
    sizes: [
      { size: '48', quantity: 4, offered: true },
      { size: '50', quantity: 8, offered: true },
      { size: '62', quantity: 2, offered: false },
    ],
    problems: [
      { code: 'SIZE_NOT_OFFERED', lineId: '0194f0e2-1940-7000-8000-000000000301', size: '62' },
      { code: 'PRICE_CHANGED', lineId: '0194f0e2-1940-7000-8000-000000000301', size: null },
    ],
    unitPriceShown: '400.00',
    priceNow: '410.00',
    amount: '5600.00',
  })
  const trousers = LINE_TROUSERS()
  return draftRecord({ lines: [jacket, { ...trousers, colourway: { id: '0194f0e2-1940-7000-8000-000000000104', code: 'BRN', name: 'Marrone Esempio' }, problems: [{ code: 'COLOUR_DISCONTINUED', lineId: trousers.id, size: null }] }], request: { requestedDate: null } })
}

// ---- B-TH-304: Brand Beta's catalogue door (its PO, its own order numbers; the office's SO-… is in the data, never drawn) ----
const BETA_PAST = PAST_ORDERS.map((row, index) => ({ ...row, customerRef: index === 0 ? BRAND_BETA.customerRef : row.customerRef && `BETA-PO-${4410 - index}` }))
function betaDraft(request: Partial<NonNullable<NewOrderViewModel['record']>['request']> = {}) {
  const source = { orderLineId: '0194f0e2-1940-7000-8000-000000000601', orderId: PAST_ORDERS[0]!.id, orderNumber: PAST_ORDERS[0]!.number, yourNumber: customerNumberOf('ORDER', 12), customerRef: BRAND_BETA.customerRef, orderDate: PAST_ORDERS[0]!.orderDate! }
  return draftRecord({ lines: [lineOf(1, { source }), LINE_TROUSERS()], request: { customerRef: BRAND_BETA.customerRef, ...request } })
}

const reorderModel = (over: Partial<NonNullable<NewOrderViewModel['reorder']>> = {}): NonNullable<NewOrderViewModel['reorder']> => ({
  q: '',
  currency: 'EUR',
  orders: { state: 'ready', rows: PAST_ORDERS },
  order: null,
  selected: [],
  colours: {},
  busy: false,
  writeHeld: null,
  ...over,
})

const pickerModel = (over: Partial<NonNullable<NewOrderViewModel['dialogs']['picker']>> = {}): NonNullable<NewOrderViewModel['dialogs']['picker']> => ({
  step: 'styles',
  q: '',
  category: null,
  ppe: null,
  catalogue: { state: 'ready', read: catalogueRead() },
  selected: [],
  details: {},
  cells: {},
  onDraft: {},
  prefix: PREFIX,
  busy: false,
  problem: null,
  writeHeld: null,
  ...over,
})

const STYLE = '0194f0e2-1940-7000-8000-000000000001'

// ── B-TH-220: New order as an e-mail ─────────────────────────────────────────────────────────────────────────────────
const composeWords = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][COMPOSE_NS] ?? {})
const time = (locale: Locale, hours: number) => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }).format(new Date(requestAt(hours)))
const TYPED: ComposeDraft = { ...EMPTY_COMPOSE, subject: 'Rain jackets like last spring, 40 pieces', message: `Hello,\n${BRAND_BETA.message}\nWe would like 40 rain jackets like last spring: same colours, sizes S to XXL.\nThank you,\n${BRAND_BETA.portalPerson.name}` }
const CHOICES = [
  { id: 'b2b2b2b2-0000-4000-8000-000000000981', label: `Lager, ${BRAND_BETA.address.line1}, ${BRAND_BETA.address.postalCode} ${BRAND_BETA.address.city}`, waiting: false, isDefault: true },
  { id: 'b2b2b2b2-0000-4000-8000-000000000982', label: 'Shop, Betaweg 5, 10117 Berlin', waiting: true, isDefault: false },
]

type ComposeOver = Partial<RequestComposeModel> & { facts?: { preview?: boolean; offline?: boolean; sending?: boolean; closed?: boolean }; showAll?: boolean }

function composeOf(locale: Locale, over: ComposeOver = {}): RequestComposeModel {
  const t = orderingWords(locale).t
  const tc = composeWords(locale)
  const { facts, showAll, ...rest } = over
  const draft = rest.draft ?? EMPTY_COMPOSE
  const held = composeHeld(draft, TODAY, { preview: false, offline: false, sending: false, closed: false, ...facts })
  return {
    goesTo: goesToOf('Pelletteria Esempio', t),
    draft,
    today: TODAY,
    problems: showAll ? problemsOf(draft, TODAY) : {},
    shipTo: { state: 'ready', choices: CHOICES },
    detailsOpen: false,
    kept: { state: 'none' },
    offline: false,
    readOnly: false,
    sending: false,
    sendHeld: held ? tc(held) : null,
    failed: null,
    same: null,
    filesHeld: tc('files.closed'),
    notice: null,
    ...rest,
  }
}

function requestPage(phase: RequestPageModel['phase'], build: (locale: Locale) => Omit<Partial<RequestPageModel>, 'compose'> & { compose?: ComposeOver } = () => ({})): OrderingCaseBuilder {
  return (locale) => {
    const words = orderingWords(locale)
    const { compose, ...over } = build(locale)
    const view: RequestPageModel = {
      phase,
      prefix: BETA,
      closedWords: null,
      admins: [BRAND_BETA.portalPerson.name],
      openCheckFailed: false,
      compose: phase === 'compose' ? composeOf(locale, compose) : null,
      aside: { open: { state: 'ready', items: openItems(REQUESTS, BETA, locale, (iso) => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }).format(new Date(iso))) }, allHref: `${BETA}/orders?chip=REQUESTED`, returnsHref: `${BETA}/returns` /* B-TH-304 */ },
      receipt: null,
      discardOpen: false,
      ...over,
    }
    const sent = view.receipt ? requestView('SENT') : null
    const band = requestBandOf({ words, phase: view.phase, state: sent ? { label: sent.state.words[locale], code: sent.state.code } : null, customerRef: view.receipt?.customerRef ?? null })
    return { shell: betaShellOf(locale, band, '/orders/new'), body: { kind: 'request', model: view } }
  }
}

const RECEIPT = (locale: Locale): NonNullable<RequestPageModel['receipt']> => ({
  seq: 7,
  subject: TYPED.subject,
  message: TYPED.message,
  customerRef: BRAND_BETA.customerRef,
  wantedDate: dayOf(40),
  shipTo: CHOICES[0]!.label,
  at: new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Rome' }).format(new Date(requestAt(0))),
  requestHref: `${BETA}/orders/requests/b2b2b2b2-0000-4000-8000-000000000901`,
})
const dayOf = (days: number) => requestAt(days * 24).slice(0, 10)

// ---- B-TH-282: the customer's files on New order (made up, Brand Beta): held until Send, then how they went on the receipt.
const heldFile = (n: number, over: Partial<HeldFile>): HeldFile => ({ key: `n${n}`, name: `file-${n}.pdf`, sizeBytes: 240_000, contentType: 'application/pdf', kind: 'ATTACHMENT', sheet: false, design: false, problem: null, state: 'held', ...over })
const HELD: readonly HeldFile[] = [
  heldFile(1, { name: 'Measurements Berta B.pdf', sheet: true }),
  heldFile(2, { name: 'Jacket front.jpg', contentType: 'image/jpeg', kind: 'PHOTO', sizeBytes: 3_200_000 }),
  heldFile(3, { name: 'Logo Beta.ai', contentType: 'application/illustrator', design: true }),
  heldFile(4, { name: 'Logo.svg', contentType: 'image/svg+xml', problem: { key: 'files.problem.page' } }),
]
const AFTER: readonly HeldFile[] = [
  { ...HELD[0]!, state: 'sent', fileId: 'f1', uploaded: true },
  { ...HELD[1]!, state: 'scanning', fileId: 'f2', uploaded: true },
  { ...HELD[2]!, state: 'failed', failure: 'This already holds 50 of your files: write to us in the messages for the rest.' },
]
const filesArea = (over: Partial<ComposeFilesModel> = {}): ComposeFilesModel => ({ open: true, closedWords: null, held: HELD, leftOut: 0, when: 'hold', readOnly: false, heldReason: null, ...over })
// ---- end B-TH-282

/** SCR-185's New order as an e-mail (B-TH-220): every state of picture 18 and the receipt of picture 19. */
export const REQUEST_CASES = [
  { id: 'th-220-compose', label: 'New order as an e-mail — empty', model: requestPage('compose'), note: 'One fixed line “Goes to: Sales at Pelletteria Esempio” (no To field: the session is one company). Subject optional, the message in their own words, files held with the API’s own sentence, “Add details (optional)” folded, Send at the foot. From 1280 px: Your open requests (true states, own numbers) and the pointer to returns.' },
  { id: 'th-220-typed', label: 'Typed: the draft kept on this device', model: requestPage('compose', (locale) => ({ compose: { draft: { ...TYPED, customerRef: BRAND_BETA.customerRef, wantedDate: dayOf(40), shipToAddressId: CHOICES[0]!.id }, kept: { state: 'kept', at: time(locale, 0) } } })), note: '“Draft kept on this device · 10:42”; the folded details say what is in them.' },
  { id: 'th-220-details', label: 'Add details open: a new address waits for our check', model: requestPage('compose', (locale) => ({ compose: { draft: { ...TYPED, customerRef: BRAND_BETA.customerRef, wantedDate: dayOf(40), shipToAddressId: CHOICES[1]!.id }, detailsOpen: true, kept: { state: 'kept', at: time(locale, 0) } } })), note: 'Nothing in the fold is needed to send. Their PO, the day wanted (today or later), one of their own delivery addresses.' },
  { id: 'th-220-problems', label: 'Send held: nothing written, a day in the past', model: requestPage('compose', () => ({ compose: { draft: { ...EMPTY_COMPOSE, wantedDate: '2020-01-10' }, detailsOpen: true, showAll: true } })), note: 'Held before Send with the reason; the field says what is wrong.' },
  { id: 'th-220-long', label: 'A long message: the counter near the end', model: requestPage('compose', () => ({ compose: { draft: { ...TYPED, message: `${TYPED.message}\n${'Detail of the order. '.repeat(880)}` } } })), note: 'The counter shows from 90 % of 20 000 characters; over it Send holds.' },
  { id: 'th-220-carried', label: 'A style from the catalogue carried into the message', model: requestPage('compose', (locale) => ({ compose: { draft: { ...EMPTY_COMPOSE, subject: 'BX-200 Rain jacket Beta', message: '- BX-200 · Rain jacket Beta: ' }, notice: orderingWords(locale).t('request.styleNotice', { count: 1 }) } })), note: 'While the catalogue door is closed (B-TH-304), “Add to order” starts a request about the style; nothing is ordered until Send.' },
  { id: 'th-220-same', label: 'The same words sent ten minutes ago', model: requestPage('compose', (locale) => ({ compose: { draft: TYPED, same: { at: time(locale, -0.1), yours: locale === 'it' ? 'La vostra richiesta 7' : 'Your request 7' } } })), note: 'Asked first, never sent twice by accident (and one Idempotency-Key per content: a double click is one request).' },
  { id: 'th-220-failed', label: 'Not sent: no connection', model: requestPage('compose', (locale) => ({ compose: { draft: TYPED, failed: orderingWords(locale).t('request.failed.unavailable') } })) },
  { id: 'th-220-offline', label: 'Offline', model: requestPage('compose', () => ({ compose: { draft: TYPED, offline: true, facts: { offline: true } } })), note: 'Send holds “You are offline: your text stays here”; the text stays on this device.' },
  { id: 'th-220-preview', label: 'An office preview (read only)', model: requestPage('compose', () => ({ compose: { draft: TYPED, readOnly: true, facts: { preview: true } } })) },
  { id: 'th-220-closed', label: 'Held before typing: no request numbering for the company', model: requestPage('closed', () => ({ closedWords: 'Orders by portal are not open yet for Pelletteria Esempio — please write to your contact.' })), note: 'The API’s own words (B-TH-012); the admins get the alert REQUEST_NUMBERING_MISSING.' },
  { id: 'th-220-no-right', label: 'A colleague who may not order', model: requestPage('noRight'), note: 'Who can give the right; no dead button.' },
  { id: 'th-220-no-right-alone', label: 'Nobody to ask in the company', model: requestPage('noRight', () => ({ admins: [] })), note: '“Ask us to add a buyer” with Ask a question.' },
  { id: 'th-220-check-failed', label: 'Could not check whether orders are open', model: requestPage('compose', () => ({ openCheckFailed: true })) },
  { id: 'th-220-receipt', label: 'The receipt: “Received — your request 7.”', model: requestPage('sent', (locale) => ({ receipt: RECEIPT(locale) })), note: 'The customer’s own number (never INQ-…), what was sent, Open the request, New order; no answer-time promise; a copy by e-mail is not claimed as delivered.' },
  { id: 'th-220-loading', label: 'Loading', model: requestPage('loading') },
  // ---- B-TH-282
  { id: 'th-282-files', label: 'Files held until Send: a measurement sheet ticked, a photo, a design file, a refused SVG', model: requestPage('compose', () => ({ compose: { draft: TYPED }, files: filesArea() })), note: 'Drop, paste or browse; a PDF or a photo may be ticked “This is a measurement sheet” (body data); Illustrator, EPS, Photoshop and ZIP are kept as they are, download only; SVG is refused naming the way out. They go right after Send, through the virus scan.' },
  { id: 'th-282-files-closed', label: 'Files closed until the virus scanner runs (production)', model: requestPage('compose', () => ({ compose: { draft: TYPED }, files: filesArea({ open: false, held: [], closedWords: 'Uploads from outside are closed for now: the virus scanner is not running here yet. Please send the file to your contact by e-mail.' }) })), note: 'The API’s own sentence; the area takes nothing; the request still goes (B-TH-086 opens it with ClamAV).' },
  { id: 'th-282-receipt-files', label: 'The receipt: how the files went — sent, held for the scan, one to retry', model: requestPage('sent', (locale) => ({ receipt: RECEIPT(locale), receiptFiles: { held: AFTER, openHref: `${BETA}/orders/requests/b2b2b2b2-0000-4000-8000-000000000901` } })), note: '“1 file sent · 1 held for the virus scan · 1 file did not go” with Retry and Open the request; the request itself is made.' },
  // ---- end B-TH-282
  // ---- B-TH-287 (P-CUS-NEW.message-F02): the draft on the server.
  { id: 'th9-287-saved', label: 'Draft saved on the server', model: requestPage('compose', (locale) => ({ compose: { draft: TYPED, kept: { state: 'saved', at: time(locale, 0) } } })), note: '“Draft saved 10:42”: kept on the server for this person, so it is there on another computer too. Sending clears it.' },
  { id: 'th9-287-replaced', label: 'Two tabs: the newest wins, said', model: requestPage('compose', (locale) => ({ compose: { draft: TYPED, kept: { state: 'saved', at: time(locale, 0), replaced: true } } })), note: 'Another tab or computer had saved a newer draft: this one replaced it, and the line says so.' },
  { id: 'th9-287-not-saved', label: 'Not saved · Retry (the text stays on this device)', model: requestPage('compose', () => ({ compose: { draft: TYPED, kept: { state: 'notSaved', device: true } } })), note: 'The save failed: “Not saved — your text stays on this device · Retry”. Never a “saved” that was not.' },
  // ---- end B-TH-287
] as const

export const designScreen = defineDesignScreen<OrderingCaseBuilder>({
  screen: 'SCR-185',
  title: 'New order as an e-mail (B-TH-220); below, the catalogue door’s New order & reorder (closed until B-TH-304)',
  view: OrderingCase,
  cases: [
    ...REQUEST_CASES,
    { id: 'start', label: 'How do you want to order? (no drafts)', model: start(), note: 'Three ways in, one draft. A way makes the draft on the server; the address keeps it (?draft=).' },
    { id: 'start-drafts', label: 'Drafts to continue', model: start(() => ({ drafts: DRAFTS })), note: '“From … · 3 products” (PressableRow; od-fx8 W-23).' },
    { id: 'start-loading', label: 'The drafts loading', model: start(() => ({ state: 'loading' })) },
    { id: 'start-error', label: 'The drafts could not be read', model: start(() => ({ state: 'error' })), note: 'Never drawn as no drafts: the problem in our words + Try again.' },
    { id: 'draft', label: 'A draft: the checklist, the lines with their size grids, date and delivery, notes, your price — its conversation docked', model: page(), note: 'F-CP-150: saved on leaving a field (“Saved 10:42 · v7”); one size grid per line (stacked on a phone); Send to the factory and Discard… in the band; “The factory can read this draft. Work starts only when you send it.”' },
    { id: 'draft-typed', label: 'Sizes typed, not saved yet', model: page(() => ({ save: { kind: 'saving' }, saving: ['0194f0e2-1940-7000-8000-000000000301'] })), note: 'Leaving the line saves it (PUT with the version).' },
    { id: 'draft-problems', label: 'Send held: problems — Show me', model: page(() => ({ record: problems() })), note: 'A size not offered (on its cell), a discontinued colour (choose another), a price that changed; Send held with the count; Show me lists them.' },
    { id: 'draft-prices', label: 'Prices changed since you started', model: page(() => ({ record: draftRecord({ lines: [lineOf(1, { unitPriceShown: '400.00', priceNow: '410.00', problems: [{ code: 'PRICE_CHANGED', lineId: '0194f0e2-1940-7000-8000-000000000301', size: null }] }), LINE_TROUSERS()] }) })), note: 'Banner with “Take today’s prices”; the line says “Price now … (was …)”.' },
    { id: 'draft-empty', label: 'No lines yet', model: page(() => ({ record: draftRecord({ lines: [], request: { problems: [{ code: 'NO_LINES', lineId: null, size: null }] } }) })) },
    { id: 'draft-no-prices', label: 'A colleague without prices', model: page(() => ({ record: draftRecord({ seesPrices: false }) })), note: 'No unit price, amount or net anywhere; one quiet line “Prices are not part of your access”.' },
    { id: 'draft-waiting-address', label: 'Ship to a new address (waits for our check)', model: page(() => { const record = draftRecord({ request: { shipToAddressId: ADDRESSES[2]!.id } }); return { record, header: headerDraftOf(record.request) } }), note: 'The request can still be sent; we check the address when we confirm.' },
    { id: 'draft-not-admin', label: 'Add a new address held: only the admin adds addresses', model: page((locale) => ({ addAddressHeld: orderingWords(locale).t('head.addAddressAdmin', { names: 'Paolo Esempio' }) })) },
    { id: 'draft-head-problem', label: 'A requested date in the past', model: page(() => ({ header: { ...headerDraftOf(draftRecord().request), requestedDate: '2020-01-10' }, headerErrors: { requestedDate: 'head.problem.datePast' }, save: { kind: 'failed', reason: null } })) },
    { id: 'draft-removed', label: 'A line removed, with Undo', model: page((locale) => ({ record: draftRecord({ lines: [LINE_TROUSERS()] }), notice: { lines: [orderingWords(locale).t('notice.removed', { seq: 1, style: 'JKT-100', colour: 'Nero Esempio' })], undo: true } })) },
    { id: 'draft-stale', label: 'Changed elsewhere while typing', model: page(() => ({ stale: true, problem: 'refusal.conflict' })), note: 'What was typed stays; “Read it again”.' },
    // ---- F-CP-150 (customer page plan C5, D9–D11; picture 22): the draft order page — the brand's Designer, who changed it, every state.
    {
      id: 'cp150-designer',
      label: 'The brand’s Designer: fills the draft without prices; Send held naming who may order',
      model: page(() => ({ record: draftRecord({ seesPrices: false, request: { may: { send: false, withdraw: false, discard: true } } }), mayOrder: false, seesOrders: false })),
      note: 'portal.orderDrafts.edit without portal.orderRequests.manage (D11): every part can be filled, Send is held with “Only colleagues who may order send it: …”, Reorder a past order is held (“Your access does not show orders”), Your price says prices are not part of the access — no amount anywhere (M-CP-2).',
    },
    { id: 'cp150-saved-by', label: 'Saved by a colleague: who changed it last (once the API names them, B-CP-075)', model: page(() => ({ record: draftRecord({ request: { lastEditedBy: 'Marta Esempio', lastEditedAt: at(-1), note: 'Numbers on the left sleeve too.' } }) })), note: '“Saved 10:42 by Marta Esempio · v7”; without the name (before B-CP-075) “Saved 10:42 · v7”.' },
    { id: 'cp150-stale', label: 'Changed by a colleague while you typed: what you typed stays', model: page(() => ({ stale: true, staleBy: { who: 'COLLEAGUE' as const, name: 'Marta Esempio' } })), note: 'A 409 on a write: the ONE banner says the draft changed and who changed it; “Read it again” takes their version; rows keep their order (by seq).' },
    { id: 'cp150-later', label: 'People and sizes marked “Sending later”', model: page(() => ({ record: draftRecord({ lines: [lineOf(1, { sizes: [], pieces: 0 })], request: { laterParts: ['PEOPLE'] } }) })), note: 'The chip and the card say “Sending later” (B-CP-075 keeps the mark; the roster comes with F-CP-154).' },
    { id: 'cp150-discard-held', label: 'Discard… held: neither one who orders nor the colleague who started it', model: page(() => ({ record: draftRecord({ seesPrices: false, request: { may: { send: false, withdraw: false, discard: false } } }), mayOrder: false, seesOrders: false })) },
    { id: 'cp150-narrow', label: 'A phone: the conversation behind “Messages (2 new)”', model: page(() => ({ frame: { mode: 'stacked', newCount: 2 } })), note: 'Below 1280 px the draft leads; the chips scroll sideways inside their strip, never the page.' },
    { id: 'cp150-offline', label: 'Offline: one banner, writes held', model: page((locale) => ({ offlineSince: at(-0.2), writeHeld: orderingWords(locale).t('held.offline') })) },
    { id: 'cp150-sent', label: 'Sent: the end state beside its conversation', model: page(() => ({ record: draftRecord({ request: { status: 'SENT' } }), sent: { customerRef: 'BA-PO-4521', lines: 2, pieces: 26, net: '9500.00', currency: 'EUR', seesPrices: true } }), 'sent'), note: 'Their PO, never a request number of ours (B-TH-304); the factory answers in the same conversation.' },
    { id: 'cp150-refused', label: 'Refused: start a new draft', model: page(() => ({ record: draftRecord({ request: { status: 'REFUSED' } }), closed: { status: 'REFUSED', salesOrder: null } }), 'closed') },
    { id: 'cp150-withdrawn', label: 'Withdrawn', model: page(() => ({ record: draftRecord({ request: { status: 'WITHDRAWN' } }), closed: { status: 'WITHDRAWN', salesOrder: null } }), 'closed') },
    {
      id: 'cp150-accepted-designer',
      label: 'Accepted, read by the Designer: who follows it (no door to orders)',
      model: page(() => ({ record: draftRecord({ seesPrices: false, request: { status: 'ACCEPTED' } }), closed: { status: 'ACCEPTED', salesOrder: { id: '0194f0e2-1940-7000-8000-000000000777' } }, seesOrders: false, mayOrder: false }), 'closed'),
      note: '“The factory made it an order: your buyer follows it.” A Buyer reads “Open the order”.',
    },
    // ---- end F-CP-150
    // ---- F-CP-151 (B-CP-072; D14): the draft's files cards.
    { id: 'cp151-files', label: 'Files: logos (vector prints best), references, a measurement sheet — uploads open (here)', model: page(() => ({ record: draftRecord({ request: { files: FILES, uploads: { open: true, words: null } } }) })), note: 'Each file says what it is and where it sits (“vector · on the draft”, “picture · on line 2”); one waits for the virus scan; × takes it out by its version. The logos and references chips turn Ready.' },
    { id: 'cp151-closed', label: 'Uploads closed on live until the virus scanner: the e-mail way in each card', model: page(() => ({ record: draftRecord({ request: { files: FILES, uploads: { open: false, words: 'Uploads from outside are closed for now.' } } }) })), note: 'D14 (O7 not approved): no drop area; “e-mail them to your contact at the factory, naming «BA-PO-4521»”; lines, sizes and notes still work. The API’s English sentence is never shown: the page says it in Italian or English.' },
    { id: 'cp151-uploading', label: 'A file going up, one refused (an SVG), one that did not go', model: page((locale) => ({ record: draftRecord({ request: { files: { logos: [], references: [], sheets: [] }, uploads: { open: true, words: null } } }), uploads: UPLOADS(locale) })) },
    { id: 'cp151-full', label: 'The draft holds 50 files: Add held with words', model: page(() => ({ record: draftRecord({ request: { files: { logos: [], references: many(50), sheets: [] }, uploads: { open: true, words: null } } }) })) },
    { id: 'cp151-later', label: '“We send these later” on Logos (once the API keeps the mark)', model: page(() => ({ record: draftRecord({ request: { files: { logos: [], references: [], sheets: [] }, uploads: { open: true, words: null }, laterParts: ['LOGOS'] } }) })), note: 'The Logos chip says “Sending later”; the toggle shows only once the API answers laterParts (B-CP-075).' },
    // ---- end F-CP-151
    // ---- F-CP-152 (12 §2 Doors): the draft start — "Just write it in words" for who may order; Reorder held for a Designer.
    // ---- F-CP-154 (customer page plan C5; 12 §2 parts 1, 4, 6; review A5, G6; picture 22): lines of every kind, the roster, Your price.
    {
      id: 'cp154-kinds',
      label: 'Lines of every kind: from the catalogue, described by you, made to measure with four riders — Your price filled (Brand Admin)',
      model: page(() => ({ record: kindsRecord() })),
      note: 'One list by seq. People and sizes: each line’s pieces, the privacy line, the made-to-measure roster (Size · Measurement sheet · Sending later; no saved measurements in v1). Your price: one cell per line, our list price beside it on catalogue lines, the total.',
    },
    {
      id: 'cp154-sheet-only',
      label: 'A made-to-measure line with no names typed: “People: in the attached sheet” (review A5)',
      model: page(() => ({ record: kindsRecord({ custom: [describedLine(), mtmLine({ people: [], peopleInSheet: true, pieces: 0 })] }) })),
      note: 'A team with one measurement sheet for twelve riders sends without typing twelve names: the sheet on the line stands for its roster.',
    },
    {
      id: 'cp154-no-people',
      label: 'A by-person line with no one named and no sheet: People and sizes is missing, Send held',
      model: page(() => {
        const empty = mtmLine({ people: [], pieces: 0, problems: [{ code: 'NO_PEOPLE', lineId: mtmLine().id, size: null, part: 'PEOPLE', personId: null }] })
        return { record: kindsRecord({ custom: [describedLine(), empty], request: { files: { logos: [], references: [], sheets: [] }, problems: empty.problems } }) }
      }),
    },
    {
      id: 'cp154-designer',
      label: 'The brand’s Designer: every kind of line and the roster, no price anywhere',
      model: page(() => ({ record: kindsRecord({ seesPrices: false, request: { may: { send: false, withdraw: false, discard: true } } }), mayOrder: false, seesOrders: false })),
      note: 'M-CP-2: no list price, no Your price, no total — part 6 says “Prices are not part of your access.” The roster is the Designer’s to fill.',
    },
    {
      id: 'cp154-mtm-off',
      label: 'Made to measure switched off by the office: “not open for you yet”, the line holds Send',
      model: page(() => {
        const closed = mtmLine({ problems: [{ code: 'MTM_CLOSED', lineId: mtmLine().id, size: null, part: 'NEED', personId: null }] })
        return { record: kindsRecord({ custom: [describedLine(), closed], request: { madeToMeasure: { open: false, words: { it: 'chiuso', en: 'closed' }, garmentTypes: [] }, problems: closed.problems } }) }
      }),
      note: 'Made to measure is open for every customer by default; only where the office switched it off “Add a line ▾ › Made to measure” is held with these words.',
    },
    {
      id: 'cp154-price-typed',
      label: 'Your price typed: one cell not saved yet, one that does not read as a price',
      model: page(() => ({ record: kindsRecord(), ownPrices: { [describedLine().id]: '19,90', [mtmLine().id]: 'abc' }, ownPriceProblems: { [mtmLine().id]: 'draftPage.price.problem' } })),
      note: 'Saved on leaving the cell, with the draft’s version; “18,50” and “18.50” both read; a cell that is not a price says so and sends nothing.',
    },
    {
      id: 'od-r1-draft',
      label: 'R1: a mail and one products table — Still open informs, Send never held by a missing cell, saved by the factory',
      model: page(() => ({
        record: kindsRecord({
          request: {
            subject: 'Race team kit for 2027',
            designStarted: true,
            savedBy: { who: 'FACTORY' as const, name: null },
            stillOpen: { openCount: 2, confirmHeld: true, items: [{ kind: 'PIECES', lineId: mtmLine().id, seq: mtmLine().seq, topic: null, state: 'NOT_DECIDED', confirmNeeds: true }, { kind: 'DATE', lineId: null, seq: null, topic: null, state: 'NOT_DECIDED', confirmNeeds: false }] },
          },
        }),
      })),
      note: 'od-tw (t.3): the R1 face of SCR-185 — the subject names the draft; "The factory reads this draft from the first save." · "The factory is working on the design."',
    },
    {
      id: 'od-pieces',
      label: 'A row’s Pieces (a centred window): by person — the roster',
      model: page(() => {
        const record = kindsRecord()
        const view = draftViewOf(record)
        const row = productRowsOf(record.request).find((entry) => entry.sizing === 'MADE_TO_MEASURE')!
        const rosterLine = view.request.customLines?.find((line) => line.id === row.id) ?? null
        const pieces = { row, mode: piecesModesOf(row)[0]!, total: '', cells: {}, roster: { draft: view, writeHeld: null, uploadsOpen: true, addHeld: null, draftName: '' }, rosterLine, busy: false, failed: null, writeHeld: null }
        return { record, dialogs: { picker: null, address: null, discard: null, pieces } }
      }),
      note: 'od-w1.2 (R3): a custom size is made for each person — the row’s roster (Size · Measurement sheet · Sending later), its sheet, the privacy line.',
    },
    {
      id: 'od-pieces-sizes',
      label: 'A row’s Pieces (a centred window): by size',
      model: page(() => {
        const record = kindsRecord()
        const row = productRowsOf(record.request)[0]!
        const pieces = { row, mode: piecesModesOf(row)[0]!, total: '', cells: { '48': 2, '50': 3 }, roster: { draft: draftViewOf(record), writeHeld: null, uploadsOpen: true, addHeld: null, draftName: '' }, rosterLine: null, busy: false, failed: null, writeHeld: null }
        return { record, dialogs: { picker: null, address: null, discard: null, pieces } }
      }),
      note: 'od-w1.2 (R3): A total · By size · By person · Not decided yet; ONE save of the row at the draft’s version.',
    },
    {
      id: 'od-options',
      label: 'A row’s Options (a centred window): “Not decided yet” is an answer',
      model: page(() => {
        const record = kindsRecord()
        const row = productRowsOf(record.request)[0]!
        return { record, dialogs: { picker: null, address: null, discard: null, options: { row, topic: 'Leather', typed: 'Cowhide\nKangaroo', addHeld: null, busy: false, failed: null, writeHeld: null } } }
      }),
    },
    {
      id: 'cp154-person',
      label: 'Add a person: measured by the line’s measurement sheet',
      model: page(() => {
        const draft = { ...EMPTY_PERSON, name: 'Marco Esempio', number: '7', measureBy: 'SHEET' as const, sheetId: SHEET_ON_MTM.id }
        const person: PersonDialogModel = { mode: 'add', seq: 3, name: null, draft, problems: personProblems(draft, [SHEET_ON_MTM]), showProblems: false, sheets: [SHEET_ON_MTM], busy: false, failed: null }
        return { record: kindsRecord(), dialogs: { picker: null, address: null, discard: null, person } }
      }),
      note: 'Size · Measurement sheet · Sending later (no saved measurements in v1); a sheet is one of this draft’s.',
    },
    {
      id: 'cp154-person-change',
      label: 'Change a person: a size left empty is held at its field',
      model: page(() => {
        const rider = RIDERS()[1]!
        const draft = { ...EMPTY_PERSON, name: rider.name, number: rider.number ?? '', measureBy: 'SIZE' as const, size: '' }
        const person: PersonDialogModel = { mode: 'change', seq: 3, name: rider.name, draft, problems: personProblems(draft, []), showProblems: true, sheets: [], busy: false, failed: null }
        return { record: kindsRecord(), dialogs: { picker: null, address: null, discard: null, person } }
      }),
    },
    // ---- end F-CP-154
    // ---- F-CP-158 (customer page plan C5; 12 §2: a draft with only logos, or only a measurement sheet, is saved and shared): SCR-185-draft's
    // last states — every other state is above (empty, typed, problems, prices moved, no prices, stale, files, every kind, sent, closed).
    {
      id: 'cp158-logos-only',
      label: 'A draft with only logos: saved and shared with the team, read by the factory; Send waits for a line',
      model: page(() => ({ record: draftRecord({ lines: [], request: { files: { logos: FILES.logos, references: [], sheets: [] }, uploads: { open: true, words: null }, problems: [{ code: 'NO_LINES', lineId: null, size: null }] } }) })),
      note: 'The checklist counts the logos; the factory reads the draft from its first save (K9) and may answer in its conversation before anything is sent.',
    },
    {
      id: 'cp158-sheet-only',
      label: 'A draft with only a measurement sheet: saved and shared; the lines come next; Send waits for a line',
      model: page(() => ({ record: draftRecord({ lines: [], request: { files: { logos: [], references: [], sheets: FILES.sheets }, uploads: { open: true, words: null }, problems: [{ code: 'NO_LINES', lineId: null, size: null }] } }) })),
      note: 'A measurement sheet stays body data: named to the team and to the office people who may read measurements only.',
    },
    {
      id: 'cp158-sent-designer',
      label: 'Sent, read by the brand’s Designer: the end state without a price',
      model: page(() => ({ record: draftRecord({ seesPrices: false, request: { status: 'SENT', may: { send: false, withdraw: false, discard: false } } }), sent: { customerRef: 'BA-PO-4521', lines: 2, pieces: 26, net: null, currency: 'EUR', seesPrices: false }, mayOrder: false, seesOrders: false }), 'sent'),
      note: 'M-CP-2: no net and no price; the factory answers in the same conversation.',
    },
    // ---- end F-CP-158
    { id: 'cp152-start-designer', label: 'The draft start, read by the brand’s Designer: Reorder held, no words door', model: page(() => ({ record: null, start: { state: 'ready', drafts: DRAFTS }, mayOrder: false, seesOrders: false }), 'start'), note: 'A Designer keeps drafts but reads no orders: “Reorder a past order” says “Your access does not show orders”; the request like an e-mail is not theirs (no link). The team’s drafts to continue.' },
    // ---- end F-CP-152
    { id: 'reorder', label: 'Reorder: the past orders', model: page(() => ({ way: 'reorder', reorder: reorderModel() })), note: 'Their PO first, ours second (RefPair), date, lines, pieces. Enter or a click opens one.' },
    {
      id: 'reorder-order',
      label: 'Reorder: one order’s lines with every difference',
      model: page(() => ({ way: 'reorder', reorder: reorderModel({ order: { id: PAST_ORDERS[0]!.id, state: 'ready', read: pastOrder() }, selected: ['0194f0e2-1940-7000-8000-000000000601'] }) })),
      note: '“Price now … (was …)”, sizes left out, a discontinued colour to replace (the row is selectable once chosen), a style no longer sold (not selectable, with the reason). Bulk action: Add N lines to the draft.',
    },
    // ---- B-TH-304: the catalogue door again, read by Brand Beta: its own order numbers, its PO, never an office number ----
    { id: 'th-304-draft', label: 'The catalogue door (Brand Beta): a draft with a line from a past order', model: page(() => ({ record: betaDraft() }), 'draft', true), note: 'The line says “from your order 12 (your PO …)”: the customer’s own number, never SO-….' },
    { id: 'th-304-reorder', label: 'The catalogue door (Brand Beta): reorder — past orders by their own number', model: page(() => ({ record: betaDraft(), way: 'reorder', reorder: reorderModel({ orders: { state: 'ready', rows: BETA_PAST } }) }), 'draft', true), note: 'Their PO first, then “Your order 12” (RefPair); an order with no number of its own shows its PO and date only.' },
    {
      id: 'th-304-reorder-order',
      label: 'The catalogue door (Brand Beta): one past order’s lines',
      model: page(() => ({ record: betaDraft(), way: 'reorder', reorder: reorderModel({ orders: { state: 'ready', rows: BETA_PAST }, order: { id: BETA_PAST[0]!.id, state: 'ready', read: { ...pastOrder(), order: { ...pastOrder().order, customerRef: BRAND_BETA.customerRef } } } }) }), 'draft', true),
      note: '“Lines of your order 12”.',
    },
    { id: 'th-304-sent', label: 'The catalogue door (Brand Beta): sent', model: page(() => ({ record: betaDraft(), sent: { customerRef: BRAND_BETA.customerRef, lines: 2, pieces: 26, net: '9500.00', currency: 'EUR', seesPrices: true } }), 'sent', true), note: 'Their PO; “you find it under Orders & requests” (od-fx12: an order request, whatever its rows); no request number of ours; no answer-time promise.' },
    { id: 'th-304-accepted', label: 'The catalogue door (Brand Beta): confirmed as an order', model: page(() => ({ record: betaDraft({ status: 'ACCEPTED' }), closed: { status: 'ACCEPTED', salesOrder: { id: '0194f0e2-1940-7000-8000-000000000777' } } }), 'closed', true), note: 'Open the order: its own page names “Your order 13”.' },
    { id: 'reorder-empty', label: 'Reorder: no past orders', model: page(() => ({ way: 'reorder', reorder: reorderModel({ orders: { state: 'ready', rows: [] } }) })) },
    { id: 'reorder-error', label: 'Reorder: the past orders could not be read', model: page(() => ({ way: 'reorder', reorder: reorderModel({ orders: { state: 'error', rows: [] } }) })) },
    { id: 'upload', label: 'Upload a sheet: the template and the file', model: page(() => ({ way: 'upload', upload: { sheet: { state: 'idle' }, templateHref: templateHref('it'), writeHeld: null } })), note: 'tab:template: the XLSX opens in a new tab (the browser saves it).' },
    { id: 'upload-reading', label: 'Upload: reading the file', model: page(() => ({ way: 'upload', upload: { sheet: { state: 'reading', fileName: 'ordine-esempio.xlsx' }, templateHref: templateHref('it'), writeHeld: null } })) },
    { id: 'upload-read', label: 'Upload: the dry run, a verdict per row', model: page(() => ({ way: 'upload', upload: { sheet: { state: 'read', fileName: 'ordine-esempio.xlsx', answer: uploadAnswer(), applying: false }, templateHref: templateHref('it'), writeHeld: null } })), note: 'Nothing is added until “Add 4 rows to the order”; refused rows can be downloaded to fix them.' },
    { id: 'upload-failed', label: 'Upload: a file we could not read', model: page(() => ({ way: 'upload', upload: { sheet: { state: 'failed', fileName: 'vecchio-ordine.xlsx', problem: 'upload.unreadable' }, templateHref: templateHref('it'), writeHeld: null } })) },
    { id: 'picker', label: 'pop:style-picker — choose styles', model: page(() => ({ way: 'pick', dialogs: { picker: pickerModel({ selected: [STYLE] }), address: null, discard: null } })), note: 'Search (/), chips, cards with colours, sizes and “from” price; Space chooses a card; the style sheet opens in a new tab.' },
    {
      id: 'picker-sizes',
      label: 'pop:style-picker — the sizes per colour',
      model: page(() => ({
        way: 'pick',
        dialogs: {
          picker: pickerModel({ step: 'sizes', selected: [STYLE], details: { [STYLE]: { state: 'ready', detail: styleDetail() } }, cells: { [STYLE]: { '0194f0e2-1940-7000-8000-000000000102': { '48': 2, '50': 4 } } }, onDraft: { [`${STYLE}|0194f0e2-1940-7000-8000-000000000101`]: 1 } }),
          address: null,
          discard: null,
        },
      })),
      note: 'One line per colour; a colour already on the draft says where to change it.',
    },
    { id: 'picker-loading', label: 'pop:style-picker — loading', model: page(() => ({ way: 'pick', dialogs: { picker: pickerModel({ catalogue: { state: 'loading', read: null } }), address: null, discard: null } })) },
    { id: 'address', label: 'pop:new-address', model: page(() => ({ dialogs: { picker: null, address: { draft: EMPTY_ADDRESS, problems: addressProblems(EMPTY_ADDRESS), showProblems: false, busy: false, failed: null, refused: {} }, discard: null } })), note: 'The account’s own field words; the check of a new address said first.' },
    { id: 'address-problems', label: 'pop:new-address — held at the fields', model: page(() => ({ dialogs: { picker: null, address: { draft: { ...EMPTY_ADDRESS, postalCode: '401' }, problems: addressProblems({ ...EMPTY_ADDRESS, postalCode: '401' }), showProblems: true, busy: false, failed: null, refused: { province: 'address.refused.province' } }, discard: null } })) },
    { id: 'discard', label: 'pop:discard — Discard this draft?', model: page(() => ({ dialogs: { picker: null, address: null, discard: { lines: 2, busy: false, failed: null } } })) },
    {
      id: 'sent',
      label: 'sec:sent — Request sent',
      model: page(() => ({ sent: { customerRef: 'BA-PO-4521', lines: 2, pieces: 26, net: '9500.00', currency: 'EUR', seesPrices: true } }), 'sent'),
      note: '“Order request sent — your PO …: you find it under Orders & requests” (od-fx12; B-TH-304: never the office’s request number; no answer-time promise, B-TH-041) · Open the order (status Requested) · New order.',
    },
    { id: 'closed', label: 'A request no longer a draft', model: page(() => ({ record: draftRecord({ request: { status: 'SENT', number: 'RQ-2026-0081' } }), closed: { status: 'SENT', salesOrder: null } }), 'closed') },
    { id: 'missing', label: 'A draft that no longer exists', model: page(() => ({ state: 'missing', record: null })) },
    { id: 'loading', label: 'Loading the draft', model: page(() => ({ state: 'loading', record: null })) },
    { id: 'error', label: 'The draft could not be read', model: page(() => ({ state: 'error', record: null })) },
    { id: 'offline', label: 'No connection', model: page((locale) => ({ offlineSince: at(-1), writeHeld: orderingWords(locale).t('held.offline'), sendHeld: orderingWords(locale).t('held.offline') })), note: 'Every action that sends is held with “No connection”; typed text stays.' },
    { id: 'preview', label: 'An office preview (read only)', model: page((locale) => ({ writeHeld: orderingWords(locale).t('held.preview'), sendHeld: orderingWords(locale).t('held.preview'), addAddressHeld: orderingWords(locale).t('held.preview') })) },
    {
      id: 'style-sheet',
      label: 'tab:style-sheet — the style sheet in its own tab',
      model: (locale) => ({ shell: shellOf(locale, { title: orderingWords(locale).t('sheet.title', { code: 'JKT-100' }) }, '/catalogue'), body: { kind: 'sheet', model: { state: 'ready', detail: styleDetail(), partyName: 'Brand Alpha S.r.l.', printedAt: at(0) } } }),
      note: 'To read beside the draft, or Print or save as PDF.',
    },
    {
      id: 'no-access',
      label: 'Not part of the person’s access',
      model: (locale) => ({ shell: shellOf(locale, { title: orderingWords(locale).t('band.title') }, '/orders/new'), body: { kind: 'noAccess', admins: ['Paolo Esempio'] } }),
      note: 'A colleague who may not order (a typed or old address): who to ask, and Home. Not in the navigation (fails closed).',
    },
  ],
})
