import { createElement } from 'react'
import { CHANGE_WORDS } from '@nexus/factory-domain/order-apply/rules' // F-OC T.1: the work-order changes' own words
import { defineDesignScreen, type DesignCase } from '../../../../../lib/design/design-screen'
import { rolePermissions } from '../../../../../shell/design-data'
import { brandRequest } from '../../../../home/approvals/requests/fixtures'
import type { WorkOrderChange } from '../../../../home/approvals/work-order-changes/api'
import { change as workOrderChange } from '../../../../home/approvals/work-order-changes/fixtures'
import type { Order } from '../../api'
import type { Change, Changes, Confirmation, Freeze } from '../../depth/api'
import { CHANGES, CONFIRMATION_SENT, depthModel, FREEZE_CUT } from '../../depth/demo/fixtures'
import { abilitiesOf } from '../../model'
import { amendmentsFor, AMENDMENTS, canOf, inShell, LINE_BLK, LINE_RED, NO_AMENDMENTS, ORDER_ID, order, STYLE, STYLE_ID, VERSIONS, WORK_ORDERS, type Role } from '../../_demo/fixtures'
import { amended, base, orderDesignThread, RQ_AGREED, RQ_ASK, RQ_ASKED, RQ_BLOCKERS, RQ_COUNTERED, RQ_READ, RQ_STILL } from '../fixtures'
import type { Headline, StillRow } from '../overview/api'
import { ready } from '../overview/fixtures'
import type { OrderRecordModel } from '../record-model'
import type { ToldChange } from '../told'
import { OrderRecordView } from '../view/OrderRecordView'

/**
 * SCR-107 — the order's Changes tab (design sales.orders "Record: Sales order › Changes"; order CHANGES tab, 10-design §1–§6) with
 * made-up data only: Waiting (on us · on the customer · Still to do), Can it still change?, What changed (one row per change) and
 * the Customer's agreement; the Before → after window; the empty, loading and failed reads; the roles. The first cases draw What
 * changed from the amendments read alone (an older page); F-OC T.1's cases (below) are the states the seed lacks. Look at each at
 * 375, 1440 and 1920 (S / M / L rooms), the thread dock open and closed, light and dark.
 */

interface ChangesCase {
  role: Role
  record: OrderRecordModel
}

const production = amended(order('IN_PRODUCTION'))
const view = (role: Role, over: Partial<OrderRecordModel> = {}): ChangesCase => base(role, production, { tab: 'changes', amendments: { value: amendmentsFor(role), problem: null }, changeStyles: { [STYLE_ID]: STYLE }, ...over })

function ChangesDesign({ model }: { model: ChangesCase }) {
  return inShell(`/sales/orders/${production.id}`, createElement(OrderRecordView, { model: model.record, thread: orderDesignThread() /* B-TH-214 */ }), model.role)
}

// ---- F-OC T.1 (order CHANGES tab, 15-steps T.1; P0 §1, P0-B12): the states the seed lacks, on SO-2026-0088 as of 18/11/2026 09:42 ----
// Made up: revision 4 (the office's: two fewer red 52, the customer's yes asked — or not, answered, refused, expired), revision 3 (the
// customer's request done as a revision, its work-order change applied and told), revision 2 (priced: a fee and an extra deposit, our
// yes, the customer's yes by link), revision 1 (the customer PO); work-order changes waiting / applied on a draft (the floor not told) /
// declined / stale / a new draft made; the told read's own kinds (lines closed and reopened, a pause placed on a work order this
// reader does not reach and lifted, a style change released); 3 confirmations and 2 sends; the signed PDF checked or missing; a
// portal order; Can it still change? per state; the roles Owner, Sales, Production manager, Planner, Finance and Read-only.

