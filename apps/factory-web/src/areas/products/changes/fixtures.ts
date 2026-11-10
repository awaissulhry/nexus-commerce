import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { canFor, COMPARE, CUSTOMERS, DRIFT, inShell, JACKET_DETAIL, ME, MINUTES, NOW, ORDER, ORDERS, PREFIX, readOf, RELEASED, REQUEST, REQUESTS, ROUNDS, SMV, STYLE_OPTIONS, type RoleCase } from './demo/fixtures'
import { emptyNewOrder, emptyNewRequest, HOME_ADDRESS, rowOfOrder, rowOfRequest, rowOfSmv, rowsOf, type ListAddress } from './model'
import { ChangesListView, type ChangesListModel } from './view/ChangesListView'
import type { DecideModel } from './view/DecideDialog'
import type { NewOrderModel } from './view/NewOrderDialog'
import type { NewRequestModel } from './view/NewRequestDialog'

/**
 * SCR-117 — Changes & versions (design products.changes, a workspace list), made-up data only: the changes (requests,
 * change orders, SMV changes waiting) with each tile, rows selected, the notices, Released versions, New change request
 * (ready, held, refused, from a sample round), New change order, Approve change (a change order's redline and impact, a
 * request's triage, an SMV change, held with the reason, refused, reading), the receipts, empty, filtered empty, loading,
 * failed reads, offline, and the role cases (production manager, quality, sales, planner, warehouse with no access).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: ChangesListModel
}

function page(over: Partial<ChangesListModel> = {}, role: RoleCase = 'owner'): DesignModel {
  return {
    role,
    model: {
      prefix: PREFIX,
      me: ME,
      can: canFor(role),
      address: HOME_ADDRESS,
      read: readOf(),
      problem: null,
      released: null,
      releasedProblem: null,
      asOf: NOW,
      live: 'live',
      updates: 0,
      notice: null,
      dismissed: [],
      newRequest: null,
      newOrder: null,
      decide: null,
      ...over,
    },
  }
}

const at = (over: Partial<ListAddress>): ListAddress => ({ ...HOME_ADDRESS, ...over })
const released = (over: Partial<ChangesListModel> = {}, role: RoleCase = 'owner') => page({ address: at({ view: 'released' }), released: RELEASED, ...over }, role)

const NEW_REQUEST: NewRequestModel = {
  draft: { ...emptyNewRequest(JACKET_DETAIL.id), source: 'CUSTOMER', partyId: CUSTOMERS[0]!.id, priority: 'HIGH', title: 'Reflective piping on the back yoke', reason: 'The brand asks for reflective piping across the back yoke from the spring order.' },
  styles: { q: '', items: STYLE_OPTIONS, problem: null },
  style: { item: JACKET_DETAIL, reading: false, problem: null },
  parties: { items: CUSTOMERS, problem: null },
  rounds: null,
  busy: false,
  notice: null,
  lines: [],
  offline: false,
}

const NEW_ORDER: NewOrderModel = {
  draft: { ...emptyNewOrder(JACKET_DETAIL.id, [REQUESTS[1]!.id]), title: 'Back yoke piping', reason: 'The brand’s accepted request for the spring order.', priority: 'HIGH' },
  styles: { q: '', items: STYLE_OPTIONS, problem: null },
  style: { item: JACKET_DETAIL, reading: false, problem: null },
  requests: { items: REQUESTS.filter((one) => one.style.id === JACKET_DETAIL.id), problem: null },
  busy: false,
  notice: null,
  lines: [],
  offline: false,
}

const ids = rowsOf(readOf(), HOME_ADDRESS).map((row) => row.id)
const DECIDE_ORDER: DecideModel = {
  row: rowOfOrder(ORDER),
  ids,
  reading: false,
  problem: null,
  order: ORDER,
  request: null,
  minutes: null,
  redline: { compare: COMPARE, problem: null },
  drift: { value: DRIFT, problem: null },
  holds: {},
  reason: '',
  busy: false,
  notice: null,
  offline: false,
}
const DECIDE_REQUEST: DecideModel = { ...DECIDE_ORDER, row: rowOfRequest(REQUEST), order: null, request: REQUEST, redline: null, drift: null }
const DECIDE_SMV: DecideModel = { ...DECIDE_ORDER, row: rowOfSmv(SMV[0]!), order: null, minutes: MINUTES, redline: null, drift: null }

function ListDesign({ model }: { model: DesignModel }) {
  const [state, setState] = useState(model.model)
  useEffect(() => setState(model.model), [model])
  const view = createElement(ChangesListView, {
    model: state,
    actions: {
      onAddress: (patch) => setState((now) => ({ ...now, address: { ...now.address, ...patch }, released: patch.view === 'released' ? RELEASED : now.released })),
      onClearFilters: () => setState((now) => ({ ...now, address: { ...HOME_ADDRESS, view: now.address.view } })),
      onNew: () => setState((now) => ({ ...now, newRequest: { ...NEW_REQUEST, draft: emptyNewRequest(), style: { item: null, reading: false, problem: null }, parties: null } })),
      onNewOrder: () => setState((now) => ({ ...now, newOrder: NEW_ORDER })),
      newRequest: {
        onClose: () => setState((now) => ({ ...now, newRequest: null })),
        onSubmit: () => setState((now) => ({ ...now, newRequest: null })),
        onDraft: (patch) => setState((now) => (now.newRequest ? { ...now, newRequest: { ...now.newRequest, draft: { ...now.newRequest.draft, ...patch }, parties: patch.source === 'CUSTOMER' ? { items: CUSTOMERS, problem: null } : now.newRequest.parties, rounds: patch.source === 'SAMPLE' ? { items: ROUNDS, problem: null } : now.newRequest.rounds } } : now)),
        onPickStyle: (styleId) => setState((now) => (now.newRequest ? { ...now, newRequest: { ...now.newRequest, draft: { ...now.newRequest.draft, styleId }, style: { item: styleId === JACKET_DETAIL.id ? JACKET_DETAIL : null, reading: false, problem: null } } } : now)),
      },
      newOrder: {
        onClose: () => setState((now) => ({ ...now, newOrder: null })),
        onSubmit: () => setState((now) => ({ ...now, newOrder: null })),
        onDraft: (patch) => setState((now) => (now.newOrder ? { ...now, newOrder: { ...now.newOrder, draft: { ...now.newOrder.draft, ...patch } } } : now)),
      },
      onDecide: (row) => setState((now) => ({ ...now, decide: row.kind === 'order' ? DECIDE_ORDER : row.kind === 'request' ? { ...DECIDE_REQUEST, row } : DECIDE_SMV })),
      decide: {
        onClose: () => setState((now) => ({ ...now, decide: null })),
        onDecide: () => setState((now) => ({ ...now, decide: null, notice: { key: 'decide.doneApproved', params: { number: ORDER.number }, tone: 'success' } })),
        onReason: (reason) => setState((now) => (now.decide ? { ...now, decide: { ...now.decide, reason } } : now)),
      },
      onDismissNotice: () => setState((now) => ({ ...now, notice: null })),
      onDismissPageNotice: (id) => setState((now) => ({ ...now, dismissed: [...now.dismissed, id] })),
    },
  })
  return inShell('/products/changes', view, model.role)
}

const triage = REQUESTS.filter((one) => one.status === 'OPEN' || one.status === 'IN_REVIEW')
const read = (over: Parameters<typeof readOf>) => readOf(...over)

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-117',
  title: 'Changes & versions',
  view: ListDesign,
  holdsPage: true,
  cases: [
    { id: 'changes', label: 'Changes: requests, change orders and SMV changes as one list (kind, title, styles, raised by, reason, status, approvals "1 of 2", effective date, priority)', model: page(), note: 'A tile puts its saved row in the filter; ⋯ on a row: Open, Approve, Reject.' },
    { id: 'tile-triage', label: 'Tile: New requests to triage (most urgent first)', model: page({ address: at({ tile: 'TO_TRIAGE' }), read: read([triage, [], null]) }) },
    { id: 'tile-mine', label: 'Tile: Waiting for my approval (a change order and an SMV change)', model: page({ address: at({ tile: 'MINE_TO_APPROVE' }), read: read([[], [ORDERS[0]!], SMV]) }) },
    { id: 'tile-release', label: 'Tile: Approved — to release', model: page({ address: at({ tile: 'TO_RELEASE' }), read: read([[], [ORDERS[3]!], null]) }) },
    { id: 'tile-released', label: 'Tile: Released this month', model: page({ address: at({ tile: 'RELEASED_THIS_MONTH' }), read: read([[], [ORDERS[2]!], null]) }) },
    { id: 'selected', label: 'Two rows selected (Approve… held: pick one; Copy 2 numbers; Export 2)', model: page({ selected: [rowOfOrder(ORDERS[0]!).id, rowOfRequest(REQUESTS[1]!).id] }) },
    { id: 'style', label: "A style's changes (the Style studio's link): its chip, the SMV notice", model: page({ address: at({ style: JACKET_DETAIL.id }), read: read([REQUESTS.filter((one) => one.style.id === JACKET_DETAIL.id), ORDERS.filter((one) => one.style.id === JACKET_DETAIL.id), SMV]) }) },
    { id: 'notices', label: 'Notices: the most serious first, the rest behind "2 more notices" (opened)', model: page({ address: at({ style: JACKET_DETAIL.id }), read: { ...read([REQUESTS, ORDERS, SMV, false]), smvFailed: true }, allNotices: true }) },
    { id: 'released', label: 'Released versions: style, revision old → new, released by and when, what changed, the change order', model: released() },
    { id: 'released-empty', label: 'Released versions: none yet', model: released({ released: { rows: [], complete: true } }) },
    { id: 'released-error', label: "Released versions: couldn't load (Try again)", model: released({ released: null, releasedProblem: 'problem.unavailable' }) },
    { id: 'new', label: 'New change request: style, revision, asked by a customer, priority, what and why, photos', model: page({ newRequest: NEW_REQUEST }) },
    { id: 'new-empty', label: 'New change request: held until a style is chosen', model: page({ newRequest: { ...NEW_REQUEST, draft: emptyNewRequest(), style: { item: null, reading: false, problem: null }, parties: null } }) },
    { id: 'new-sample', label: 'New change request from a sample round (the round of the style)', model: page({ newRequest: { ...NEW_REQUEST, draft: { ...NEW_REQUEST.draft, source: 'SAMPLE', partyId: null, sampleRoundId: ROUNDS[0]!.id }, parties: null, rounds: { items: ROUNDS, problem: null } } }) },
    { id: 'new-refused', label: 'New change request refused (our words; the field named)', model: page({ newRequest: { ...NEW_REQUEST, notice: { key: 'problem.invalid', tone: 'danger' }, lines: [{ key: 'field.partyId' }] } }) },
    { id: 'new-order', label: 'New change order: from the released revision, the requests it carries', model: page({ newOrder: NEW_ORDER }) },
    { id: 'new-order-date', label: 'New change order from a date: held until the day is given', model: page({ newOrder: { ...NEW_ORDER, draft: { ...NEW_ORDER.draft, effect: 'DATE', effectiveDate: '' } } }) },
    { id: 'decide', label: 'Approve change: a change order — the redline (BOM, routing), the work in progress, quotes on an older revision', model: page({ decide: DECIDE_ORDER }), note: 'A approves, R rejects (the why takes the focus), J / K the next and previous change.' },
    { id: 'decide-request', label: 'Approve change: a request from the floor — accept, reject or into review', model: page({ decide: DECIDE_REQUEST }) },
    { id: 'decide-smv', label: 'Approve change: an SMV change — old → new minutes, the routings it reaches', model: page({ decide: DECIDE_SMV }) },
    { id: 'decide-held', label: 'Approve change held: you wrote this change order (four eyes)', model: page({ decide: { ...DECIDE_ORDER, holds: { APPROVED: { key: 'refusal.OWN_APPROVAL' }, REJECTED: { key: 'refusal.OWN_APPROVAL' } } } }) },
    { id: 'decide-reject', label: 'Approve change: Reject held until the why is written', model: page({ decide: { ...DECIDE_ORDER, reason: '' } }) },
    { id: 'decide-refused', label: 'Approve change refused by the factory (our words for its code)', model: page({ decide: { ...DECIDE_ORDER, reason: 'Collar change not tested on size 56.', notice: { key: 'refusal.ALREADY_DECIDED', tone: 'danger' } } }) },
    { id: 'decide-reading', label: 'Approve change: the record being read', model: page({ decide: { ...DECIDE_ORDER, reading: true } }) },
    { id: 'decided', label: 'Decided (the receipt)', model: page({ notice: { key: 'decide.doneApproved', params: { number: ORDER.number }, tone: 'success' } }) },
    { id: 'updates', label: 'The list with 3 changes waiting (Show)', model: page({ updates: 3 }) },
    { id: 'filtered-empty', label: 'No rows match these filters', model: page({ address: at({ kind: 'order', q: 'zzz' }), read: read([[], [], null]) }) },
    { id: 'empty', label: 'No changes yet (New change request)', model: page({ read: { ...read([[], [], []]), requests: { rows: [], counts: { TO_TRIAGE: 0, ACCEPTED_FREE: 0, MINE: 0, ALL: 0 }, complete: true }, orders: { rows: [], counts: { MINE_TO_APPROVE: 0, TO_RELEASE: 0, RELEASED_THIS_MONTH: 0, OPEN: 0, ALL: 0 }, complete: true } } }) },
    { id: 'loading', label: 'Loading (tile skeletons say —)', model: page({ read: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "Couldn't load changes (Try again); the tiles say —", model: page({ read: null, problem: 'problem.unavailable' }) },
    { id: 'offline', label: 'Offline: the changes as last read, every act held', model: page({ live: 'offline' }) },
    { id: 'keys', label: 'The keys in the footer icon', model: page({ keysOpen: true }) },
    { id: 'production', label: 'Production manager: writes, triages, approves, releases', model: page({}, 'production') },
    { id: 'quality', label: 'Quality inspector: raises and approves; no triage, no change order', model: page({}, 'quality') },
    { id: 'sales', label: 'Sales: raises requests and reads; no SMV changes (the notice says why)', model: page({}, 'sales') },
    { id: 'planner', label: 'Planner: reads and raises requests; every decision held with the reason', model: page({}, 'planner') },
    { id: 'no-permission', label: 'Warehouse: no access (the page is not in the overlay)', model: page({}, 'warehouse') },
  ],
})
