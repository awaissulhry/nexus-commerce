import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { canFor, CUSTOMERS, inShell, JACKET_DETAIL, listOf, ME, NOW, PREFIX, ROWS, STYLE_OPTIONS, TODAY, type RoleCase } from './demo/fixtures'
import { ANY_COLOUR, emptyNewDraft, HOME_ADDRESS, type ListAddress, type RoundTile } from './model'
import type { DecideModel } from './view/DecideDialog'
import type { NewRoundModel } from './view/NewRoundDialog'
import { SamplesListView, type SamplesListModel } from './view/SamplesListView'

/**
 * SCR-110 — Samples & prototypes (design products.samples, a board), made-up data only: the board (the design's page),
 * the list and the calendar over the same rounds and filters, each tile, a style's rounds pinned to a revision, rows
 * selected, New sample request (a style chosen with its sizes and colours, held, refused), Decide on the sample (ready,
 * held while the customer is asked, comments missing), the receipts, empty, filtered empty, loading, a failed read,
 * offline, and the role cases (sales, the production manager, the planner reading, the warehouse with no access).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: SamplesListModel
}

function page(over: Partial<SamplesListModel> = {}, role: RoleCase = 'owner'): DesignModel {
  return {
    role,
    model: {
      prefix: PREFIX,
      me: ME,
      today: TODAY,
      can: canFor(role),
      address: HOME_ADDRESS,
      list: listOf(),
      problem: null,
      customers: CUSTOMERS,
      asOf: NOW,
      live: 'live',
      updates: 0,
      notice: null,
      moving: null,
      newRound: null,
      decide: null,
      ...over,
    },
  }
}

const at = (over: Partial<ListAddress>): ListAddress => ({ ...HOME_ADDRESS, ...over })
const tile = (id: RoundTile, rows: typeof ROWS): Partial<SamplesListModel> => ({ address: at({ tile: id }), list: listOf(rows) })

const NEW_READY: NewRoundModel = {
  draft: { ...emptyNewDraft(JACKET_DETAIL.id), kind: 'FIT', partyId: CUSTOMERS[0]!.id, dueDate: '2026-11-20', charge: '95', grid: { [JACKET_DETAIL.colourways[0]!.id]: { '52': 2, '54': 1 }, [ANY_COLOUR]: { '50': 1 } }, instructions: 'Check the elbow armour pocket with the CE protector in.' },
  styles: { q: '', items: STYLE_OPTIONS, problem: null },
  style: { item: JACKET_DETAIL, reading: false, problem: null },
  customers: { items: CUSTOMERS, problem: null },
  busy: false,
  notice: null,
  lines: [],
  offline: false,
}

const DECIDE: DecideModel = {
  subject: 'round',
  id: ROWS[2]!.id,
  name: { key: 'decide.subject', params: { number: ROWS[2]!.number, kind: 'kind.FIT', n: 2 } },
  revision: 1,
  blocked: null,
  reading: false,
  problem: null,
  draft: { decision: 'APPROVED_WITH_COMMENTS', comments: 'Approved; shorten the sleeve by 1 cm in production.' },
  busy: false,
  notice: null,
  offline: false,
}

function ListDesign({ model }: { model: DesignModel }) {
  const [state, setState] = useState(model.model)
  useEffect(() => setState(model.model), [model])
  const view = createElement(SamplesListView, {
    model: state,
    actions: {
      onAddress: (patch) => setState((now) => ({ ...now, address: { ...now.address, ...patch } })),
      onClearFilters: () => setState((now) => ({ ...now, address: { ...HOME_ADDRESS, mode: now.address.mode } })),
      onNew: () => setState((now) => ({ ...now, newRound: { ...NEW_READY, draft: emptyNewDraft(), style: { item: null, reading: false, problem: null } } })),
      newRound: {
        onClose: () => setState((now) => ({ ...now, newRound: null })),
        onSubmit: () => setState((now) => ({ ...now, newRound: null })),
        onDraft: (patch) => setState((now) => (now.newRound ? { ...now, newRound: { ...now.newRound, draft: { ...now.newRound.draft, ...patch } } } : now)),
        onPickStyle: (styleId) => setState((now) => (now.newRound ? { ...now, newRound: { ...now.newRound, draft: { ...now.newRound.draft, styleId }, style: { item: styleId === JACKET_DETAIL.id ? JACKET_DETAIL : null, reading: false, problem: null } } } : now)),
      },
      onMove: async () => false,
      onDecide: (row) => setState((now) => ({ ...now, decide: { ...DECIDE, id: row.id, name: { key: 'decide.subject', params: { number: row.number, kind: `kind.${row.kind}`, n: row.roundNo } }, draft: { decision: null, comments: '' } } })),
      decide: {
        onClose: () => setState((now) => ({ ...now, decide: null })),
        onSubmit: () => setState((now) => ({ ...now, decide: null })),
        onDraft: (patch) => setState((now) => (now.decide ? { ...now, decide: { ...now.decide, draft: { ...now.decide.draft, ...patch } } } : now)),
      },
      onDismissNotice: () => setState((now) => ({ ...now, notice: null })),
    },
  })
  return inShell('/products/samples', view, model.role)
}

const late = ROWS.filter((one) => one.daysLate !== null)

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-110',
  title: 'Samples & prototypes',
  view: ListDesign,
  holdsPage: true,
  cases: [
    { id: 'board', label: 'The board: every round by stage (Requested … Decided), due words, Decide… on the cards that wait', model: page(), note: 'Drag a card, or focus it and press M; Decided only by its decision (d). A cancelled round is in the list only.' },
    { id: 'list', label: 'The list: the same rounds as rows (number, style, type, round, customer, revision, stage, due, decision, owner)', model: page({ address: at({ mode: 'table' }) }) },
    { id: 'list-selected', label: 'The list with two rows selected (Copy 2 numbers, Export 2)', model: page({ address: at({ mode: 'table' }), selected: [ROWS[1]!.id, ROWS[2]!.id] }) },
    { id: 'calendar', label: 'The calendar by due day (read only), 14 November open', model: page({ address: at({ mode: 'calendar' }), day: '2026-11-14' }) },
    { id: 'tile-late', label: 'Tile: Late', model: page(tile('LATE', late)) },
    { id: 'tile-waiting', label: "Tile: Waiting for the customer's decision", model: page(tile('WAITING_DECISION', [ROWS[2]!])) },
    { id: 'style-revision', label: "A style's rounds pinned to a revision (the Style studio's link)", model: page({ address: at({ style: ROWS[2]!.style.id, revision: ROWS[2]!.revision.id }), list: listOf(ROWS.filter((one) => one.style.id === ROWS[2]!.style.id && one.revision.id === ROWS[2]!.revision.id)) }) },
    { id: 'new', label: 'New sample request: style, latest revision, type, customer, due, charge, sizes and colours', model: page({ newRound: NEW_READY }) },
    { id: 'new-empty', label: 'New sample request: held until a style is chosen', model: page({ newRound: { ...NEW_READY, draft: emptyNewDraft(), style: { item: null, reading: false, problem: null } } }) },
    { id: 'new-refused', label: 'New sample request refused (our words; the field named)', model: page({ newRound: { ...NEW_READY, notice: { key: 'problem.invalid', tone: 'danger' }, lines: [{ key: 'field.cells' }] } }) },
    { id: 'new-no-price', label: 'New sample request for the production manager (no price grain: no charge)', model: page({ newRound: { ...NEW_READY, draft: { ...NEW_READY.draft, charge: '' } } }, 'production') },
    { id: 'decide', label: 'Decide on the sample: approved with comments, on revision 1', model: page({ decide: DECIDE }) },
    { id: 'decide-held', label: 'Decide: rejected without the why (held)', model: page({ decide: { ...DECIDE, draft: { decision: 'REJECTED', comments: '' } } }) },
    { id: 'decide-asked', label: 'Decide held: the customer was asked and has not answered', model: page({ decide: { ...DECIDE, blocked: { key: 'refusal.BRAND_ASKED' }, draft: { decision: null, comments: '' } } }) },
    { id: 'decide-reading', label: "Decide: the round's approval being read", model: page({ decide: { ...DECIDE, reading: true } }) },
    { id: 'moved', label: 'A card moved (the receipt)', model: page({ notice: { key: 'board.moved', params: { number: ROWS[0]!.number, stage: 'stage.IN_MAKING' }, tone: 'success' } }) },
    { id: 'move-refused', label: 'A move refused by the factory (our words for its code)', model: page({ notice: { key: 'refusal.ROUND_CLOSED', tone: 'danger' } }) },
    { id: 'updates', label: 'The list with 3 changes waiting (Show)', model: page({ address: at({ mode: 'table' }), updates: 3 }) },
    { id: 'filtered-empty', label: 'No rows match these filters', model: page({ address: at({ kind: 'BRAND', q: 'zzz' }), list: listOf([]) }) },
    { id: 'empty', label: 'No sample rounds yet (New sample request)', model: page({ list: { ...listOf([]), counts: { OPEN: 0, DUE_THIS_WEEK: 0, LATE: 0, WAITING_DECISION: 0, REJECTED_THIS_MONTH: 0, ALL: 0 } } }) },
    { id: 'loading', label: 'Loading', model: page({ list: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "Couldn't load sample rounds (Try again)", model: page({ list: null, problem: 'problem.unavailable' }) },
    { id: 'offline', label: 'Offline: the rounds as last read, every move held', model: page({ live: 'offline' }) },
    { id: 'more', label: 'More than 200 rounds (the first 200; narrow the filters)', model: page({ address: at({ mode: 'table' }), list: listOf(ROWS, false) }) },
    { id: 'keys', label: 'The keys in the footer icon', model: page({ address: at({ mode: 'table' }), keysOpen: true }) },
    { id: 'sales', label: 'Sales: asks, decides, ships (no work order: production makes it)', model: page({}, 'sales') },
    { id: 'production', label: 'Production manager: makes, measures, decides', model: page({}, 'production') },
    { id: 'planner', label: 'Planner: reads the board, moves nothing (held with the reason)', model: page({}, 'planner') },
    { id: 'no-permission', label: "Warehouse: no access (the page is not in the overlay)", model: page({}, 'warehouse') },
  ],
})
