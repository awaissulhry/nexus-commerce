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
import { CustomerCase, type CustomerCaseBuilder } from '../view/CustomerCase'
import type { OrderDialog, OrderRecordViewModel } from '../view/OrderRecordView'

/**
 * SCR-184 › one order (design portal.customer.orders rec "Order"; B-W2b-191), MADE-UP data only: the five tabs (Status &
 * progress with the tracker, the promise history, your requests, production progress, the deposit and the facts; Lines with
 * each size run and the totals; Shipments & tracking with parcels, steps, papers and what is still to ship; Documents by
 * version; Messages), "Please re-confirm", every pop-up (Ask for a change: edit, held cells, review, a refusal, discard; Ask
 * to cancel; Re-confirm version 2: choose, decline, signed, held; Pay the deposit on the FAKE provider: idle, its fields,
 * waiting, failed, paid; a document's preview), a role without prices, an office preview, no connection, loading, a failed
 * read and a missing order.
 */

const FACTS = { mayAsk: true, preview: false, offline: false, busy: false }

function recordModel(record: OrderRecord, over: Partial<OrderRecordViewModel> = {}): OrderRecordViewModel {
  return {
    state: 'ready',
    record,
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
      body: { kind: 'record', model, thread: tab === 'messages' ? threadOf(locale) : null },
    }
  }
}

const RECORD = orderRecord()
const SHIP_TO = shipToLines(RECORD.order.shipTo)

function changeDialog(draft: Partial<ChangeDraft> = {}, over: { problem?: string | null; discard?: boolean; rules?: ReturnType<typeof rulesOf> } = {}): OrderDialog {
  const rules = over.rules ?? rulesOf()
  const full: ChangeDraft = { ...EMPTY_CHANGE, ...draft }
  return { kind: 'change', model: { state: 'ready', number: RECORD.order.number, rules, draft: full, held: changeHeld(rules, full, FACTS), busy: false, problem: over.problem ?? null, discard: over.discard ?? false, shipTo: SHIP_TO, today: TODAY } }
}
const EDITED: Partial<ChangeDraft> = { cells: { [rulesOf().lines[1]!.lineId]: { '50': 8, '52': 5 } }, requestedDate: dayAt(10), note: 'Due 50 in più per il negozio di Torino.' }

function cancelDialog(draft: Partial<CancelDraft> = {}, rules = rulesOf(), number = RECORD.order.number): OrderDialog {
  const full: CancelDraft = { ...EMPTY_CANCEL, ...draft }
  return { kind: 'cancel', model: { state: 'ready', number, rules, draft: full, held: cancelHeld(rules, full, FACTS), busy: false, problem: null } }
}

const REVISED = orderRecord({ reconfirmNeeded: true })
const reconfirm = (over: Partial<Extract<OrderDialog, { kind: 'reconfirm' }>['model']> = {}): OrderDialog => ({
  kind: 'reconfirm',
  model: { state: 'ready', page: approvalPage(), number: REVISED.order.number, decision: null, comment: '', held: null, problem: null, busy: false, done: null, ...over },
})

const MTM = mtmRecord()
const pay = (locale: Locale, over: Partial<Extract<OrderDialog, { kind: 'pay' }>['model']> = {}): OrderDialog => ({
  kind: 'pay',
  model: { amount: orderWords(locale).money(MTM.deposits[0]!.amount, 'EUR'), number: MTM.order.number, methods: ['CARD', 'SEPA_DEBIT'], method: 'CARD', state: 'idle', fake: true, held: null, failure: null, problem: null, ...over },
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
    // ── Messages ──
    { id: 'messages', label: 'Messages', model: recordCase({ tab: 'messages' }), note: 'The order’s shared thread: our messages and e-mails, theirs; “You can also answer our e-mails”.' },
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
    { id: 'cancel-mtm', label: 'Ask to cancel: made to measure for a consumer', model: recordCase({ record: MTM, model: () => ({ requests: NO_REQUESTS, dialog: cancelDialog({}, rulesOf({ cancel: { possible: true, code: 'FREE', day: null, words: { it: 'Libero', en: 'Free' } }, noWithdrawal: NO_WITHDRAWAL_WORDS, cancelFee: { pct: null, words: { it: 'Nessuna penale', en: 'No fee' }, currency: 'EUR', wholeOrderFee: 0 } }), MTM.order.number) }) }), note: '“No right of withdrawal applies (Codice del Consumo art. 59)”.' },
    // ── pop:reconfirm ──
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