const oc = (n: number) => `0190f0e2-3232-7000-8000-${String(n).padStart(12, '0')}`
const BLK_LINE = CHANGES.changes[0]!.diff.lines[0]!
const RED_LINE = CHANGES.changes[1]!.diff.lines[0]!
/** The customer's request the office carried out as revision 3. */
const OC_REQUEST = brandRequest(41, { ...RQ_ASK, id: oc(41), status: 'ACCEPTED', waitingOn: null, askedAt: '2026-11-12T09:00:00Z', answeredAt: '2026-11-12T15:30:00Z', note: 'One fewer black 54: the shop window is smaller.' })
/** B-OC-003: our counter-offer waits for the customer and lapses on its approval's due day. */
const OC_COUNTERED = { ...RQ_COUNTERED, counter: { ...RQ_COUNTERED.counter!, dueAt: '2026-11-20T16:00:00Z' } }
const OC_REQUESTS = [RQ_ASK, RQ_AGREED, OC_COUNTERED, OC_REQUEST]
const ASK_ID = oc(903)

type Decision = Change['customer']['decision']
/** Revision 4, the office's own (two fewer red 52): the customer's answer as `decision` says. */
function rev4(decision: Decision, over: Partial<Change> = {}): Change {
  const said = decision === 'ACCEPTED' || decision === 'REFUSED'
  return {
    ...CHANGES.changes[1]!,
    id: oc(4),
    revision: 4,
    reason: 'Two fewer red jackets in 52: the shop cut its order.',
    createdAt: '2026-11-16T10:20:00Z',
    createdBy: 'Bea Esempio',
    priced: false,
    diff: { lines: [{ ...RED_LINE, piecesBefore: 6, piecesAfter: 4, sizes: [{ size: '52', before: 2, after: 0 }], priceChanged: false }], netAmountBefore: 630000, netAmountAfter: 590000 },
    parts: [],
    feeAmount: null,
    changeAmount: -40000,
    deposit: null,
    yes: { state: 'NOT_ASKED', taskId: null, reason: null },
    customer: {
      decision,
      requestId: decision === 'NOT_ASKED' ? null : ASK_ID,
      answeredAt: said ? '2026-11-17T15:10:00Z' : decision === 'EXPIRED' ? '2026-11-17T16:00:00Z' : null,
      by: said ? 'Anna Alfa' : null,
      via: said ? 'PORTAL' : null,
      answer: decision === 'REFUSED' ? 'No: we still need the 52s for the shop window.' : decision === 'ACCEPTED' ? 'Fine, go ahead.' : null,
    },
    // B-OC-013: offered after a no and after an expired yes too.
    putBack: { may: true, offered: decision === 'REFUSED' || decision === 'EXPIRED', why: null },
    reasonCode: null,
    changeRequestId: null,
    restores: null,
    restoredBy: null,
    ...over,
  }
}
/** Revision 3: the customer's request (B-OC-010 `changeRequestId`), no new yes needed. */
const REV3: Change = {
  ...CHANGES.changes[2]!,
  id: oc(3),
  revision: 3,
  reason: 'One fewer black 54, as the customer asked.',
  createdAt: '2026-11-12T15:31:00Z',
  createdBy: 'Bea Esempio',
  diff: { lines: [{ ...BLK_LINE, piecesBefore: 9, piecesAfter: 8, sizes: [{ size: '54', before: 2, after: 1 }], priceChanged: false }] },
  changeAmount: -45000,
  putBack: { may: false, offered: false, why: null },
  reasonCode: 'REQUEST',
  changeRequestId: OC_REQUEST.id,
  restores: null,
  restoredBy: null,
}
/** Revision 2: a priced change — a fee and an extra deposit (the price grain only), our yes, the customer's yes by link. */
const REV2: Change = {
  ...CHANGES.changes[0]!,
  id: oc(2),
  revision: 2,
  createdAt: '2026-11-06T11:05:00Z',
  createdBy: 'Bea Esempio',
  deposit: { ...CHANGES.changes[0]!.deposit!, id: oc(922), dueDate: '2026-11-20' },
  yes: { state: 'APPROVED', taskId: oc(920), reason: null, decidedAt: '2026-11-06T12:00:00Z', decidedBy: 'Marco Demo' },
  customer: { decision: 'ACCEPTED', requestId: oc(921), answeredAt: '2026-11-07T09:15:00Z', by: 'Anna Alfa', via: 'LINK', answer: null },
  putBack: { may: false, offered: false, why: null },
  reasonCode: null,
  changeRequestId: null,
  restores: null,
  restoredBy: null,
}
/** Revision 1: the customer PO, nothing to ask. */
const REV1: Change = { ...CHANGES.changes[2]!, id: oc(1), createdAt: '2026-11-04T09:10:00Z', putBack: { may: false, offered: false, why: null }, reasonCode: null, changeRequestId: null, restores: null, restoredBy: null }
const changesOf = (latest: Change, waits: boolean, over: Partial<Changes> = {}): Changes => ({ orderId: ORDER_ID, number: 'SO-2026-0088', waitingForYes: null, reapprovalNeededAt: waits ? latest.createdAt : null, changes: [latest, REV3, REV2, REV1], ...over })
/** The money wall: a reader without the price grain reads no part, fee, amount or deposit amount (as the depth demo strips them). */
const unpriced = (changes: Changes): Changes => ({ ...changes, changes: changes.changes.map(({ parts: _parts, feeAmount: _fee, changeAmount: _change, ...change }) => ({ ...change, deposit: change.deposit ? { ...change.deposit, amount: undefined } : null })) })

