import { PREFIX } from '../../../sales/quotes/record/fixtures'
import { DEPTH_ROWS, depthModel } from '../depth/fixtures'
import { requestRow } from '../inbox'
import type { InboxViewModel } from '../model'
import type { BrandRequest, RequestImpact, RequestImpactRead, RequestRecord } from './api'
import { batchLinesOf, requestGroupsOf, type RequestReviewModel } from './model'

/**
 * F-PR-08 — a customer's requests in Home › Approvals: the design cases the screen's `../fixtures.ts` draws (SCR-030), made-up data
 * only (PLAN §3.1): the customer "Brand Alpha", its buyer "Anna Esempio", demo orders and work orders. One inbox with a customer's
 * "Urgent – asked", a pause and a batch of 6 cancels as one group row; the window of each kind (two accepts for "Urgent – asked", a
 * cancel answered by Sales with its fee for a price reader, a counter the customer said yes to, a reader whose team does not answer
 * the kind), Suggest something else, a batch's window and its Accept all (each re-checked, one left out) and done screen, the notice
 * after an accepted pause with "Lift the hold", and the neutral "not found" of another customer's request (PW-H01b).
 */

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const NOW = at(12, 10, 42)
const TODAY = '2026-11-12'
const COMPANY = '0190f0e2-1111-7000-8000-000000000001'
const id = (n: number) => `0190f0e2-3080-7000-8000-${String(n).padStart(12, '0')}`
const words = (en: string, it: string) => ({ en, it })
const ALPHA = { id: id(900), code: 'ALPHA', name: 'Brand Alpha' }
const BATCH = id(800)

const IMPACT: RequestImpact = {
  kind: 'RUSH',
  frozen: [],
  blocked: false,
  priced: false,
  pricedWords: null,
  earliest: { date: '2026-12-08', partial: false, meetsWanted: true, words: words('The earliest date we see now is 8 Dec: before the date asked.', 'La data più vicina che vediamo ora è l’8 dic: prima della data chiesta.') },
  notes: [],
  words: words('Nothing is fixed yet; no price applies.', 'Niente è ancora fissato; nessun costo.'),
}

export function brandRequest(n: number, overrides: Partial<BrandRequest> = {}): BrandRequest {
  return {
    id: id(n),
    orderId: id(100 + n),
    orderNumber: `SO-DEMO-0${100 + n}`,
    customerRef: `PO-ALPHA-${n}`,
    kind: 'RUSH',
    status: 'OPEN',
    askedAt: at(11, 8 + (n % 10)),
    cells: [],
    wholeOrder: false,
    requestedDate: '2026-12-10',
    shipTo: null,
    reasonCode: null,
    reasonWords: null,
    note: 'Our shop opens on 12 December: we need the jackets before.',
    answer: null,
    answeredAt: null,
    withdrawnAt: null,
    cancelFee: null,
    impact: IMPACT,
    sampleKind: null,
    batchId: null,
    counter: null,
    version: 1,
    companyId: COMPANY,
    party: ALPHA,
    askedBy: 'Anna Esempio',
    answeredBy: null,
    answeredWith: 'production.brand.manage',
    answeredIn: 'PRODUCTION',
    acceptWords: words('We mark the order Urgent and look at its date again.', "Segniamo l'ordine come urgente e rivediamo la sua data."),
    waitingOn: 'US',
    standing: words('Waiting for our answer', 'In attesa della nostra risposta'),
    may: { accept: true, refuse: true, counter: true, counterWithPrice: true },
    batch: null,
    ...overrides,
  }
}

