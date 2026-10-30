import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { panels, panelsModel } from '../../../_shared/buying/fixtures'
import type { Claim } from '../api'
import {
  canFor,
  claim,
  CONTACTS,
  costless,
  COUNTS,
  FOUND_LOTS,
  inShell,
  LEATHER_STOCK,
  LOT_HIDES,
  LOTS,
  NOW,
  OPEN_ROWS,
  PAD_STOCK,
  PREFIX,
  REASON_LIST,
  RECEIPT,
  returnAnswer,
  ROWS,
  SEND_CHECK,
  TIME_ZONE,
  withoutCost,
  ZERO_COUNTS,
  type RoleCase,
} from '../demo/fixtures'
import { answerDraftOf, formOf, goodsDraftOf, NO_RETURN, ready, sendDraftOf, withCheck, words, type ClaimRecordModel, type ClaimsListModel, type ReturnDialogModel, type ReturnDraft } from '../model'
import { ClaimRecordView } from '../record/view/ClaimRecordView'
import { ClaimsListView } from './view/ClaimsListView'

/**
 * SCR-131 — Returns & claims to suppliers (design purchasing.claims) with made-up data only: the tiles (open, waiting
 * for the supplier, credit expected, closed this month), the list frame of returns and claims in every state, the
 * filter chips a receipt or a lot opens it with, the kind, the selection with Export, live updates, Return to supplier
 * (find the lot, its hides one by one or its stock per place, the reason, the remedy, an optional e-mail, the return DDT;
 * held with its reason; refused; the result), and the record: the Claim tab (facts, the fields a state allows, the
 * explicit save, the lines), Goods returned (DDTs, stock moves), Credit (expected beside the credit note Finance
 * matches), Activity, every dialog (send, answer, send the goods back, close, cancel, remove lines) and the states.
 * Roles: Buyer (with costs), Warehouse (sends goods back, no money), Read-only, Planner, Sales (no purchasing.view).
 */

type Case = { kind: 'list'; role: RoleCase; list: ClaimsListModel } | { kind: 'record'; role: RoleCase; record: ClaimRecordModel }

const NO_FILTERS = { q: '', kind: null, receipt: null, lot: null }

function listCase(role: RoleCase, over: Partial<ClaimsListModel> = {}): Case {
  const can = canFor(role)
  const rows = over.rows ?? { items: OPEN_ROWS, more: false, problem: null }
  const shown = can.cost ? rows : { ...rows, items: rows.items?.map(withoutCost) ?? null }
  return {
    kind: 'list',
    role,
    list: { prefix: PREFIX, can, view: 'open', filters: NO_FILTERS, chips: { receipt: null, lot: null }, counts: COUNTS, countsProblem: null, asOf: NOW, live: 'live', updates: 0, notice: null, ret: null, timeZone: TIME_ZONE, ...over, rows: shown },
  }
}

const only = (...statuses: string[]) => ({ items: ROWS.filter((row) => statuses.includes(row.status)), more: false, problem: null })

function ret(over: Partial<ReturnDraft> = {}, model: Partial<ReturnDialogModel> = {}): ReturnDialogModel {
  return { draft: { ...NO_RETURN, reasons: ready(REASON_LIST), ...over }, busy: false, problem: null, result: null, ...model }
}
const leatherPicked = (over: Partial<ReturnDraft> = {}): Partial<ReturnDraft> => ({
  lot: FOUND_LOTS[0]!,
  stock: ready(LEATHER_STOCK),
  hides: ready(LOT_HIDES),
  hideIds: LOT_HIDES.map((hide) => hide.id),
  quantities: {},
  ...over,
})
const filled = (over: Partial<ReturnDraft> = {}): Partial<ReturnDraft> => leatherPicked({ reasonCode: 'QUALITY', reasonNote: 'Fori vicino al fianco', ddt: { transportBy: 'CARRIER', carrier: 'Trasporti Demo S.r.l.', packages: '1', grossWeightKg: '14,5', appearance: 'Arrotolate su pallet', remarks: '' }, ...over })