// The work-order changes (P0-B12): one waits for a planner, the rest decided — each its own row or riding with its revision.
const RELEASED = { id: WORK_ORDERS[1]!.id, number: WORK_ORDERS[1]!.number, status: WORK_ORDERS[1]!.status }
const woc = (n: number, status: WorkOrderChange['status'], over: Partial<WorkOrderChange> = {}): WorkOrderChange => {
  const cells = over.cells ?? [{ salesOrderLineId: LINE_RED, lineSeq: 20, size: '52', from: 2, to: 0, workOrderSizeId: oc(890 + n) }]
  const workOrder = over.workOrder === undefined ? RELEASED : over.workOrder
  const decided = status !== 'PROPOSED'
  return workOrderChange({
    id: oc(500 + n),
    status,
    partyId: oc(600),
    salesOrder: { id: ORDER_ID, number: 'SO-2026-0088' },
    workOrder,
    requestId: null,
    amendmentId: null,
    cells,
    extra: [],
    extraOutcome: null,
    reason: 'Two fewer red jackets in 52.',
    proposedAt: '2026-11-16T10:21:00Z',
    decidedAt: decided ? '2026-11-16T14:00:00Z' : null,
    decidedBy: decided ? { id: oc(610), name: 'Carla Prova' } : null,
    mayDecide: !decided,
    words: { title: CHANGE_WORDS.title(workOrder?.number ?? null), status: CHANGE_WORDS.status(status), cells: CHANGE_WORDS.cells(cells) },
    ...over,
  })
}
const WOC_WAITS = woc(1, 'PROPOSED', { amendmentId: oc(4) })
const WOC_APPLIED = woc(2, 'APPLIED', { requestId: OC_REQUEST.id, amendmentId: REV3.id, cells: [{ salesOrderLineId: LINE_BLK, lineSeq: 10, size: '54', from: 2, to: 1, workOrderSizeId: oc(902) }], workOrder: { id: WORK_ORDERS[0]!.id, number: WORK_ORDERS[0]!.number, status: WORK_ORDERS[0]!.status }, decidedAt: '2026-11-12T16:00:00Z' })
const WOC_ON_DRAFT = woc(3, 'APPLIED', { workOrder: { id: oc(523), number: 'WO-00023', status: 'DRAFT' }, decidedAt: '2026-11-10T11:00:00Z' })
const WOC_DECLINED = woc(4, 'DECLINED', { decisionNote: 'The 52s are cut already: they stay as they are.', decidedAt: '2026-11-09T10:00:00Z' })
const WOC_STALE = woc(5, 'STALE', { decidedAt: '2026-11-08T10:00:00Z' })
const WOC_MADE = woc(6, 'APPLIED', { kind: 'MAKE_MORE', workOrder: null, amendmentId: REV2.id, madeWorkOrder: { id: oc(524), number: 'WO-00024' }, cells: [{ salesOrderLineId: LINE_BLK, lineSeq: 10, size: '50', from: 0, to: 1, workOrderSizeId: oc(905) }], decidedAt: '2026-11-06T12:30:00Z' })
const OC_WOCS = [WOC_WAITS, WOC_APPLIED, WOC_ON_DRAFT, WOC_DECLINED, WOC_STALE, WOC_MADE]

