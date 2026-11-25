import { failureWords } from '@nexus/factory-domain/payments/online/rules'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import type { OrderRecord } from '../api'
import { bandProductionOf, orderBandOf, type OrderBandFacts } from '../band'
import { problemChipOf } from '../../production/problem/model' // pp-w2: the design's problem strip
import {
  approvalPage,
  at,
  dayAt,
  documentsRead,
  mtmRecord,
  NO_WITHDRAWAL_WORDS,
  orderRecord,
  orderWords,
  PREFIX,
  productionReadOf,
  progressRead,
  requestsOf,
  rulesOf,
  shellOf,
  shipmentsRead,
  threadOf,
  TODAY,
  withoutPrices,
  withThreadButton,
  words,
} from '../design-data'
import { cancelHeld, changeHeld, EMPTY_CANCEL, EMPTY_CHANGE, shipToLines, type CancelDraft, type ChangeDraft, type RecordTab } from '../model'
// B-TH-275: the customer's own reference in the pop-ups; what the order was made from.
import { orderRefOf } from '../model'
import { CUSTOMER_STATUS_WORDS } from '@nexus/factory-domain/sales/portal-orders/status'
import { CustomerCase, type CustomerCaseBuilder } from '../view/CustomerCase'
import type { OrderDialog, OrderRecordViewModel } from '../view/OrderRecordView'
// ---- F-PR-13: the Ask dialog's cases (made-up limits: urgency on; pause, resume, ship what is ready, another sample open)
import type { AskImpact, AskVerdict, ChangeRules } from '../api'
import { askChoicesOf, askHeld, EMPTY_ASK, impactViewOf, type AskDraft, type AskKind } from '../ask-model'
import type { AskDialogModel } from '../view/AskDialog'
// ---- end F-PR-13
// ---- F-CP-148 (the money wall, Owner O4): the customer's own price check on its order, seen as each of its people ----
import type { PortalPriceCheck } from '../price-check'
import type { PriceCheckModel } from '../view/PriceCheck'
// ---- end F-CP-148
// ---- F-CP-158 (follow-up 12): the price check card's own states and its window; the thread's "Ask the factory designer" box ----
import { priceDraftOf, priceDraftProblems } from '../price-check'
import type { ThreadViewModel } from '../../../shell/view/ThreadView'
// ---- end F-CP-158

/**
 * SCR-184 › one order (design portal.customer.orders rec "Order"; B-W2b-191; B-TH-275, picture 22), MADE-UP data only: the four
 * tabs (pp-w2: Overview — where the order is with its strips, progress by line, dates, requests & changes, quality and photos,
 * what you pay and the facts; Lines with each size run and the totals; Shipments with parcels, steps, papers and what is
 * still to ship; Files by version) beside the order's conversation docked at 1440 (the portal
 * record frame; narrower: "Messages (2 new)" and its full-width view), "Please re-confirm", every pop-up (Ask for a change: edit, held cells, review, a refusal, discard; Ask
 * to cancel; Re-confirm version 2: choose, decline, signed, held; Pay the deposit on the FAKE provider: idle, its fields,
 * waiting, failed, paid; a document's preview), a role without prices, an office preview, no connection, loading, a failed
 * read and a missing order.
 */

const FACTS = { mayAsk: true, preview: false, offline: false, busy: false }

function recordModel(record: OrderRecord, over: Partial<OrderRecordViewModel> = {}): OrderRecordViewModel {
  return {
    state: 'ready',
    record,
    // B-TH-275: docked beside the body (the 1440 picture); the narrow cases say `stacked`.
    frame: { mode: 'docked' },
    madeFrom: null,
    tab: 'overview', // pp-w1 (w1.3): the first tab
    prefix: PREFIX,
    offlineSince: null,
    notice: null,
    revision: { state: 'ready', page: null },
    reconfirmHeld: null,
    progress: { state: 'ready', read: progressRead() },
    requests: { state: 'ready', items: requestsOf() },
    withdrawHeld: null,
    changeHeld: null,
    pay: {},
    shipments: { state: 'ready', read: shipmentsRead() },
    documents: { state: 'ready', read: documentsRead() },
    fileHeld: null,
    openLine: null,
    copied: null,
    dialog: null,
    ...over,
  }
}

interface CaseInput {
  record?: OrderRecord
  tab?: RecordTab
  model?: (locale: Locale) => Partial<OrderRecordViewModel>
  facts?: (locale: Locale) => Partial<OrderBandFacts>
  preview?: boolean
  /** F-CP-158: the docked conversation's own state over the made-up one (the "Ask the factory designer" box). */
  thread?: (locale: Locale) => Partial<ThreadViewModel>
}

function recordCase(input: CaseInput = {}): CustomerCaseBuilder {
  return (locale) => {
    const record = input.record ?? orderRecord()
    const tab = input.tab ?? 'overview'
    const model = recordModel(record, { tab, ...(input.model?.(locale) ?? {}) })
    const facts: OrderBandFacts = {
      ask: { held: null }, // pp-w1 (w1.2): the ONE "Ask for a change…"
      cancelHeld: null,
      reconfirm: model.revision.page?.content.revisedOrder && record.order.reconfirmNeeded ? { revision: model.revision.page.content.revisedOrder.revision, held: model.reconfirmHeld } : null,
      confirmation: true,
      pay: Object.values(model.pay)[0] ?? null,
      madeFrom: model.madeFrom ?? null, // pp-w1 (w1.2): "Made from your request #7" in the band
      production: bandProductionOf(model.production?.read ?? null, model.production?.state === 'ready'), // pp-w2: the band's chips
      ...(input.facts?.(locale) ?? {}),
    }
    return {
      shell: shellOf(locale, withThreadButton(orderBandOf({ words: orderWords(locale), record, prefix: PREFIX, facts }), model.frame), { path: `/orders/${record.order.id}`, preview: input.preview ?? false }),
      // B-TH-275: the order's ONE conversation docks beside every tab.
      body: { kind: 'record', model, thread: { ...threadOf(locale), ...(input.thread?.(locale) ?? {}) } /* F-CP-158 */ },
    }
  }
}