function recordCase(role: RoleCase, value: Claim, over: Partial<ClaimRecordModel> = {}): Case {
  const can = canFor(role)
  const shown = can.cost ? value : costless(value)
  return {
    kind: 'record',
    role,
    record: {
      prefix: PREFIX,
      can,
      tab: 'claim',
      claim: { status: 'ready', value: shown },
      live: 'live',
      dockOpen: false,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      form: null,
      formProblem: null,
      saving: false,
      reasons: ready(REASON_LIST),
      panelsPreview: panelsModel('SupplierClaim', value.id, value.number),
      timeZone: TIME_ZONE,
      ...over,
    },
  }
}

function ClaimsDesign({ model }: { model: Case }) {
  if (model.kind === 'list') return inShell('/purchasing/claims', createElement(ClaimsListView, { model: model.list }), model.role)
  const value = model.record.claim.status === 'ready' ? model.record.claim.value : null
  const id = value?.id ?? 'x'
  return inShell(`/purchasing/claims/${id}`, createElement(ClaimRecordView, { model: model.record, panels: model.record.tab === 'activity' || model.record.dockOpen ? panels('SupplierClaim', id, value?.number ?? '') : null }), model.role)
}

const RETURN_SENT = claim('RETURN', 'SENT')
const RETURN_DONE = claim('RETURN', 'SENT', { returned: 3 })
const CLAIM_DRAFT = claim('CLAIM', 'DRAFT')
const CLAIM_SENT = claim('CLAIM', 'SENT')
const CLAIM_ACCEPTED = claim('CLAIM', 'ACCEPTED')
const editing = { ...formOf(CLAIM_DRAFT), reasonCode: 'OTHER', reasonNote: '' }

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-131',
  title: 'Returns & claims to suppliers (the list, Return to supplier, a claim)',
  view: ClaimsDesign,
  cases: [
    // ---- the list ----
    { id: 'open', label: 'Open returns and claims with their values (buyer)', model: listCase('buyer'), note: 'The default view: every claim not settled yet. Tiles are saved filters; the value column is the cost grain.' },
    { id: 'tile-waiting', label: 'Tile: waiting for the supplier (sent)', model: listCase('buyer', { view: 'sent', rows: only('SENT') }) },
    { id: 'tile-credit', label: 'Tile: credit expected (accepted, asking a credit note)', model: listCase('buyer', { view: 'accepted', rows: only('ACCEPTED') }) },
    { id: 'tile-closed', label: 'Tile: closed (the tile counts this month; the list shows every closed one)', model: listCase('buyer', { view: 'closed', rows: only('CLOSED') }) },
    { id: 'all-states', label: 'Rows ▾ Every state, cancelled and closed included', model: listCase('buyer', { view: 'all', rows: { items: ROWS, more: true, problem: null } }) },
    { id: 'receipt-filter', label: 'Opened from a receipt: its claims in every state, the chip says which receipt', model: listCase('warehouse', { view: 'all', filters: { ...NO_FILTERS, receipt: RECEIPT.id }, chips: { receipt: RECEIPT.number, lot: null }, rows: { items: ROWS.slice(0, 2), more: false, problem: null } }) },
    { id: 'lot-filter', label: 'Opened from a lot: its claims, the chip names the lot', model: listCase('warehouse', { view: 'all', filters: { ...NO_FILTERS, lot: LOTS.leather.id }, chips: { receipt: null, lot: LOTS.leather.code }, rows: { items: ROWS.filter((row) => row.lots.some((lot) => lot.id === LOTS.leather.id)), more: false, problem: null } }) },
    { id: 'lot-filter-unknown', label: 'A lot filter whose code is not known yet: "This lot"', model: listCase('buyer', { view: 'all', filters: { ...NO_FILTERS, lot: LOTS.pads.id }, rows: { items: [], more: false, problem: null } }) },
    { id: 'kind-returns', label: 'Returns only (the kind filter, with its chip)', model: listCase('buyer', { filters: { ...NO_FILTERS, kind: 'RETURN' }, rows: { items: OPEN_ROWS.filter((row) => row.kind === 'RETURN'), more: false, problem: null } }) },
    { id: 'selection', label: 'Rows selected: Export N (CSV)', model: listCase('buyer', { selected: OPEN_ROWS.slice(0, 3).map((row) => row.id) }) },
    { id: 'live-updates', label: 'Live: 2 updates waiting behind "Show"', model: listCase('buyer', { updates: 2 }) },
    { id: 'warehouse', label: 'Warehouse: Return to supplier, no money (no value column)', model: listCase('warehouse') },
    { id: 'read-only', label: 'Read-only: the list, Return to supplier held with the missing permission', model: listCase('readOnly') },
    { id: 'planner', label: 'Planner: reads the claims, no money, no return', model: listCase('planner') },
    { id: 'sales', label: 'Sales: no purchasing.view — the page says so', model: listCase('sales') },
    { id: 'empty', label: 'First day: no returns or claims (and every tile 0)', model: listCase('warehouse', { rows: { items: [], more: false, problem: null }, counts: ZERO_COUNTS }) },
    { id: 'no-match', label: 'A search that matches nothing: Clear filters', model: listCase('buyer', { filters: { ...NO_FILTERS, q: 'zzz' }, rows: { items: [], more: false, problem: null } }) },
    { id: 'loading', label: 'Loading: the tiles say — and the rows are skeletons', model: listCase('buyer', { rows: { items: null, more: false, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The list couldn't be read (offline)", model: listCase('buyer', { rows: { items: null, more: false, problem: 'problem.offline' }, counts: null, countsProblem: 'problem.offline', asOf: null, live: 'offline' }) },
    { id: 'keys', label: 'The keyboard shortcuts', model: listCase('warehouse', { helpOpen: true }) },
    // ---- Return to supplier ----
    { id: 'return-start', label: 'Return to supplier: find the lot first (held: pick the lot)', model: listCase('warehouse', { ret: ret() }) },
    { id: 'return-search', label: 'Return to supplier: lots in stock found by the search', model: listCase('warehouse', { ret: ret({ q: 'LT-DEMO', found: ready(FOUND_LOTS) }) }) },
    { id: 'return-hides', label: 'A leather lot: its three hides in stock, ticked; held until the reason is chosen', model: listCase('warehouse', { ret: ret(leatherPicked()) }) },
    { id: 'return-ready', label: 'Ready: reason, credit asked, carrier, packages and weight (Create return)', model: listCase('warehouse', { ret: ret(filled()) }) },
    { id: 'return-quantity', label: 'A lot by quantity (protectors): how much from each place', model: listCase('warehouse', { ret: ret({ lot: FOUND_LOTS[1]!, stock: ready(PAD_STOCK), hides: ready([]), quantities: { [PAD_STOCK[0]!.location.id]: '24', [PAD_STOCK[1]!.location.id]: '' }, reasonCode: 'WRONG_ITEM' }) }) },
    { id: 'return-too-much', label: 'Held: more than a place holds', model: listCase('warehouse', { ret: ret({ lot: FOUND_LOTS[1]!, stock: ready(PAD_STOCK), hides: ready([]), quantities: { [PAD_STOCK[0]!.location.id]: '30' }, reasonCode: 'WRONG_ITEM' }) }) },
    { id: 'return-mail', label: 'With an e-mail to the supplier: its contacts, the quality desk ticked', model: listCase('warehouse', { ret: ret(filled({ mail: true, contacts: ready(CONTACTS), contactIds: [CONTACTS[0]!.id] })) }) },
    { id: 'return-other-reason', label: 'Reason "Other": the note is required', model: listCase('warehouse', { ret: ret(filled({ reasonCode: 'OTHER', reasonNote: '' })) }) },
    { id: 'return-refused', label: 'Refused: a hide is reserved for a work order (said in our words)', model: listCase('warehouse', { ret: ret(filled(), { problem: words('ret.refused.reserved') }) }) },
    { id: 'return-busy', label: 'Creating the return', model: listCase('warehouse', { ret: ret(filled(), { busy: true }) }) },
    { id: 'return-done', label: 'Done: the claim, the goods out, the return DDT with its PDF (warehouse: no credit amount)', model: listCase('warehouse', { ret: ret(filled(), { result: returnAnswer() }) }) },
    { id: 'return-done-buyer', label: 'Done, seen with costs: the credit expected; a material now over-reserved', model: listCase('owner', { ret: ret(filled(), { result: returnAnswer({ overReserved: [{ itemId: LOTS.leather.id, itemColourId: null, available: '0.0000', reserved: '52.0000' }] }) }) }) },
    // ---- a claim ----
    { id: 'record-return-sent', label: 'A return, sent: Send the goods back is the main act', model: recordCase('warehouse', RETURN_SENT) },
    { id: 'record-claim-draft', label: 'A claim draft (buyer): every field may change, Send', model: recordCase('buyer', CLAIM_DRAFT) },
    { id: 'record-claim-editing', label: 'Changing the draft: reason "Other" without its note — Save held, ⌘S', model: recordCase('buyer', CLAIM_DRAFT, { form: editing }) },
    { id: 'record-claim-save-refused', label: 'The save refused: someone changed it meanwhile', model: recordCase('buyer', CLAIM_DRAFT, { form: { ...formOf(CLAIM_DRAFT), internalNote: 'Chiesto campione di confronto' }, formProblem: words('problem.changed'), changed: { at: NOW } }) },
    { id: 'record-lines-selected', label: 'Draft lines selected: Remove N', model: recordCase('buyer', CLAIM_DRAFT, { selected: CLAIM_DRAFT.lines.map((line) => line.id) }) },
    { id: 'record-claim-sent', label: 'A claim sent: Record the answer; only the remedy, the credit agreed and the note change', model: recordCase('buyer', CLAIM_SENT) },
    { id: 'record-claim-accepted', label: 'Accepted for 15,00 agreed: Close', model: recordCase('buyer', CLAIM_ACCEPTED) },
    { id: 'record-claim-rejected', label: 'Rejected by the supplier: Send again or close', model: recordCase('buyer', claim('CLAIM', 'REJECTED')) },
    { id: 'record-closed', label: 'Closed: read-only with how it was settled', model: recordCase('buyer', claim('RETURN', 'CLOSED')) },
    { id: 'record-cancelled', label: 'A cancelled draft: read-only with why', model: recordCase('buyer', claim('CLAIM', 'CANCELLED', { sentAt: null })) },
    { id: 'record-read-only', label: 'Read-only role: every act held with the missing permission', model: recordCase('readOnly', RETURN_SENT) },
    { id: 'record-goods', label: 'Goods returned: three hides out of N-STORE with DDT 146/2026 (its PDF)', model: recordCase('warehouse', RETURN_DONE, { tab: 'goods' }) },
    { id: 'record-goods-not-yet', label: 'Goods returned: a return sent, nothing gone yet', model: recordCase('warehouse', RETURN_SENT, { tab: 'goods' }) },
    { id: 'record-goods-claim', label: 'Goods returned on a claim: nothing returned — claim only', model: recordCase('buyer', CLAIM_SENT, { tab: 'goods' }) },
    { id: 'record-credit', label: 'Credit: expected beside the credit note Finance matches (not built yet: held)', model: recordCase('buyer', CLAIM_ACCEPTED, { tab: 'credit' }) },
    { id: 'record-credit-replacement', label: 'Credit for a replacement: none expected', model: recordCase('buyer', claim('RETURN', 'ACCEPTED', { remedy: 'REPLACEMENT' }), { tab: 'credit' }) },
    { id: 'record-credit-no-cost', label: 'Credit without the cost grain (warehouse): the amounts are not drawn', model: recordCase('warehouse', RETURN_DONE, { tab: 'credit' }) },
    { id: 'record-activity', label: 'Activity: the thread, files and history', model: recordCase('buyer', CLAIM_SENT, { tab: 'activity' }) },
    { id: 'record-dock', label: 'The thread beside a tab (⌘J)', model: recordCase('buyer', CLAIM_SENT, { dockOpen: true }) },
    { id: 'record-changed', label: 'Changed by someone else while a dialog was open', model: recordCase('buyer', CLAIM_SENT, { changed: { at: NOW }, dialog: { kind: 'answer', draft: answerDraftOf(CLAIM_SENT) } }) },
    { id: 'record-notice', label: 'Just sent by e-mail', model: recordCase('buyer', CLAIM_SENT, { notice: { tone: 'success', words: words('notice.sentMail', { number: CLAIM_SENT.number }) } }) },
    { id: 'dialog-send', label: 'Send: the suggested contact ticked, the standard text in Italian, no price', model: recordCase('buyer', CLAIM_DRAFT, { dialog: { kind: 'send', draft: withCheck(sendDraftOf(CLAIM_DRAFT), ready(SEND_CHECK)) } }) },
    { id: 'dialog-send-loading', label: 'Send: the recipients loading', model: recordCase('buyer', CLAIM_DRAFT, { dialog: { kind: 'send', draft: sendDraftOf(CLAIM_DRAFT) } }) },
    { id: 'dialog-send-no-mail', label: 'Send without an e-mail (told another way); the remedy chosen now', model: recordCase('buyer', { ...CLAIM_DRAFT, remedy: null }, { dialog: { kind: 'send', draft: { ...withCheck(sendDraftOf({ remedy: null }), ready(SEND_CHECK)), withMail: false, remedy: 'CREDIT' } } }) },
    { id: 'dialog-send-refused', label: 'Send refused meanwhile (read again)', model: recordCase('buyer', CLAIM_DRAFT, { dialog: { kind: 'send', draft: withCheck(sendDraftOf(CLAIM_DRAFT), ready(SEND_CHECK)) }, dialogProblem: words('problem.changed') }) },
    { id: 'dialog-answer', label: 'Record the answer: accepted, 15,00 agreed', model: recordCase('buyer', CLAIM_SENT, { dialog: { kind: 'answer', draft: { outcome: 'ACCEPTED', answer: 'Accettiamo: nota di credito entro fine mese.', remedy: 'CREDIT', agreed: '15,00' } } }) },
    { id: 'dialog-answer-held', label: 'Record the answer: held until the outcome is said', model: recordCase('buyer', CLAIM_SENT, { dialog: { kind: 'answer', draft: answerDraftOf(CLAIM_SENT) } }) },
    { id: 'dialog-goods-back', label: 'Send the goods back: the lines still here and the return DDT', model: recordCase('warehouse', RETURN_SENT, { dialog: { kind: 'returnGoods', draft: { ...goodsDraftOf(RETURN_SENT), ddt: { transportBy: 'SENDER', carrier: '', packages: '2', grossWeightKg: '15', appearance: '', remarks: '' } } } }) },
    { id: 'dialog-goods-refused', label: 'Send the goods back refused: a hide reserved', model: recordCase('warehouse', RETURN_SENT, { dialog: { kind: 'returnGoods', draft: { ...goodsDraftOf(RETURN_SENT), ddt: { transportBy: 'SENDER', carrier: '', packages: '1', grossWeightKg: '15', appearance: '', remarks: '' } } }, dialogProblem: words('ret.refused.reserved') }) },
    { id: 'dialog-returned', label: 'The goods went back: the DDT and its PDF', model: recordCase('warehouse', RETURN_DONE, { tab: 'goods', dialog: { kind: 'returned', answer: returnAnswer() } }) },
    { id: 'dialog-close', label: 'Close: how it was settled', model: recordCase('buyer', CLAIM_ACCEPTED, { dialog: { kind: 'close', note: 'Nota di credito NC-DEMO-7 ricevuta.' } }) },
    { id: 'dialog-cancel', label: 'Cancel a draft: why (held until 3 characters)', model: recordCase('buyer', CLAIM_DRAFT, { dialog: { kind: 'cancel', reason: '' } }) },
    { id: 'dialog-remove-lines', label: 'Remove lines of a draft: what goes, what stays', model: recordCase('buyer', CLAIM_DRAFT, { dialog: { kind: 'removeLines', lineIds: CLAIM_DRAFT.lines.map((line) => line.id) } }) },
    { id: 'record-loading', label: 'A claim loading', model: recordCase('buyer', CLAIM_SENT, { claim: { status: 'loading' } }) },
    { id: 'record-not-found', label: 'Not found (or another company)', model: recordCase('buyer', CLAIM_SENT, { claim: { status: 'not_found' } }) },
    { id: 'record-forbidden', label: 'Sales: no purchasing.view', model: recordCase('sales', CLAIM_SENT, { claim: { status: 'forbidden' } }) },
    { id: 'record-error', label: "The claim couldn't be read", model: recordCase('buyer', CLAIM_SENT, { claim: { status: 'error', problem: 'problem.offline' }, live: 'offline' }) },
  ],
})