// The told read (B-OC-009): each line its speaker's own ids — the floor and the workshop told, the people counted, never named.
const toldAt = (n: number, at: string, speaker: ToldChange['speaker'], floor: ToldChange['floor'] = { at, workOrders: [{ id: WORK_ORDERS[1]!.id, number: WORK_ORDERS[1]!.number }], leftOut: 0 }): ToldChange => ({ batchId: oc(950 + n), messageId: oc(970 + n), occurredAt: at, at, eventType: 'sales_order.changed', requestId: null, people: 3, floor, workshop: { at: null, told: 0, waiting: 0 }, speaker })
const OC_TOLD: ToldChange[] = [
  toldAt(1, '2026-11-16T10:21:00Z', { kind: 'AMENDED', amendmentId: oc(4) }),
  toldAt(2, '2026-11-12T15:31:00Z', { kind: 'REQUEST', requestId: OC_REQUEST.id }),
  toldAt(3, '2026-11-12T16:00:00Z', { kind: 'WORK_ORDER_CHANGE', workOrderChangeId: WOC_APPLIED.id }, { at: '2026-11-12T16:00:00Z', workOrders: [{ id: WORK_ORDERS[0]!.id, number: WORK_ORDERS[0]!.number }], leftOut: 0 }),
  toldAt(4, '2026-11-11T09:00:00Z', { kind: 'LINES', change: 'CLOSED', lineIds: [LINE_RED] }),
  toldAt(5, '2026-11-11T12:00:00Z', { kind: 'LINES', change: 'REOPENED', lineIds: [LINE_RED] }),
  // A pause on a work order this reader does not reach: counted (`leftOut`), never named — the row says "a work order".
  toldAt(6, '2026-11-05T09:00:00Z', { kind: 'HOLD', hold: { placed: true, workOrder: null, leftOut: 1 } }, { at: '2026-11-05T09:00:00Z', workOrders: [], leftOut: 1 }),
  toldAt(7, '2026-11-05T15:00:00Z', { kind: 'HOLD', hold: { placed: false, workOrder: { id: WORK_ORDERS[0]!.id, number: WORK_ORDERS[0]!.number }, leftOut: 0 } }),
  toldAt(8, '2026-11-03T11:00:00Z', { kind: 'ECO', changeOrder: { number: 'ECO-2026-0004' } }),
]
const CANCELLED_TOLD = toldAt(9, '2026-11-17T09:00:00Z', { kind: 'CANCELLED' }, { at: '2026-11-17T09:00:00Z', workOrders: [], leftOut: 0 })

// Our confirmation: 3 versions made, 2 sent (B-OC-014), in the order's language.
const confirmationVersion = (n: number, sent: boolean) => ({ id: oc(830 + n), version: n, number: `SO-2026-0088 v${n}`, language: 'it', fileId: oc(840 + n), createdAt: `2026-11-${String(3 + 4 * n).padStart(2, '0')}T09:30:00Z`, createdBy: 'Bea Esempio', sent })
const OC_CONFIRMATION: Confirmation = {
  ...CONFIRMATION_SENT,
  sentAt: '2026-11-15T10:05:00Z',
  sentVersion: 3,
  upToDate: false,
  versions: [confirmationVersion(3, true), confirmationVersion(2, true), confirmationVersion(1, false)],
  sends: [
    { version: 3, at: '2026-11-15T10:05:00Z', to: ['ordini@moto-demo.example'], by: 'Bea Esempio' },
    { version: 2, at: '2026-11-11T10:00:00Z', to: ['ordini@moto-demo.example', 'acquisti@moto-demo.example'], by: 'Bea Esempio' },
  ],
}