/** B-TH-275: a design order's own reference (#11): the pop-ups name the customer's number, never the office's SO- series. */
const own = (record: OrderRecord): string => orderRefOf(record.order, () => '—')

const RECORD = orderRecord()
const SHIP_TO = shipToLines(RECORD.order.shipTo)

function changeDialog(draft: Partial<ChangeDraft> = {}, over: { problem?: string | null; discard?: boolean; rules?: ReturnType<typeof rulesOf> } = {}): OrderDialog {
  const rules = over.rules ?? rulesOf()
  const full: ChangeDraft = { ...EMPTY_CHANGE, ...draft }
  return { kind: 'change', model: { state: 'ready', number: own(RECORD), rules, draft: full, held: changeHeld(rules, full, FACTS), busy: false, problem: over.problem ?? null, discard: over.discard ?? false, shipTo: SHIP_TO, today: TODAY } }
}
const EDITED: Partial<ChangeDraft> = { cells: { [rulesOf().lines[1]!.lineId]: { '50': 8, '52': 5 } }, requestedDate: dayAt(10), note: 'Due 50 in più per il negozio di Torino.' }

function cancelDialog(draft: Partial<CancelDraft> = {}, rules = rulesOf(), number = own(RECORD)): OrderDialog {
  const full: CancelDraft = { ...EMPTY_CANCEL, ...draft }
  return { kind: 'cancel', model: { state: 'ready', number, rules, draft: full, held: cancelHeld(rules, full, FACTS), busy: false, problem: null } }
}

// ---- F-PR-13 ----
const say = (en: string, it: string) => ({ en, it })
const FREE: AskVerdict = { possible: true, code: 'FREE', day: null, words: say('You can ask: we decide and answer you', 'Potete chiederlo: decidiamo noi e vi rispondiamo') }
function askRules(): ChangeRules {
  const base = rulesOf()
  return {
    ...base,
    lines: base.lines.map((line, index) => ({
      ...line,
      split: FREE,
      samples: [
        { sampleKind: 'PRE_PRODUCTION' as const, verdict: index === 0 ? { possible: false, code: 'LEATHER_CUT' as const, day: dayAt(-4), words: say('Not possible: the leather was cut', 'Non possibile: la pelle è stata tagliata') } : FREE },
        { sampleKind: 'SIZE_SET' as const, verdict: FREE },
        { sampleKind: 'TOP_OF_PRODUCTION' as const, verdict: FREE },
      ],
    })),
    asks: [
      { kind: 'RUSH', words: say('Urgent – asked', 'Urgente – richiesto'), open: true, verdict: FREE, waitingRequestId: null },
      { kind: 'HOLD', words: say('Pause', 'Pausa'), open: true, verdict: FREE, waitingRequestId: null },
      { kind: 'RESUME', words: say('Resume', 'Ripresa'), open: true, verdict: { possible: false, code: 'NOT_PAUSED', day: null, words: say('The order is not paused', "L'ordine non è in pausa") }, waitingRequestId: null },
      { kind: 'SPLIT_SHIPMENT', words: say('Ship what is ready', 'Spedire ciò che è pronto'), open: true, verdict: FREE, waitingRequestId: null },
      { kind: 'SAMPLE_ROUND', words: say('Another sample', 'Un altro campione'), open: true, verdict: FREE, waitingRequestId: null },
    ],
    frozen: { deliveryDate: { state: 'OPEN', words: say('Still open', 'Ancora modificabile') }, shipTo: { state: 'OPEN', words: say('Still open', 'Ancora modificabile') } },
  }
}
const RUSH_IMPACT: AskImpact = { kind: 'RUSH', frozen: [], blocked: false, priced: false, earliest: { date: dayAt(12), partial: false, meetsWanted: true }, notes: [say('We look at the date again', 'Rivediamo la data')] }
function askDialog(over: { step?: AskDialogModel['step']; kind?: AskKind | null; draft?: Partial<AskDraft>; impact?: AskImpact | null; problem?: string | null } = {}): OrderDialog {
  const rules = askRules()
  const choices = askChoicesOf(rules, requestsOf())
  const kind = over.kind ?? null
  const impact = over.impact ? { state: 'ready' as const, view: impactViewOf(kind ?? 'RUSH', over.impact, { seesPrices: true, fee: null, money: String, sizesAsked: false }) } : null
  return {
    kind: 'ask',
    model: { state: 'ready', number: own(RECORD), rules, step: over.step ?? 'what', kind, choices, draft: { ...EMPTY_ASK, ...over.draft }, held: askHeld(kind, rules, choices, FACTS), impact, busy: false, problem: over.problem ?? null, waitingHref: `${PREFIX}/waiting`, withdrawHeld: null, withdrawing: null, today: TODAY },
  }
}
const CHANGE_IMPACT: AskImpact = {
  kind: 'CHANGE',
  frozen: [{ field: 'SIZE_QUANTITY', lineId: rulesOf().lines[1]!.lineId, line: '2', size: '52', state: 'CHANGE_REQUEST', words: say('Line 2, size 52: Cutting started — size frozen: a change is a priced change request the customer accepts', 'Riga 2, taglia 52: Taglio iniziato — taglia bloccata: una modifica è una richiesta di modifica con prezzo che il cliente accetta') }],
  blocked: false,
  priced: true,
  earliest: { date: dayAt(14), partial: false, meetsWanted: false },
  notes: [],
}
// ---- end F-PR-13

const REVISED = orderRecord({ reconfirmNeeded: true })
const reconfirm = (over: Partial<Extract<OrderDialog, { kind: 'reconfirm' }>['model']> = {}): OrderDialog => ({
  kind: 'reconfirm',
  model: { state: 'ready', page: approvalPage(), number: own(REVISED), decision: null, comment: '', held: null, problem: null, busy: false, done: null, ...over },
})