const RUSH = brandRequest(1)
const HOLD = brandRequest(2, {
  kind: 'HOLD',
  requestedDate: null,
  note: 'Our customer moved the opening: please stop until we tell you.',
  reasonWords: words('The shop opening moved', "L'apertura del negozio è stata spostata"),
  acceptWords: words('We pause the work on the order until you ask us to resume it.', "Mettiamo in pausa la lavorazione dell'ordine finché non ci chiedi di riprendere."),
  impact: { ...IMPACT, kind: 'HOLD', earliest: null },
})
const CANCEL = brandRequest(3, {
  kind: 'CANCEL',
  requestedDate: null,
  answeredWith: 'orders.manage',
  answeredIn: 'SALES',
  note: null,
  reasonWords: words('Ordered twice by mistake', 'Ordinato due volte per errore'),
  cells: [{ lineId: id(310), seq: 2, style: { code: 'JKT-DEMO-02', name: 'Giacca Demo' }, colourway: { code: 'NERO', name: 'Nero' }, size: null, before: 40, asked: 0, askedColourway: null }],
  cancelFee: { pct: '15', words: words('Fee 15% of the cancelled lines’ value', 'Costo del 15% sul valore delle righe annullate'), currency: 'EUR', totalFee: 36000 },
  acceptWords: words('We cancel the order, or close the lines asked short: nothing more of them is made or shipped.', "Annulliamo l'ordine, o chiudiamo le righe richieste: non ne produciamo né spediamo altro."),
  impact: { ...IMPACT, kind: 'CANCEL', priced: true, pricedWords: words('A price may apply: we tell the customer.', 'Può esserci un costo: lo diciamo al cliente.'), earliest: null, frozen: [{ field: 'QUANTITY', lineId: id(310), line: '2', size: 'M', state: 'PRICED', words: words('Line 2 · M: cut already — a price applies', 'Riga 2 · M: già tagliata, si applica un costo') }] },
})
const AGREED = brandRequest(4, {
  status: 'COUNTERED',
  counter: { approvalRequestId: id(704), at: at(11, 15), date: '2026-12-15', fee: null, note: 'We can make it by 15 December.', priced: false, offer: words('Our counter-offer · 15 Dec', 'La nostra controproposta · 15 dic'), state: 'AGREED', words: words('The customer said yes: accept to carry it out.', 'Il cliente ha detto sì: accetta per eseguirla.') },
  standing: words('The customer said yes to our counter-offer: accept to carry it out', 'Il cliente ha detto sì alla nostra controproposta: accetta per eseguirla'),
  may: { accept: true, refuse: false, counter: false, counterWithPrice: false },
})
/** A cancel batch of 6 orders (one customer, one kind): five wait, one was withdrawn meanwhile. */
const BATCH_ROWS: BrandRequest[] = [11, 12, 13, 14, 15, 16].map((n, index) =>
  brandRequest(n, {
    ...CANCEL,
    id: id(n),
    orderId: id(100 + n),
    orderNumber: `SO-DEMO-0${100 + n}`,
    customerRef: `PO-ALPHA-${n}`,
    askedAt: at(12, 7, index),
    batchId: BATCH,
    cells: [],
    wholeOrder: true,
    cancelFee: null,
    batch: { id: BATCH, count: 6, waiting: 5 },
    ...(index === 5 ? { status: 'WITHDRAWN' as const, waitingOn: null, withdrawnAt: at(12, 9), standing: words('Withdrawn', 'Ritirata'), may: { accept: false, refuse: false, counter: false, counterWithPrice: false } } : {}),
  }),
)

const REQUEST_ROWS = requestGroupsOf([RUSH, HOLD, ...BATCH_ROWS]).map((group) => ({ ...requestRow(group), href: group.requests.length > 1 ? null : `${PREFIX}/sales/orders/${group.requests[0]!.orderId}` }))
const inbox = (overrides: Partial<InboxViewModel> = {}): InboxViewModel =>
  depthModel({ can: { ...depthModel().can, requests: true }, rows: { items: [...DEPTH_ROWS.WAITING_ROWS, ...REQUEST_ROWS], problem: null }, counts: { waiting: 12, overdue: 1, mine: 2, decided: 6 }, ...overrides })