// Waiting: the API's rows (B-OC-002 the revised order asked, B-OC-004 by when, L11 the refused revision, a portal task).
type Blocker = Headline['waiting']['blockers'][number]
const REVISED_ASKED: Blocker = { kind: 'APPROVAL', on: 'BRAND', words: { en: "Waiting for the customer's yes: Revised order", it: 'In attesa del sì del cliente: Ordine rivisto' }, since: '2026-11-16T10:22:00Z', ref: { type: 'ApprovalRequest', id: ASK_ID }, sub: null, due: '2026-11-16T16:00:00Z' /* 2 d late */ }
const PORTAL_TASK: Blocker = { kind: 'PARTNER_TASK', on: 'BRAND', words: { en: "An open task on the customer's portal", it: 'Un compito aperto nel portale del cliente' }, since: '2026-11-15T09:00:00Z', ref: { type: 'PartnerTask', id: oc(804) }, sub: null, due: '2026-11-23T16:00:00Z', task: { kind: 'RECONFIRM_ORDER', label: 'Re-confirm the revised order SO-2026-0088' } }
const REFUSED_REVISION: Blocker = { kind: 'REVISION_REFUSED', on: 'US', words: { en: 'The customer said no to revision 4', it: 'Il cliente ha detto no alla revisione 4' }, since: '2026-11-17T15:10:00Z', ref: { type: 'SalesOrderAmendment', id: oc(4) }, sub: null }
/** Still to do under revision 4 (B-OC-006): the work-order change (a planner's), the workshop told with it (B-OC-007), a new date. */
const ocStill = (planner: boolean): StillRow[] => [
  { kind: 'WORK_ORDER_CHANGE', ref: { type: 'WorkOrderChange', id: WOC_WAITS.id, number: RELEASED.number }, words: { en: `${RELEASED.number}: make 52 2 → 0`, it: `${RELEASED.number}: produci 52 2 → 0` }, since: '2026-11-16T10:21:00Z', waitingOn: 'PLANNER', mayAct: planner, requestId: null, amendmentId: oc(4), revision: 4 },
  { kind: 'TELL_WORKSHOP', ref: { type: 'SubcontractOrder', id: oc(870), number: 'SC-2026-0007' }, words: { en: `Tell the workshop of SC-2026-0007 when ${RELEASED.number} changes`, it: `Avvisa il laboratorio di SC-2026-0007 quando ${RELEASED.number} cambia` }, since: '2026-11-16T10:21:00Z', waitingOn: 'PLANNER', mayAct: false, requestId: null, amendmentId: oc(4), revision: 4, waitsOn: WOC_WAITS.id },
  { kind: 'REPROMISE', ref: { type: 'RePromise', id: oc(880), number: null }, words: { en: 'A new date from planning: 11/12 → 18/12', it: 'Una nuova data dalla pianificazione: 11/12 → 18/12' }, since: '2026-11-17T08:00:00Z', waitingOn: 'SALES', mayAct: !planner, requestId: null },
  ...RQ_STILL,
]
type Read = Parameters<typeof ready>[0]
const ocRead = (blockers: readonly Blocker[], planner = false): Read => {
  const rows = ocStill(planner)
  return {
    ...RQ_READ,
    headline: { ...RQ_READ.headline, waiting: { ...RQ_READ.headline.waiting, blockers: [...RQ_BLOCKERS.filter((row) => row.kind !== 'PARTNER_TASK'), ...blockers] } },
    changes: { ...RQ_READ.changes, stillToDo: { rows, count: rows.length, workOrdersLeftOut: 1 } },
  }
}

/** Nothing waits (a cancelled order). */
const QUIET_READ: Read = { ...RQ_READ, headline: { ...RQ_READ.headline, waiting: { ...RQ_READ.headline.waiting, on: 'US', since: null, blockers: [] } }, changes: { openRequests: [], stillToDo: { rows: [], count: 0, workOrdersLeftOut: 0 } } }