const MTM = mtmRecord()
const pay = (locale: Locale, over: Partial<Extract<OrderDialog, { kind: 'pay' }>['model']> = {}): OrderDialog => ({
  kind: 'pay',
  model: { amount: orderWords(locale).money(MTM.deposits[0]!.amount, 'EUR'), number: own(MTM), methods: ['CARD', 'SEPA_DEBIT'], method: 'CARD', state: 'idle', fake: true, held: null, failure: null, problem: null, ...over },
})
const NO_REQUESTS = { state: 'ready', items: [] } as const

// ---- F-CP-148 (Owner O4): Brand Alpha's own price check of this order (made up): line 1 equal (its own price), line 2 lower, from its PO.
const priceRow = (n: number, over: Partial<NonNullable<PortalPriceCheck['lines'][number]['row']>> = {}): NonNullable<PortalPriceCheck['lines'][number]['row']> => ({ id: `0190f0e2-9393-7000-8000-00000000000${n}`, unitPrice: '185.00', netAmount: null, currency: 'EUR', source: 'PORTAL', note: null, enteredAt: at(-30), version: 1, ...over })
export const ORDER_PRICE_CHECK: PortalPriceCheck = {
  orderId: RECORD.order.id,
  currency: 'EUR',
  lines: [
    { lineId: RECORD.lines[0]!.id, seq: 1, label: 'City jacket · Black', pieces: 30, ourUnitPrice: '185.00', ourAmount: 555_000, brandAmount: 555_000, priceMatch: 'EQUAL', priceDiff: 0, row: priceRow(1) },
    { lineId: RECORD.lines[1]!.id, seq: 2, label: 'Trousers · Sand', pieces: 16, ourUnitPrice: '123.13', ourAmount: 197_000, brandAmount: 192_000, priceMatch: 'NOT_EQUAL', priceDiff: 5_000, row: priceRow(2, { unitPrice: '120.00', source: 'CUSTOMER_PO', version: 2 }) },
  ],
  total: { ourPrice: 752_000, brandPrice: 747_000, priceMatch: 'NOT_EQUAL', priceDiff: 5_000, priceNotEqualLines: 1, priceMissingLines: 0, priceOtherCurrency: 0, row: null },
  mayWrite: { allowed: true, why: null },
}
// ---- F-CP-158 (follow-up 12): the card's other checks, its window, the designer's made-up name ----
const agreeing = (): PortalPriceCheck => ({ ...ORDER_PRICE_CHECK, lines: ORDER_PRICE_CHECK.lines.map((line) => ({ ...line, brandAmount: line.ourAmount, priceMatch: 'EQUAL' as const, priceDiff: 0, row: line.row ? { ...line.row, unitPrice: line.ourUnitPrice } : null })), total: { ...ORDER_PRICE_CHECK.total, brandPrice: ORDER_PRICE_CHECK.total.ourPrice, priceMatch: 'EQUAL', priceDiff: 0, priceNotEqualLines: 0 } })
const notGiven = (): PortalPriceCheck => ({ ...ORDER_PRICE_CHECK, lines: ORDER_PRICE_CHECK.lines.map((line) => ({ ...line, brandAmount: null, priceMatch: 'NO_BRAND_PRICE' as const, priceDiff: null, row: null })), total: { ...ORDER_PRICE_CHECK.total, brandPrice: null, priceMatch: 'NO_BRAND_PRICE', priceDiff: null, priceNotEqualLines: 0, priceMissingLines: ORDER_PRICE_CHECK.lines.length } })
function priceDialogOf(locale: Locale): NonNullable<PriceCheckModel['dialog']> {
  const draft = priceDraftOf(ORDER_PRICE_CHECK, locale)
  return { draft, problems: priceDraftProblems(draft), showProblems: false, busy: false, failed: null, stale: false }
}
const DESIGNER_NAME = 'Giulia Esempio'
// ---- end F-CP-158
/** The Lines tab's price check card as the page holds it (the Buyer and the Admin write; Finance reads). */
export const priceCheckOf = (over: Partial<PriceCheckModel> = {}): PriceCheckModel => ({ state: 'ready', check: ORDER_PRICE_CHECK, access: 'write', held: null, dialog: null, notice: null, ...over })
// ---- end F-CP-148
const PAY_OPEN = { [MTM.deposits[0]!.id]: { held: null } }