const impactRead = (request: BrandRequest, extra: Partial<RequestImpactRead> = {}): RequestImpactRead => ({
  asOf: NOW,
  request: { id: request.id, kind: request.kind, status: request.status, version: request.version },
  kept: request.impact,
  now: request.impact ?? IMPACT,
  workOrders: [{ id: id(201), number: 'WO-DEMO-0201', status: 'IN_PROGRESS', held: false, mixed: false }],
  workOrdersNotShown: 0,
  cancelFee: request.cancelFee,
  ...extra,
})
const recordOf = (request: BrandRequest): RequestRecord => ({ asOf: NOW, request, counterApproval: request.counter ? { id: request.counter.approvalRequestId, status: 'APPROVED', dueAt: at(14, 15), answeredAt: at(12, 9), typedName: 'Anna Esempio', answer: 'Yes, 15 December works for us.' } : null, batch: [] })
const hrefs = (requests: readonly BrandRequest[]) => Object.fromEntries(requests.map((request) => [request.orderId, `${PREFIX}/sales/orders/${request.orderId}`]))

type OneReview = Extract<RequestReviewModel, { as: 'request' }>
type BatchReview = Extract<RequestReviewModel, { as: 'batch' }>
const one = (request: BrandRequest, overrides: Partial<OneReview> = {}): OneReview => ({
  as: 'request',
  id: request.id,
  record: { status: 'ready', value: recordOf(request) },
  impact: { status: 'ready', value: impactRead(request) },
  words: '',
  dialog: null,
  problem: null,
  orderHrefs: hrefs([request]),
  today: TODAY,
  can: { lift: true },
  ...overrides,
})
const batch = (overrides: Partial<BatchReview> = {}): BatchReview => ({
  as: 'batch',
  id: BATCH,
  batch: { status: 'ready', value: BATCH_ROWS },
  words: 'We have taken note: nothing of these orders is made.',
  dialog: null,
  problem: null,
  orderHrefs: hrefs(BATCH_ROWS),
  today: TODAY,
  can: { lift: true },
  ...overrides,
})
const open = (id: string) => ({ view: 'waiting' as const, kind: null, q: '', changed: false, open: id })
const LINES = batchLinesOf(BATCH_ROWS, 'accept')

export const REQUEST_FIXTURES = { RUSH, HOLD, CANCEL, AGREED, BATCH, BATCH_ROWS, REQUEST_ROWS, LINES, TODAY }

