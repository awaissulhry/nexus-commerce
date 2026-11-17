import { failureWords } from '@nexus/factory-domain/payments/online/rules'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import type { OrderRecord } from '../api'
import { orderBandOf, type OrderBandFacts } from '../band'
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
  progressRead,
  requestsOf,
  rulesOf,
  shellOf,
  shipmentsRead,
  threadOf,
  TODAY,
  withoutPrices,
  words,
} from '../design-data'
import { cancelHeld, changeHeld, EMPTY_CANCEL, EMPTY_CHANGE, movesOf, shipToLines, type CancelDraft, type ChangeDraft, type RecordTab } from '../model'
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

/**
 * SCR-184 › one order (design portal.customer.orders rec "Order"; B-W2b-191; B-TH-275, picture 22), MADE-UP data only: the four
 * tabs (Status & progress with the state line, "Made from your request", the tracker, the promise history, your requests,
 * production progress, the deposit and the facts; Lines with each size run and the totals; Shipments & tracking with parcels,
 * steps, papers and what is still to ship; Documents by version) beside the order's conversation docked at 1440 (the portal
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
    tab: 'status',
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
    historyOpen: false,
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
}

function recordCase(input: CaseInput = {}): CustomerCaseBuilder {
  return (locale) => {
    const record = input.record ?? orderRecord()
    const tab = input.tab ?? 'status'
    const model = recordModel(record, { tab, ...(input.model?.(locale) ?? {}) })
    const facts: OrderBandFacts = {
      changeHeld: model.changeHeld,
      cancelHeld: null,
      reconfirm: model.revision.page?.content.revisedOrder && record.order.reconfirmNeeded ? { revision: model.revision.page.content.revisedOrder.revision, held: model.reconfirmHeld } : null,
      shipments: record.shipments.shown,
      moves: movesOf(record.promiseHistory),
      confirmation: true,
      pay: Object.values(model.pay)[0] ?? null,
      ...(input.facts?.(locale) ?? {}),
    }
    return {
      shell: shellOf(locale, orderBandOf({ words: orderWords(locale), record, tab, prefix: PREFIX, facts }), { path: `/orders/${record.order.id}`, preview: input.preview ?? false }),
      // B-TH-275: the order's ONE conversation docks beside every tab.
      body: { kind: 'record', model, thread: threadOf(locale) },
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
const PAY_OPEN = { [MTM.deposits[0]!.id]: { held: null } }

export const designScreen = defineDesignScreen<CustomerCaseBuilder>({
  screen: 'SCR-184-record',
  title: 'Customer order record (portal.customer.orders rec Order)',
  view: CustomerCase,
  cases: [
    // ── Status & progress ──
    { id: 'status', label: 'Status & progress', model: recordCase(), note: 'Six steps in customer words with their dates; the promise date big, first promised kept, “Date moved 2 times”; your requests (one waiting, one answered with our words); production progress per line (counts, a line’s sizes); the deposit paid; the order’s facts.' },
    { id: 'status-history', label: 'pop:promise-history — Promise date history', model: recordCase({ model: () => ({ historyOpen: true }) }), note: 'Each move: from → to, the day, the reason in customer words (curated, never internal notes).' },
    { id: 'status-reconfirm', label: '“Please re-confirm” (a revised version waits)', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'ready', page: approvalPage() } }) }), note: 'The banner names the version and the day; what changed, line by line; the net value moved: the earlier acceptance no longer holds. The Status tab says “to confirm”; the band’s ⋯ opens it too.' },
    { id: 'status-reconfirm-no-access', label: 'Re-confirm: a colleague who cannot read approvals', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'noAccess', page: null } }) }) },
    { id: 'status-deposit', label: 'A made-to-measure order waiting for its deposit', model: recordCase({ record: MTM, model: () => ({ progress: { state: 'hidden', read: null }, requests: { state: 'ready', items: [] }, pay: PAY_OPEN }) }), note: '“Production starts when the deposit is received.” Pay by card (FIN-123). No right of withdrawal (made to measure). Progress not shared: no section, no hint.' },
    { id: 'status-no-prices', label: 'A colleague without prices', model: recordCase({ record: withoutPrices(RECORD), model: () => ({ requests: { state: 'noAccess', items: [] } }) }), note: 'No deposit card, no amounts.' },
    { id: 'status-cancelled', label: 'A cancelled order', model: recordCase({ record: orderRecord({ status: 'CANCELLED', words: { it: 'Annullato', en: 'Cancelled' }, cancelledOn: dayAt(-3), promiseMoved: false }, { promiseHistory: [], progressShared: false }), model: () => ({ progress: { state: 'hidden', read: null }, requests: { state: 'ready', items: [] } }) }) },
    { id: 'status-sent', label: 'A change request just sent', model: recordCase({ model: () => ({ notice: { tone: 'success', key: 'notice.changeSent' } }) }) },
    { id: 'status-parts-loading', label: 'Parts still loading', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'loading', page: null }, progress: { state: 'loading', read: null }, requests: { state: 'loading', items: [] } }) }) },
    { id: 'status-parts-error', label: 'Parts that could not be read', model: recordCase({ record: REVISED, model: () => ({ revision: { state: 'error', page: null }, progress: { state: 'error', read: null }, requests: { state: 'error', items: [] } }) }), note: 'Each says so with Try again; never drawn as empty.' },
    // ── Lines ──
    { id: 'lines', label: 'Lines', model: recordCase({ tab: 'lines' }), note: 'Each line with pieces ordered / shipped / open, unit price and line amount, the line’s own date; the size run of each line below; the totals with the deposit paid and what is left to pay on the invoice.' },
    { id: 'lines-sizes', label: 'A line’s sizes open', model: recordCase({ tab: 'lines', model: () => ({ openLine: RECORD.lines[0]!.id }) }) },
    { id: 'lines-mtm', label: 'A made-to-measure line', model: recordCase({ record: MTM, tab: 'lines', model: () => ({ requests: NO_REQUESTS }) }), note: 'The rider and the measurement revision (“Marco B. · rev. 3”).' },
    { id: 'lines-no-prices', label: 'Lines without prices', model: recordCase({ record: withoutPrices(RECORD), tab: 'lines' }) },
    // ── Shipments & tracking ──
    { id: 'shipments', label: 'Shipments & tracking', model: recordCase({ tab: 'shipments' }), note: 'DDT, carrier, parcels with their tracking numbers (Copy) and the carrier’s site, the four steps, ETA, what it carries, the events, the papers; still to ship with the expected day.' },
    { id: 'shipments-copied', label: 'A tracking number copied', model: recordCase({ tab: 'shipments', model: () => ({ copied: 'DEMO00012345' }) }) },
    // B-W2b-170: Copy tracking link (the branded tracking page, to pass on), copied.
    { id: 'shipments-link-copied', label: 'The shipment\'s tracking link copied (B-W2b-170)', model: recordCase({ tab: 'shipments', model: () => ({ copied: `link:${shipmentsRead().shipments[0]!.id}` }) }) },
    { id: 'shipments-none', label: 'Nothing shipped yet', model: recordCase({ tab: 'shipments', model: () => ({ shipments: { state: 'ready', read: shipmentsRead({ shipments: [], firstExpected: dayAt(9), stillToShip: [] }) } }) }), note: '“Nothing shipped yet. Expected first shipment: …”' },
    { id: 'shipments-error', label: 'Shipments could not be read', model: recordCase({ tab: 'shipments', model: () => ({ shipments: { state: 'error', read: null } }) }) },
    // ── Documents ──
    { id: 'documents', label: 'Documents', model: recordCase({ tab: 'documents' }), note: 'By version with the fingerprint; the earlier confirmation names the version that replaced it; NEW; preview and download (logged).' },
    { id: 'documents-empty', label: 'No documents yet', model: recordCase({ tab: 'documents', model: () => ({ documents: { state: 'ready', read: documentsRead({ items: [], count: 0 }) } }) }) },
    { id: 'documents-no-access', label: 'Documents not in the role', model: recordCase({ tab: 'documents', model: () => ({ documents: { state: 'noAccess', read: null } }) }) },
    { id: 'documents-error', label: 'Documents could not be read', model: recordCase({ tab: 'documents', model: () => ({ documents: { state: 'error', read: null } }) }) },
    { id: 'preview', label: 'A document’s preview opening', model: recordCase({ tab: 'documents', model: () => ({ dialog: { kind: 'preview', model: { title: 'DDT-2026-0144', state: 'loading', bytes: null } } }) }) },
    { id: 'preview-error', label: 'A document that could not be opened', model: recordCase({ tab: 'documents', model: () => ({ dialog: { kind: 'preview', model: { title: 'DDT-2026-0144', state: 'error', bytes: null } } }) }) },
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
    { id: 'change-held', label: 'Ask for a change: the order cannot change any more', model: recordCase({ model: (locale) => ({ dialog: changeDialog({}, { rules: rulesOf({ change: { possible: false, code: 'STATUS', day: null, words: { it: 'Non possibile: pronto per la spedizione', en: 'Not possible: ready to ship' } } }) }), changeHeld: locale === 'it' ? 'Non possibile: pronto per la spedizione' : 'Not possible: ready to ship' }), facts: (locale) => ({ changeHeld: locale === 'it' ? 'Non possibile: pronto per la spedizione' : 'Not possible: ready to ship' }) }), note: 'The band’s Ask for a change is held with the same words.' },
    // ── pop:cancel-request ──
    { id: 'cancel', label: 'pop:cancel-request — Ask to cancel', model: recordCase({ model: () => ({ dialog: cancelDialog({ scope: 'LINES' }) }) }), note: 'Per line what the cut-off rules say now (held / Free · fee); the fee words; reason and note.' },
    { id: 'cancel-chosen', label: 'Ask to cancel: a line chosen, the fee', model: recordCase({ model: () => ({ dialog: cancelDialog({ scope: 'LINES', lineIds: [rulesOf().lines[1]!.lineId], reasonCode: 'NOT_NEEDED' }) }) }) },
    { id: 'cancel-tried', label: 'Ask to cancel: Send with nothing chosen', model: recordCase({ model: () => ({ dialog: cancelDialog({ scope: 'LINES', tried: true }) }) }), note: 'Held with its reason, under the field.' },
    { id: 'cancel-mtm', label: 'Ask to cancel: made to measure for a consumer', model: recordCase({ record: MTM, model: () => ({ requests: NO_REQUESTS, dialog: cancelDialog({}, rulesOf({ cancel: { possible: true, code: 'FREE', day: null, words: { it: 'Libero', en: 'Free' } }, noWithdrawal: NO_WITHDRAWAL_WORDS, cancelFee: { pct: null, words: { it: 'Nessuna penale', en: 'No fee' }, currency: 'EUR', wholeOrderFee: 0 } }), own(MTM)) }) }), note: '“No right of withdrawal applies (Codice del Consumo art. 59)”.' },
    // ── pop:reconfirm ──
    // ---- F-PR-13: the Ask dialog — what, the details of a production ask, what it means before Send
    { id: 'ask', label: 'Ask us: what you would like (step 1)', model: recordCase({ model: () => ({ dialog: askDialog() }), facts: () => ({ ask: { held: null } }) }), note: 'Change and cancel, then the asks this customer’s limits open; Resume is held with its reason; a closed ask is not drawn.' },
    { id: 'ask-rush', label: 'Ask us: make it urgent, the need-by date (step 2)', model: recordCase({ model: () => ({ dialog: askDialog({ step: 'details', kind: 'RUSH', draft: { requestedDate: dayAt(9) } }) }), facts: () => ({ ask: { held: null } }) }) },
    { id: 'ask-split', label: 'Ask us: ship what is ready, the first part (step 2)', model: recordCase({ model: () => ({ dialog: askDialog({ step: 'details', kind: 'SPLIT_SHIPMENT', draft: { cells: { [rulesOf().lines[1]!.lineId]: { '50': 4 } } } }) }), facts: () => ({ ask: { held: null } }) }) },
    { id: 'ask-sample', label: 'Ask us: another sample (step 2)', model: recordCase({ model: () => ({ dialog: askDialog({ step: 'details', kind: 'SAMPLE_ROUND', draft: { lineId: rulesOf().lines[0]!.lineId } }) }), facts: () => ({ ask: { held: null } }) }), note: 'A pre-production sample is held after the leather was cut; the top of production stays open.' },
    { id: 'ask-impact', label: 'Ask us: what it means before Send (step 3)', model: recordCase({ model: () => ({ dialog: askDialog({ step: 'impact', kind: 'RUSH', draft: { requestedDate: dayAt(9) }, impact: RUSH_IMPACT }) }), facts: () => ({ ask: { held: null } }) }), note: 'Nothing frozen, no price, the earliest date (an estimate, a date only).' },
    {
      id: 'change-impact',
      label: 'Ask for a change: what it means (frozen, a price may apply, after release)',
      model: recordCase({ model: () => ({ dialog: (() => { const dialog = changeDialog({ ...EDITED, step: 'review' }); return dialog.kind === 'change' ? { ...dialog, model: { ...dialog.model, impact: { state: 'ready', view: impactViewOf('CHANGE', CHANGE_IMPACT, { seesPrices: false, fee: null, money: String, sizesAsked: true }) } } } : dialog })() }) }),
      note: 'A role without prices reads “A price may apply”; after release a size change means cancel and remake.',
    },
    { id: 'cancel-review', label: 'Ask to cancel: what it means before Send', model: recordCase({ model: () => ({ dialog: (() => { const dialog = cancelDialog({ scope: 'LINES', lineIds: [rulesOf().lines[1]!.lineId], reasonCode: 'NOT_NEEDED', step: 'review' }); return dialog.kind === 'cancel' ? { ...dialog, model: { ...dialog.model, impact: { state: 'ready', view: impactViewOf('CANCEL', { kind: 'CANCEL', frozen: [], blocked: false, priced: true, earliest: null, notes: [] }, { seesPrices: true, fee: 29550, money: (minor) => `€ ${(minor / 100).toFixed(2)}`, sizesAsked: false }) } } } : dialog })() }) }) },
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
      model: recordCase({ preview: true, model: (locale) => ({ changeHeld: words(locale)('held.preview'), withdrawHeld: words(locale)('held.preview'), fileHeld: words(locale)('held.previewFiles') }), facts: (locale) => ({ changeHeld: words(locale)('held.preview'), cancelHeld: words(locale)('held.preview') }) }),
      note: 'Every sending verb is held with the reason.',
    },
    { id: 'offline', label: 'No connection', model: recordCase({ model: () => ({ offlineSince: at(-1) }) }) },
    { id: 'loading', label: 'Loading', model: recordCase({ model: () => ({ state: 'loading', record: null }) }) },
    { id: 'error', label: 'The order could not be read', model: recordCase({ model: () => ({ state: 'error', record: null }) }) },
    { id: 'missing', label: 'Not one of their orders', model: recordCase({ model: () => ({ state: 'missing', record: null }) }), note: 'Another customer’s order answers like one that does not exist.' },
  ],
})