// ---- pp-w2 (w2.4; the picture's 8 order cases × the roles; 10-design § 5.6): made up, Brand Alpha's own order ----
const PRODUCTION = (over: Parameters<typeof productionReadOf>[0] = {}) => ({ state: 'ready' as const, read: productionReadOf(over) })
const NO_PRODUCTION = { state: 'hidden' as const, read: null }
const say2 = (en: string, it: string) => ({ en, it })
const LINE_DONE = (n: number) => progressRead().lines.map((line) => ({ ...line, cut: line.ordered, sewn: line.ordered, inspected: line.ordered, packed: n === 2 ? line.ordered : 0, sizes: line.sizes.map((size) => ({ ...size, cut: size.ordered, sewn: size.ordered, inspected: size.ordered, packed: n === 2 ? size.ordered : 0 })) }))
const PIECES_DONE = (n: number) => ({ ...productionReadOf().progress!, lines: LINE_DONE(n) })
const MADE = { kind: 'request' as const, href: `${PREFIX}/orders/requests/0190f0e2-1910-7000-8000-000000000901`, label: '#7' }
const IN_PRODUCTION = orderRecord({ status: 'IN_PRODUCTION', words: say2('In production', 'In produzione') })
const OVERVIEW_CASES = [
  { id: 'ov-prod', label: 'Overview · in production with progress (Buyer)', model: recordCase({ record: IN_PRODUCTION, model: (locale) => ({ production: PRODUCTION(), madeFrom: MADE, problem: { chip: problemChipOf(productionReadOf().problem, words(locale, 'portal-production'), orderWords(locale).day), report: { held: null } } }) }), note: 'The band: Late, Urgent, “Made from your request #7 ›”. Strips: we wait for you, a problem you reported. Progress by line, Next dates with the plan, gates and approvals.' },
  { id: 'ov-prod-viewer', label: 'Overview · in production (Viewer: production, no prices)', model: recordCase({ record: withoutPrices(IN_PRODUCTION), model: (locale) => ({ production: PRODUCTION(), withdrawHeld: words(locale)('held.mayAsk') }), facts: (locale) => ({ ask: { held: words(locale)('held.mayAsk') } }) }), note: 'Production as today; no What you pay; Withdraw and Ask held with the words.' },
  { id: 'ov-prod-finance', label: 'Overview · in production (Finance: prices, no production)', model: recordCase({ record: IN_PRODUCTION, model: () => ({ production: NO_PRODUCTION, progress: { state: 'ready', read: progressRead() } }) }), note: 'L7: no stage, strips, gates or Quality; Progress by line from its old progress read, the same grid; What you pay.' },
  { id: 'ov-prod-designer', label: 'Overview · in production (Designer: no prices, no production)', model: recordCase({ record: withoutPrices(IN_PRODUCTION), model: () => ({ production: NO_PRODUCTION, progress: { state: 'ready', read: progressRead() } }) }), note: 'L7: as Finance without What you pay.' },
  { id: 'ov-reconfirm', label: 'Overview · waiting for you to re-confirm (Buyer)', model: recordCase({ record: orderRecord({ status: 'IN_PRODUCTION', words: say2('In production', 'In produzione'), reconfirmNeeded: true }), model: () => ({ production: PRODUCTION({ waiting: { code: 'YOU', words: say2('Waiting on you', 'Tocca a voi'), since: dayAt(-1) } }), revision: { state: 'ready', page: approvalPage() } }) }), note: 'One strip says it (never a second “we wait for you”); Review and confirm.' },
  { id: 'ov-hold', label: 'Overview · on hold (Buyer)', model: recordCase({ record: IN_PRODUCTION, model: () => ({ production: PRODUCTION({ waiting: { code: 'US', words: say2('Waiting on us', 'Tocca a noi'), since: null }, problem: null, holds: [{ kind: 'PRODUCTION', since: dayAt(-4), words: say2('Material on its way', 'Materiale in arrivo') }, { kind: 'BRAND', since: dayAt(-1), words: say2('Paused at your request', 'In pausa su vostra richiesta') }] }) }) }), note: 'The hold strip in our curated words, the rest counted, Ask a question.' },
  { id: 'ov-shipped', label: 'Overview · shipped in part (Buyer)', model: recordCase({ record: orderRecord({ status: 'PARTLY_SHIPPED', words: say2('Partly shipped', 'Spedito in parte') }), model: () => ({ production: PRODUCTION({ waiting: { code: 'US', words: say2('Waiting on us', 'Tocca a noi'), since: null }, problem: null, progress: PIECES_DONE(1) }) }) }) },
  { id: 'ov-delivered', label: 'Overview · delivered (Buyer)', model: recordCase({ record: orderRecord({ status: 'DELIVERED', words: say2('Delivered', 'Consegnato') }), model: () => ({ production: PRODUCTION({ inProduction: false, waiting: { code: 'US', words: say2('Waiting on us', 'Tocca a noi'), since: null }, problem: null, progress: PIECES_DONE(2), gates: null }) }) }), note: 'No Ask; all steps done; no strips.' },
  { id: 'ov-cancelled', label: 'Overview · cancelled (Buyer)', model: recordCase({ record: orderRecord({ status: 'CANCELLED', words: say2('Cancelled', 'Annullato'), cancelledOn: dayAt(-3), promiseMoved: false }, { promiseHistory: [] }), model: () => ({ production: NO_PRODUCTION, requests: { state: 'ready', items: [] } }) }), note: 'Headline “Cancelled on …”; no Next dates, no Progress; What you pay: the deposit state and still to pay 0.' },
  { id: 'ov-noprice', label: 'Overview · no price right (a Viewer)', model: recordCase({ record: withoutPrices(IN_PRODUCTION), model: () => ({ production: PRODUCTION() }) }) },
  { id: 'ov-early', label: 'Overview · early: not in production yet (Buyer)', model: recordCase({ record: orderRecord({ status: 'CONFIRMED', words: say2('Confirmed', 'Confermato'), promiseMoved: false }, { promiseHistory: [] }), model: () => ({ production: NO_PRODUCTION, progress: { state: 'hidden', read: null }, notice: { tone: 'success', key: 'notice.changeSent' } }) }), note: '“Your order is confirmed.”; the notice in the shared notice slot.' },
  { id: 'ov-fee-line', label: 'Lines · an order with a charge line (FEE): it loads, the charge is not a line of Lines', model: recordCase({ record: { ...RECORD, lines: [...RECORD.lines, { ...RECORD.lines[0]!, id: '0190f0e2-1910-7000-8000-000000000299', seq: 3, kind: 'FEE', style: null, colourway: null, description: 'Sample making charge', measurement: null, baseSize: null, quantity: 1, sizes: [], pieces: { ordered: 1, shipped: 0, open: 1 } }] }, tab: 'lines' }) },
]
// ---- end pp-w2