// Can it still change? (L3): every part still open while the floor has started.
const FREEZE_OPEN: Freeze = {
  ...FREEZE_CUT,
  order: { ...FREEZE_CUT.order, fields: FREEZE_CUT.order.fields.map((field) => ({ ...field, state: 'OPEN' as const })) },
  lines: FREEZE_CUT.lines.map((line) => ({ ...line, fields: line.fields.map((field) => ({ ...field, state: 'OPEN' as const })), sizes: line.sizes.map((size) => ({ ...size, locked: false, state: 'OPEN' as const })) })),
}
// The customer's yes on the quote: the signed PDF checked (B-OC-015).
const versionsChecked = (documentCheck: 'MATCHES' | 'PDF_MISSING') => ({ value: { ...VERSIONS, versions: VERSIONS.versions.map((entry) => (entry.acceptance ? { ...entry, acceptance: { ...entry.acceptance, documentMatches: documentCheck === 'MATCHES', documentCheck } } : entry)) }, problem: null })

/** Who reads the case: the demo roles, the Planner (decides work-order changes) and Read-only (no act anywhere). */
type Reader = Role | 'planner' | 'readOnly'
const READER_ROLE: Readonly<Record<Reader, Role>> = { owner: 'owner', sales: 'sales', manager: 'manager', finance: 'finance', planner: 'manager', readOnly: 'manager' }
interface OcWorld {
  readonly decision?: Decision
  readonly changes?: Changes
  readonly read?: Read
  readonly told?: readonly ToldChange[]
  readonly freeze?: Freeze
  readonly over?: Partial<OrderRecordModel>
}
/** One Changes tab, every part read: the waiting list, the changes read, our confirmation, the freeze, the work-order changes, the told read. */
function ocCase(reader: Reader, value: Order, world: OcWorld = {}): ChangesCase {
  const role = READER_ROLE[reader]
  const decision = world.decision ?? 'WAITING'
  const changes = world.changes ?? changesOf(rev4(decision), decision !== 'ACCEPTED')
  const made = base(role, value, {
    tab: 'changes',
    production: ready(world.read ?? ocRead(decision === 'WAITING' ? [REVISED_ASKED, PORTAL_TASK] : decision === 'REFUSED' ? [REFUSED_REVISION, PORTAL_TASK] : [PORTAL_TASK], reader === 'planner')),
    requests: { value: OC_REQUESTS, problem: null },
    askedOfCustomer: { value: RQ_ASKED, problem: null },
    orderChanges: { list: { value: OC_WOCS, problem: null }, review: null, busy: false },
    told: { value: { order: { id: ORDER_ID, number: 'SO-2026-0088' }, people: 4, changes: [...(world.told ?? OC_TOLD)] }, problem: null },
    depth: depthModel(role, { changes: { value: canOf(role).price ? changes : unpriced(changes), problem: null }, confirmation: { value: OC_CONFIRMATION, problem: null }, freeze: { value: world.freeze ?? FREEZE_CUT, problem: null } }),
    liveState: 'live',
    ...world.over,
  })
  if (reader === 'planner') return { ...made, record: { ...made.record, can: abilitiesOf(rolePermissions('planner')) } }
  if (reader === 'readOnly') return { ...made, record: { ...made.record, can: abilitiesOf(rolePermissions('read_only')) } }
  return made
}
const changed = production // amended: it waits for the customer's yes
const answered: Order = { ...production, reapprovalNeededAt: null }