export const REQUEST_CASES: readonly { id: string; label: string; model: InboxViewModel; note?: string }[] = [
  { id: 'f-pr-08-inbox', label: 'F-PR-08 · customer requests in one inbox: Urgent – asked, a pause, a batch of 6 cancels as one row', model: inbox(), note: '"Customer request" rows open their window here; the batch is ONE row "Cancel · 6 orders · Brand Alpha" (5 still wait); chips say what was already fixed, a price that may apply, the earliest date.' },
  { id: 'f-pr-08-filtered', label: 'F-PR-08 · the Overview tile’s door: ?kind=ORDER_CHANGE_REQUEST', model: inbox({ controls: { view: 'waiting', kind: 'ORDER_CHANGE_REQUEST', q: '', changed: false, open: null } }) },
  { id: 'f-pr-08-rush', label: 'F-PR-08 · "Urgent – asked": Accept as urgent / Accept and rush the floor', model: inbox({ controls: open(RUSH.id), requestReview: one(RUSH) }), note: 'Two accepts: as urgent it moves only among Brand Alpha’s own orders; rush the floor also puts its work orders first on every tablet. Suggest something else and Refuse beside them.' },
  { id: 'f-pr-08-rush-words', label: 'F-PR-08 · the words the customer reads, with their preview', model: inbox({ controls: open(RUSH.id), requestReview: one(RUSH, { words: 'We cannot make 10 December; 15 December is possible.' }) }) },
  { id: 'f-pr-08-cancel', label: 'F-PR-08 · a cancel (Sales answers it): what is fixed and its fee for a price reader', model: inbox({ controls: open(CANCEL.id), requestReview: one(CANCEL) }), note: 'Line 2 · the whole line 40 → 0; already cut: a price applies; the fee € 360.00 only with the price grain.' },
  { id: 'f-pr-08-agreed', label: 'F-PR-08 · the customer said yes to our counter-offer: Accept carries it out', model: inbox({ controls: open(AGREED.id), requestReview: one(AGREED) }), note: 'Refuse and Suggest something else are held with the reason; their words and the name they signed show.' },
  { id: 'f-pr-08-team', label: 'F-PR-08 · a reader whose team does not answer this kind (held with words)', model: inbox({ controls: open(CANCEL.id), requestReview: one({ ...CANCEL, may: { accept: false, refuse: false, counter: false, counterWithPrice: false } }) }), note: 'Sales answers changes, cancels and ship what is ready: every answer is held and says so.' },
  { id: 'f-pr-08-counter', label: 'F-PR-08 · Suggest something else: a date, a fee, our words', model: inbox({ controls: open(RUSH.id), requestReview: one(RUSH, { dialog: { kind: 'counter', busy: false, problem: null } }) }) },
  { id: 'f-pr-08-refused', label: 'F-PR-08 · an answer refused by the API, in our words', model: inbox({ controls: open(HOLD.id), requestReview: one(HOLD, { problem: 'customerRequest.refusal.NO_WORK' }) }) },
  { id: 'f-pr-08-batch', label: 'F-PR-08 · a batch: Cancel · 6 orders — Accept all, Refuse all, or each order alone', model: inbox({ controls: open(BATCH), requestReview: batch() }), note: 'Each order with its state and "Answer alone"; one withdrawn meanwhile. The same words go to every order.' },
  { id: 'f-pr-08-batch-accept', label: 'F-PR-08 · Accept all: read again, each checked, one left out', model: inbox({ controls: open(BATCH), requestReview: batch({ dialog: { kind: 'batch', answer: 'accept', rushFloor: false, lines: LINES, state: { phase: 'ready' } } }) }) },
  {
    id: 'f-pr-08-batch-done',
    label: 'F-PR-08 · Accept all: what became of each',
    model: inbox({
      controls: open(BATCH),
      requestReview: batch({ dialog: { kind: 'batch', answer: 'accept', rushFloor: false, lines: LINES, state: { phase: 'done', results: { [LINES[0]!.requestId]: { ok: true, words: words('Cancelled: nothing more is made or shipped.', 'Annullato: non si produce né si spedisce altro.'), code: null }, [LINES[1]!.requestId]: { ok: false, words: null, code: 'SHIPMENT_PREPARED' } } } } }),
    }),
  },
  { id: 'f-pr-08-notice-lift', label: 'F-PR-08 · after an accepted pause: "Lift the hold" in the notice (never a generic undo)', model: inbox({ notice: { key: 'notice.requestAccepted', tone: 'success', request: { kindLabel: words('Pause', 'Pausa'), record: { type: 'SalesOrder', id: HOLD.orderId, label: HOLD.orderNumber } }, lines: [words('Paused: WO-DEMO-0201.', 'In pausa: WO-DEMO-0201.')], followUp: { kind: 'lift', requestId: HOLD.id, workOrders: [{ id: id(201), number: 'WO-DEMO-0201' }] } } }) },
  { id: 'f-pr-08-notice-rush', label: 'F-PR-08 · after Accept and rush the floor: "Clear rush"', model: inbox({ notice: { key: 'notice.requestRushed', tone: 'success', request: { kindLabel: words('Urgent – asked', 'Urgente – richiesto'), record: { type: 'SalesOrder', id: RUSH.orderId, label: RUSH.orderNumber } }, followUp: { kind: 'clearRush', requestId: RUSH.id, workOrders: [{ id: id(201), number: 'WO-DEMO-0201' }] } } }) },
  { id: 'f-pr-08-lift', label: 'F-PR-08 · Lift the hold: why, before the customer’s pause is lifted', model: inbox({ followUpDialog: { followUp: { kind: 'lift', requestId: HOLD.id, workOrders: [{ id: id(201), number: 'WO-DEMO-0201' }] }, busy: false, problem: null } }) },
  { id: 'f-pr-08-not-found', label: 'F-PR-08 · another customer’s request (PW-H01b): "not there any more", naming nobody', model: inbox({ controls: open(id(999)), requestReview: { ...one(RUSH), id: id(999), record: { status: 'not_found' }, impact: { status: 'not_found' } } }) },
  { id: 'f-pr-08-loading', label: 'F-PR-08 · the window reading the request', model: inbox({ controls: open(RUSH.id), requestReview: { ...one(RUSH), record: { status: 'loading' }, impact: { status: 'loading' } } }) },
]