export const designScreen = defineDesignScreen<CustomerCaseBuilder>({
  screen: 'SCR-184-record',
  title: 'Customer order record (portal.customer.orders rec Order)',
  view: CustomerCase,
  cases: [
    // ── Overview (pp-w2) ──
    { id: 'overview', label: 'Overview', model: recordCase(), note: 'pp-w2: Where your order is (the six steps, the promise once with “Date moved 2 times”), Progress by line (the shared grid), Next dates | Requests & changes, What you pay (a price holder), Order facts — on the shared overview kit.' },
    { id: 'overview-reconfirm', label: 'Overview: a revised version waits (“Review and confirm” on the lead card)', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'ready', page: approvalPage() } }) }), note: 'The strip names the version and the day; What changed, line by line; the Overview tab says “to confirm”; the band’s ⋯ opens it too.' },
    { id: 'overview-reconfirm-no-access', label: 'Overview: re-confirm, a colleague who cannot read approvals', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'noAccess', page: null } }) }) },
    { id: 'overview-deposit', label: 'Overview: a made-to-measure order waiting for its deposit (the ONE Pay door)', model: recordCase({ record: MTM, model: () => ({ progress: { state: 'hidden', read: null }, requests: { state: 'ready', items: [] }, pay: PAY_OPEN }) }), note: '“Deposit to pay by …” with Pay the deposit; What you pay says the facts only. No right of withdrawal (made to measure).' },
    { id: 'overview-no-prices', label: 'Overview: a colleague without prices', model: recordCase({ record: withoutPrices(RECORD), model: () => ({ requests: { state: 'noAccess', items: [] } }) }), note: 'No What you pay, no amounts.' },
    { id: 'overview-cancelled-early', label: 'Overview: a cancelled order (no production)', model: recordCase({ record: orderRecord({ status: 'CANCELLED', words: { it: 'Annullato', en: 'Cancelled' }, cancelledOn: dayAt(-3), promiseMoved: false }, { promiseHistory: [], productionLevel: 'STATUS' }), model: () => ({ progress: { state: 'hidden', read: null }, requests: { state: 'ready', items: [] } }) }) },
    { id: 'overview-sent', label: 'Overview: a change request just sent (the notice)', model: recordCase({ model: () => ({ notice: { tone: 'success', key: 'notice.changeSent' } }) }) },
    { id: 'overview-parts-loading', label: 'Overview: parts still loading', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'loading', page: null }, progress: { state: 'loading', read: null }, requests: { state: 'loading', items: [] } }) }) },
    { id: 'overview-parts-error', label: 'Overview: parts that could not be read', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'error', page: null }, progress: { state: 'error', read: null }, requests: { state: 'error', items: [] } }) }), note: 'Each says so with Try again; never drawn as empty.' },
    // ---- pp-w2 (w2.4): the picture's eight order cases, each as its readers see it (Buyer · Viewer · Finance · Designer) ----
    ...OVERVIEW_CASES,
    // ── Lines ──
    { id: 'lines', label: 'Lines', model: recordCase({ tab: 'lines' }), note: 'Each line with pieces ordered / shipped / open, unit price and line amount, the line’s own date; the size run of each line below; the totals with the deposit paid and what is left to pay on the invoice.' },
    { id: 'lines-sizes', label: 'A line’s sizes open', model: recordCase({ tab: 'lines', model: () => ({ openLine: RECORD.lines[0]!.id }) }) },
    { id: 'lines-mtm', label: 'A made-to-measure line', model: recordCase({ record: MTM, tab: 'lines', model: () => ({ requests: NO_REQUESTS }) }), note: 'The rider and the measurement revision (“Marco B. · rev. 3”).' },
    { id: 'lines-no-prices', label: 'Lines without prices', model: recordCase({ record: withoutPrices(RECORD), tab: 'lines' }) },
    // ---- F-CP-148 (the money wall, Owner O4): the Lines tab seen as each of Brand Alpha's people — its Buyer (and Admin) gives its own
    // price and reads the check; its Finance reads them; its Designer, Production and Viewer read no price at all (lines-no-prices).
    { id: 'cp-148-lines-buyer', label: 'F-CP-148 · Seen as Brand Alpha Buyer · Lines: Your price · Your amount · Check · Difference beside ours; Price check "differ on 1 line"; Your prices…', model: recordCase({ tab: 'lines', model: () => ({ priceCheck: priceCheckOf() }) }), note: 'Never cost or margin; a factory row reads "From your PO, typed by the factory" — never the office note or a name.' },
    { id: 'cp-148-lines-finance', label: 'F-CP-148 · Seen as Brand Alpha Finance · reads its prices and the check; Your prices… held in words (a colleague who orders gives them)', model: recordCase({ tab: 'lines', model: (locale) => ({ priceCheck: priceCheckOf({ access: 'read', held: words(locale)('priceCheck.readsOnly'), check: { ...ORDER_PRICE_CHECK, mayWrite: { allowed: false, why: null } } }) }) }) },
    { id: 'cp-148-lines-designer', label: 'F-CP-148 · Seen as Brand Alpha Designer / Production / Viewer · no price, no check, no amount: "Prices are not part of your access."', model: recordCase({ record: withoutPrices(RECORD), tab: 'lines', model: () => ({ priceCheck: null }) }) },
    // ---- end F-CP-148
    // ---- F-CP-158 (follow-up 12; customer page plan C3, D2; review B2, C3): the Price check card's states and "Your prices…" ----
    { id: 'cp158-price-agree', label: 'F-CP-158 · Price check: "Our prices agree" — every line and the total', model: recordCase({ tab: 'lines', model: () => ({ priceCheck: priceCheckOf({ check: agreeing() }) }) }) },
    { id: 'cp158-price-none', label: 'F-CP-158 · Price check: "You have not given your price yet" — never Equal', model: recordCase({ tab: 'lines', model: () => ({ priceCheck: priceCheckOf({ check: notGiven() }) }) }) },
    { id: 'cp158-price-window', label: 'F-CP-158 · Your prices…: ours beside yours per line, one note, one Save at the versions read', model: recordCase({ tab: 'lines', model: (locale) => ({ priceCheck: priceCheckOf({ dialog: priceDialogOf(locale) }) }) }), note: 'Typing over a factory price replaces it; emptying one of yours takes it away; a factory row is never only removed.' },
    { id: 'cp158-price-window-stale', label: 'F-CP-158 · Your prices…: changed meanwhile (409) — the prices as they are now', model: recordCase({ tab: 'lines', model: (locale) => ({ priceCheck: priceCheckOf({ dialog: { ...priceDialogOf(locale), stale: true } }) }) }) },
    { id: 'cp158-price-saved', label: 'F-CP-158 · Saved: one quiet line, the card read again', model: recordCase({ tab: 'lines', model: () => ({ priceCheck: priceCheckOf({ notice: 'priceCheck.saved' }) }) }) },
    { id: 'cp158-price-closed', label: 'F-CP-158 · A closed order keeps its prices: Your prices… held in words', model: recordCase({ tab: 'lines', model: (locale) => ({ priceCheck: priceCheckOf({ held: words(locale)('priceCheck.closed'), check: { ...ORDER_PRICE_CHECK, mayWrite: { allowed: false, why: null } } }) }) }) },
    { id: 'cp158-price-loading', label: 'F-CP-158 · Price check reading', model: recordCase({ tab: 'lines', model: () => ({ priceCheck: priceCheckOf({ state: 'loading', check: null }) }) }) },
    { id: 'cp158-price-error', label: 'F-CP-158 · Price check could not be read (Try again; the lines stay)', model: recordCase({ tab: 'lines', model: () => ({ priceCheck: priceCheckOf({ state: 'error', check: null }) }) }) },
    // The thread's "Ask <name>, factory designer" (F-CP-156): the one name the customer may ask, never who read it.
    { id: 'cp158-ask-designer', label: 'F-CP-158 · The conversation: "Ask Giulia Esempio, factory designer" under the box (not ticked)', model: recordCase({ thread: () => ({ designer: { name: DESIGNER_NAME, ask: false, chip: false, held: null } }) }) },
    { id: 'cp158-ask-designer-chip', label: 'F-CP-158 · An "@" typed: ONE chip "Giulia Esempio · factory designer" puts the name in and ticks the box', model: recordCase({ thread: (locale) => ({ composer: { ...threadOf(locale).composer!, value: locale === 'it' ? 'Può controllare il logo @' : 'Could you check the logo @' }, designer: { name: DESIGNER_NAME, ask: false, chip: true, held: null } }) }) },
    { id: 'cp158-ask-designer-ticked', label: 'F-CP-158 · The box ticked: the message goes to the factory designer at once, the team reads it as always', model: recordCase({ thread: (locale) => ({ composer: { ...threadOf(locale).composer!, value: locale === 'it' ? '@Giulia Esempio può controllare il giallo del logo?' : '@Giulia Esempio could you check the yellow of the logo?' }, designer: { name: DESIGNER_NAME, ask: true, chip: false, held: null } }) }) },
    // F-CP-156 (cp-fx14, walk L3): held, not disabled — the box stays focusable with its label readable and the held words beside it.
    { id: 'cp158-ask-designer-held', label: 'F-CP-158 · The designer cannot be asked here: the box held (focusable, never greyed), the portal’s words beside it, the text kept', model: recordCase({ thread: (locale) => ({ designer: { name: DESIGNER_NAME, ask: false, chip: false, held: words(locale, 'portal')('thread.designer.notHere') } }) }), note: 'Tab reaches the box after Send: the design system’s conversation keeps its composer whole (no place before Send without a packages/ui change). A tick on the held box changes nothing; a screen reader hears the words.' },
    // ---- end F-CP-158
    // ── Shipments & tracking ──
    { id: 'shipments', label: 'Shipments & tracking', model: recordCase({ tab: 'shipments' }), note: 'DDT, carrier, parcels with their tracking numbers (Copy) and the carrier’s site, the four steps, ETA, what it carries, the events, the papers; still to ship with the expected day.' },
    { id: 'shipments-copied', label: 'A tracking number copied', model: recordCase({ tab: 'shipments', model: () => ({ copied: 'DEMO00012345' }) }) },
    // B-W2b-170: Copy tracking link (the branded tracking page, to pass on), copied.
    { id: 'shipments-link-copied', label: 'The shipment\'s tracking link copied (B-W2b-170)', model: recordCase({ tab: 'shipments', model: () => ({ copied: `link:${shipmentsRead().shipments[0]!.id}` }) }) },
    { id: 'shipments-none', label: 'Nothing shipped yet', model: recordCase({ tab: 'shipments', model: () => ({ shipments: { state: 'ready', read: shipmentsRead({ shipments: [], firstExpected: dayAt(9), stillToShip: [] }) } }) }), note: '“Nothing shipped yet. Expected first shipment: …”' },
    { id: 'shipments-error', label: 'Shipments could not be read', model: recordCase({ tab: 'shipments', model: () => ({ shipments: { state: 'error', read: null } }) }) },
    // ── Files ──
    { id: 'files', label: 'Files', model: recordCase({ tab: 'files' }), note: 'By version with the fingerprint; the earlier confirmation names the version that replaced it; NEW; preview and download (logged).' },
    { id: 'files-empty', label: 'Files: no documents yet', model: recordCase({ tab: 'files', model: () => ({ documents: { state: 'ready', read: documentsRead({ items: [], count: 0 }) } }) }) },
    { id: 'files-no-access', label: 'Files: documents not in the role', model: recordCase({ tab: 'files', model: () => ({ documents: { state: 'noAccess', read: null } }) }) },
    { id: 'files-error', label: 'Files: documents could not be read', model: recordCase({ tab: 'files', model: () => ({ documents: { state: 'error', read: null } }) }) },
    { id: 'preview', label: 'A document’s preview opening', model: recordCase({ tab: 'files', model: () => ({ dialog: { kind: 'preview', model: { title: 'DDT-2026-0144', state: 'loading', bytes: null } } }) }) },
    { id: 'preview-error', label: 'A document that could not be opened', model: recordCase({ tab: 'files', model: () => ({ dialog: { kind: 'preview', model: { title: 'DDT-2026-0144', state: 'error', bytes: null } } }) }) },
    // ── B-TH-275: the conversation docked (no Messages tab), the state line, "Made from your request" ──
    {
      id: 'th-275-narrow',
      label: 'Under 1280 px: “Messages (2 new)”',
      model: recordCase({ model: () => ({ frame: { mode: 'stacked', newCount: 2 } }) }),
      note: 'Open at 1024 or the phone: the body leads; the button opens the conversation full width (Back returns to the same tab and scroll). From 1280 px it docks at ~40 %.',
    },
    { id: 'th-275-narrow-open', label: 'Under 1280 px: the conversation open', model: recordCase({ model: () => ({ frame: { mode: 'stacked', viewOpen: true } }) }), note: '“Ask a question” in the band’s ⋯ opens this and focuses the box (no pop-up).' },
    {
      id: 'th-275-confirmed',
      label: 'A confirmed order: “Your order is confirmed”, made from your request',
      model: recordCase({
        record: orderRecord({ status: 'CONFIRMED', words: CUSTOMER_STATUS_WORDS.CONFIRMED, promiseMoved: false }, { promiseHistory: [] }),
        model: () => ({ madeFrom: { kind: 'request', href: `${PREFIX}/orders/requests/0190f0e2-1910-7000-8000-000000000901`, label: '#7' } }),
      }),
      note: 'The sentence only for a CONFIRMED order (L2-G06); the request named by the customer’s own number.',
    },
    {
      id: 'th-275-waits',
      label: 'An order waiting for our approval',
      model: recordCase({ record: orderRecord({ status: 'REQUESTED', words: CUSTOMER_STATUS_WORDS.REQUESTED, promiseMoved: false, promiseDate: null, originalPromiseDate: null }, { promiseHistory: [] }) }),
      note: '“We received your order: it waits for our approval” — never “confirmed” before our yes.',
    },
    {
      id: 'th-275-made-quote',
      label: 'An order made from a quote',
      model: recordCase({ model: () => ({ madeFrom: { kind: 'quote', href: `${PREFIX}/open/Quote/0190f0e2-1910-7000-8000-000000000902?view=conversation`, label: '#3' } }) }),
      note: 'No request of theirs behind the quote: the quote is named (its conversation page).',
    },
    // ── pop:change-request ──
    { id: 'change', label: 'pop:change-request — Ask for a change', model: recordCase({ model: () => ({ dialog: changeDialog() }) }), note: 'Per line the sizes as ordered (stacked on a phone); line 1 is held with its reason (“the leather was cut on …”); the date, the delivery address, a note. Review waits until something is changed.' },
    { id: 'change-edited', label: 'Ask for a change: sizes changed', model: recordCase({ model: () => ({ dialog: changeDialog(EDITED) }) }), note: 'Changed cells are marked “Was 6”.' },
    { id: 'change-review', label: 'Ask for a change: review old → new', model: recordCase({ model: () => ({ dialog: changeDialog({ ...EDITED, step: 'review' }) }) }), note: '⌘Enter sends from the review step.' },
    { id: 'change-refused', label: 'Ask for a change: refused at the click', model: recordCase({ model: () => ({ dialog: changeDialog({ ...EDITED, step: 'review' }, { problem: 'problem.verdict.OPEN_REQUEST' }) }) }) },
    { id: 'change-discard', label: 'Ask for a change: Esc with typed work', model: recordCase({ model: () => ({ dialog: changeDialog(EDITED, { discard: true }) }) }), note: 'Discard / Stay (no draft is stored).' },
    { id: 'change-held', label: 'Ask for a change: the order cannot change any more', model: recordCase({ model: (locale) => ({ dialog: changeDialog({}, { rules: rulesOf({ change: { possible: false, code: 'STATUS', day: null, words: { it: 'Non possibile: pronto per la spedizione', en: 'Not possible: ready to ship' } } }) }), changeHeld: locale === 'it' ? 'Non possibile: pronto per la spedizione' : 'Not possible: ready to ship' }) }), note: 'The change is held with its reason; the line’s ⋯ “Ask for a change on this line” is held with the same words (the band’s ONE “Ask for a change…” opens the Ask dialog).' },
    // ── pop:cancel-request ──
    { id: 'cancel', label: 'pop:cancel-request — Ask to cancel', model: recordCase({ model: () => ({ dialog: cancelDialog({ scope: 'LINES' }) }) }), note: 'Per line what the cut-off rules say now (held / Free · fee); the fee words; reason and note.' },
    { id: 'cancel-chosen', label: 'Ask to cancel: a line chosen, the fee', model: recordCase({ model: () => ({ dialog: cancelDialog({ scope: 'LINES', lineIds: [rulesOf().lines[1]!.lineId], reasonCode: 'NOT_NEEDED' }) }) }) },
    { id: 'cancel-tried', label: 'Ask to cancel: Send with nothing chosen', model: recordCase({ model: () => ({ dialog: cancelDialog({ scope: 'LINES', tried: true }) }) }), note: 'Held with its reason, under the field.' },
    { id: 'cancel-mtm', label: 'Ask to cancel: made to measure for a consumer', model: recordCase({ record: MTM, model: () => ({ requests: NO_REQUESTS, dialog: cancelDialog({}, rulesOf({ cancel: { possible: true, code: 'FREE', day: null, words: { it: 'Libero', en: 'Free' } }, noWithdrawal: NO_WITHDRAWAL_WORDS, cancelFee: { pct: null, words: { it: 'Nessuna penale', en: 'No fee' }, currency: 'EUR', wholeOrderFee: 0 } }), own(MTM)) }) }), note: '“No right of withdrawal applies (Codice del Consumo art. 59)”.' },
    // ── pop:reconfirm ──
    // ---- F-PR-13: the Ask dialog — what, the details of a production ask, what it means before Send
    { id: 'ask', label: 'Ask us: what you would like (step 1)', model: recordCase({ model: () => ({ dialog: askDialog() }) }), note: 'Change and cancel, then the asks this customer’s limits open; Resume is held with its reason; a closed ask is not drawn.' },
    { id: 'ask-rush', label: 'Ask us: make it urgent, the need-by date (step 2)', model: recordCase({ model: () => ({ dialog: askDialog({ step: 'details', kind: 'RUSH', draft: { requestedDate: dayAt(9) } }) }) }) },
    { id: 'ask-split', label: 'Ask us: ship what is ready, the first part (step 2)', model: recordCase({ model: () => ({ dialog: askDialog({ step: 'details', kind: 'SPLIT_SHIPMENT', draft: { cells: { [rulesOf().lines[1]!.lineId]: { '50': 4 } } } }) }) }) },
    { id: 'ask-sample', label: 'Ask us: another sample (step 2)', model: recordCase({ model: () => ({ dialog: askDialog({ step: 'details', kind: 'SAMPLE_ROUND', draft: { lineId: rulesOf().lines[0]!.lineId } }) }) }), note: 'A pre-production sample is held after the leather was cut; the top of production stays open.' },
    { id: 'ask-impact', label: 'Ask us: what it means before Send (step 3)', model: recordCase({ model: () => ({ dialog: askDialog({ step: 'impact', kind: 'RUSH', draft: { requestedDate: dayAt(9) }, impact: RUSH_IMPACT }) }) }), note: 'Nothing frozen, no price, the earliest date (an estimate, a date only).' },
    {
      id: 'change-impact',
      label: 'Ask for a change: what it means (frozen, a price may apply, after release)',
      model: recordCase({ model: () => ({ dialog: (() => { const dialog = changeDialog({ ...EDITED, step: 'review' }); return dialog.kind === 'change' ? { ...dialog, model: { ...dialog.model, impact: { state: 'ready' as const, view: impactViewOf('CHANGE', CHANGE_IMPACT, { seesPrices: false, fee: null, money: String, sizesAsked: true }) } } } : dialog })() }) }),
      note: 'A role without prices reads “A price may apply”; after release a size change means cancel and remake.',
    },
    { id: 'cancel-review', label: 'Ask to cancel: what it means before Send', model: recordCase({ model: () => ({ dialog: (() => { const dialog = cancelDialog({ scope: 'LINES', lineIds: [rulesOf().lines[1]!.lineId], reasonCode: 'NOT_NEEDED', step: 'review' }); return dialog.kind === 'cancel' ? { ...dialog, model: { ...dialog.model, impact: { state: 'ready' as const, view: impactViewOf('CANCEL', { kind: 'CANCEL', frozen: [], blocked: false, priced: true, earliest: null, notes: [] }, { seesPrices: true, fee: 29550, money: (minor) => `€ ${(minor / 100).toFixed(2)}`, sizesAsked: false }) } } } : dialog })() }) }) },
    // ---- end F-PR-13
    { id: 'reconfirm', label: 'pop:reconfirm — Re-confirm order version 2', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'ready', page: approvalPage() }, dialog: reconfirm() }) }), note: 'Our message; why it changed; line by line old → new and the totals; Confirm or Decline; the typed name signs.' },
    { id: 'reconfirm-decline', label: 'Re-confirm: decline without a reason', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'ready', page: approvalPage() }, dialog: reconfirm({ decision: 'REFUSED', problem: 'reconfirm.problem.why' }) }) }) },
    { id: 'reconfirm-done', label: 'Re-confirm: signed', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'ready', page: approvalPage() }, dialog: reconfirm({ done: { decision: 'APPROVED', name: 'Anna Esempio', at: at(0) } }) }) }) },
    { id: 'reconfirm-held', label: 'Re-confirm: a colleague who may not approve', model: recordCase({ record: REVISED, model: (locale) => ({ revision: { state: 'ready', page: approvalPage() }, reconfirmHeld: words(locale)('held.mayApprove'), dialog: reconfirm({ held: 'held.mayApprove' }) }) }) },
    // ── pop:pay-deposit ──
    { id: 'pay', label: 'pop:pay-deposit — Pay the deposit', model: recordCase({ record: MTM, model: (locale) => ({ pay: PAY_OPEN, requests: NO_REQUESTS, progress: { state: 'hidden', read: null }, dialog: pay(locale) }) }), note: 'Card or SEPA; the FAKE provider only (nothing reaches a real provider).' },
    { id: 'pay-fields', label: 'Pay the deposit: the provider’s fields', model: recordCase({ record: MTM, model: (locale) => ({ pay: PAY_OPEN, requests: NO_REQUESTS, progress: { state: 'hidden', read: null }, dialog: pay(locale, { state: 'ready' }) }) }), note: 'The FAKE provider’s fields are what a bank would do.' },
    { id: 'pay-waiting', label: 'Pay the deposit: waiting for the bank (SEPA)', model: recordCase({ record: MTM, model: (locale) => ({ pay: PAY_OPEN, requests: NO_REQUESTS, progress: { state: 'hidden', read: null }, dialog: pay(locale, { method: 'SEPA_DEBIT', state: 'waiting' }) }) }) },
    { id: 'pay-failed', label: 'Pay the deposit: declined', model: recordCase({ record: MTM, model: (locale) => ({ pay: PAY_OPEN, requests: NO_REQUESTS, progress: { state: 'hidden', read: null }, dialog: pay(locale, { state: 'failed', failure: failureWords('card_declined', locale) }) }) }) },
    { id: 'pay-paid', label: 'Pay the deposit: paid', model: recordCase({ record: MTM, model: (locale) => ({ pay: PAY_OPEN, requests: NO_REQUESTS, progress: { state: 'hidden', read: null }, dialog: pay(locale, { state: 'succeeded' }) }) }) },
    // ── the record's own states ──
    {
      id: 'office-preview',
      label: 'An office preview',
      model: recordCase({ preview: true, model: (locale) => ({ changeHeld: words(locale)('held.preview'), withdrawHeld: words(locale)('held.preview'), fileHeld: words(locale)('held.previewFiles') }), facts: (locale) => ({ ask: { held: words(locale)('held.preview') }, cancelHeld: words(locale)('held.preview') }) }),
      note: 'Every sending verb is held with the reason.',
    },
    { id: 'offline', label: 'No connection', model: recordCase({ model: () => ({ offlineSince: at(-1) }) }) },
    { id: 'loading', label: 'Loading', model: recordCase({ model: () => ({ state: 'loading', record: null }) }) },
    { id: 'error', label: 'The order could not be read', model: recordCase({ model: () => ({ state: 'error', record: null }) }) },
    { id: 'missing', label: 'Not one of their orders', model: recordCase({ model: () => ({ state: 'missing', record: null }) }), note: 'Another customer’s order answers like one that does not exist.' },
  ],
})