const F_OC_T1: DesignCase<ChangesCase>[] = [
  // Waiting (10-design §3)
  { id: 'oc-waiting-sales', label: 'F-OC T.1 · Sales · Waiting: on us (the request, the agreed counter-offer, the problem → Production); on Moto Demo the revised order asked (by 16/11, 2 d late), the counter-offer that lapses 20/11, a portal task; Still to do under Revision 4 — the work-order change waits for a planner (the workshop told with it), a new date (Production ›), scrap, Mark done, the style', model: ocCase('sales', changed) },
  { id: 'oc-waiting-planner', label: 'F-OC T.1 · Planner · Waiting: Decide… on the work-order change (their turn), the others in words', model: ocCase('planner', changed) },
  { id: 'oc-waiting-refused', label: 'F-OC T.1 · Sales · L11: Moto Demo said no to revision 4 — Waiting on us "Open ›"; What changed: Customer said no, their words, Restore as before…', model: ocCase('sales', changed, { decision: 'REFUSED' }) },
  // What changed (10-design §5)
  { id: 'oc-history-owner', label: 'F-OC T.1 · Owner · What changed: revision 4 waits for their yes; the request done as revision 3 with its work-order change (told); revision 2 priced (fee + extra deposit, our yes, their yes by link); the PO; applied on a draft (the floor not told), declined, stale, a new draft made; lines closed / reopened; a pause on "a work order" and its lift; a style change released; 3 confirmations, 2 sends', model: ocCase('owner', changed) },
  { id: 'oc-history-sales', label: 'F-OC T.1 · Sales · the same without money: "Priced change", no fee, no amount', model: ocCase('sales', changed) },
  { id: 'oc-history-manager', label: 'F-OC T.1 · Production manager · What changed and Waiting without money; who decides in words', model: ocCase('manager', changed) },
  // The revision's yes (B-OC-011, B-OC-013, L5)
  { id: 'oc-yes-not-asked', label: 'F-OC T.1 · Sales · revision 4 never asked: Ask Moto Demo… on its row and in the Customer’s agreement', model: ocCase('sales', changed, { decision: 'NOT_ASKED' }) },
  { id: 'oc-yes-accepted', label: 'F-OC T.1 · Owner · Customer said yes in the portal (their words, who, when); the order waits for nobody', model: ocCase('owner', answered, { decision: 'ACCEPTED' }) },
  { id: 'oc-yes-expired', label: 'F-OC T.1 · Sales · No answer in time: Restore as before… offered (B-OC-013) and Ask Moto Demo… again', model: ocCase('sales', changed, { decision: 'EXPIRED' }) },
  // The customer's agreement (10-design §6)
  { id: 'oc-agreement-matches', label: 'F-OC T.1 · Owner · Their yes: the quote accepted by link, e-mail checked, the signed PDF matches; ours: v3 sent, 3 versions, 2 sends', model: ocCase('owner', answered, { decision: 'ACCEPTED', over: { versions: versionsChecked('MATCHES') } }) },
  { id: 'oc-agreement-pdf-missing', label: 'F-OC T.1 · Finance · Their yes: the signed PDF is missing (said in words); money read with the price grain', model: ocCase('finance', answered, { decision: 'ACCEPTED', over: { versions: versionsChecked('PDF_MISSING') } }) },
  { id: 'oc-agreement-portal', label: 'F-OC T.1 · Sales · An order placed in the portal (no quote): who placed it and when (B-OC-016); Open / Make / Send hidden without the price grain', model: ocCase('sales', { ...answered, chain: { ...answered.chain, quote: null, portalOrder: { id: oc(860), number: 'WEB-0012', sentAt: '2026-10-20T09:00:00Z', sentBy: 'Anna Alfa' } } }, { decision: 'ACCEPTED' }) },
  // Can it still change? (10-design §4, L3) — per state
  { id: 'oc-freeze-cancelled', label: 'F-OC T.1 · Sales · A cancelled order: nothing changes or is sent; What changed: Cancelled (told)', model: ocCase('sales', order('CANCELLED', { actions: [] }), { decision: 'ACCEPTED', read: QUIET_READ, told: [CANCELLED_TOLD, ...OC_TOLD] }) },
  { id: 'oc-freeze-partly-shipped', label: 'F-OC T.1 · Sales · Partly shipped: goods have left — no door to the lines', model: ocCase('sales', order('PARTLY_SHIPPED'), { decision: 'ACCEPTED' }) },
  { id: 'oc-freeze-first-yes', label: 'F-OC T.1 · Sales · Waiting for its first yes: nothing to change yet', model: ocCase('sales', order('CONFIRMED', { status: 'PENDING_APPROVAL' }), { decision: 'ACCEPTED' }) },
  { id: 'oc-freeze-old-approval', label: 'F-OC T.1 · Sales · Our approval of revision 4 waits: Change the lines › held, "See it ↑"', model: ocCase('sales', changed, { changes: changesOf(rev4('NOT_ASKED', { yes: { state: 'WAITING', taskId: oc(930), reason: null } }), true, { waitingForYes: { taskId: oc(930), since: '2026-11-16T10:21:00Z' } }) }) },
  { id: 'oc-freeze-all-open', label: 'F-OC T.1 · Sales · On the floor, every part still open: each part "Can change" (the address checked when the customer asks)', model: ocCase('sales', answered, { decision: 'ACCEPTED', freeze: FREEZE_OPEN }) },
  // Read-only (every section, no door)
  { id: 'oc-read-only', label: 'F-OC T.1 · Read-only · the whole tab with no act: no Decide…, Answer…, Ask…, Restore…, Change the lines › or Send', model: ocCase('readOnly', changed) },
]
// ---- end F-OC T.1

export const designScreen = defineDesignScreen<ChangesCase>({
  screen: 'SCR-107',
  title: 'Order changes: Waiting, Can it still change?, What changed, the customer’s agreement',
  view: ChangesDesign,
  cases: [
    // B-CP-011 (the money wall, Owner O1): the ONE "Seen as Sales" case here — no net without the price grain; the Owner's shows it.
    { id: 'list', label: 'Seen as Sales · Two amendments: one changed the lines (its net only for people who see prices), one the customer PO', model: view('sales'), note: '“Before → after” opens the frozen snapshot of that revision.' }, // B-CP-011
    { id: 'owner', label: 'Owner · The same amendments', model: view('owner') },
    { id: 'manager', label: 'Production manager · No money: lines and pieces only', model: view('manager') },
    { id: 'compare', label: 'Owner · Before → after of revision 1 (VersionCompare): sizes, unit price and net per line', model: view('owner', { dialog: { kind: 'compare', amendmentId: AMENDMENTS.amendments[0]!.id } }) }, // B-CP-011
    { id: 'compare-header', label: 'Sales · Before → after of revision 2: only the customer PO changed', model: view('sales', { dialog: { kind: 'compare', amendmentId: AMENDMENTS.amendments[1]!.id } }) },
    { id: 'compare-manager', label: 'Production manager · Before → after without prices (sizes only)', model: view('manager', { dialog: { kind: 'compare', amendmentId: AMENDMENTS.amendments[0]!.id } }) },
    // F-OC-303: the window opens while its snapshots are read (never an empty window), and says it when they cannot be read.
    { id: 'compare-reading', label: 'Owner · Before → after while the change is read', model: view('owner', { amendments: { value: null, problem: null }, dialog: { kind: 'compare', amendmentId: AMENDMENTS.amendments[0]!.id } }) },
    { id: 'compare-failed', label: 'Owner · Before → after: the change could not be read (Try again)', model: view('owner', { amendments: { value: null, problem: 'problem.read.unavailable' }, dialog: { kind: 'compare', amendmentId: AMENDMENTS.amendments[0]!.id } }) },
    { id: 'empty', label: 'Sales · No changes since confirmation', model: base('sales', order('CONFIRMED'), { tab: 'changes', amendments: { value: NO_AMENDMENTS, problem: null } }) },
    { id: 'empty-cancelled', label: 'Sales · A cancelled order that never changed', model: base('sales', order('CANCELLED', { actions: [] }), { tab: 'changes', amendments: { value: NO_AMENDMENTS, problem: null } }) },
    { id: 'loading', label: 'Reading the amendments', model: view('sales', { amendments: { value: null, problem: null } }) },
    { id: 'error', label: 'The amendments could not be read (in words, Try again)', model: view('sales', { amendments: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'no-permission', label: 'No permission: the API refused the order (orders.view)', model: view('sales', { order: { status: 'forbidden' } }) },
    ...F_OC_T1, // F-OC T.1: the states the seed lacks
  ],
})
