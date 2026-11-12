import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, listOf, NOW, PREFIX, ROWS, SITES, type RoleCase } from '../demo/fixtures'
import { emptyNewDraft, HOME_ADDRESS, type ListAddress, type TransferTile } from '../model'
import type { NewTransferModel } from './view/NewTransferDialog'
import { TransfersListView, type TransfersListModel } from './view/TransfersListView'

/**
 * SCR-360 — Warehouse › In the warehouse › Transfers (design warehouse.transfers, SCR-133), made-up data only: the tiles (In
 * transit, Arriving today, With differences) and the transfers on the shared list frame, each tile, a filter, rows
 * selected, New transfer (ready, held until the sites are chosen, the sending site's several transit places, refused in
 * our words), empty, filtered empty, loading, a failed read, offline, the keys, and the role cases (the warehouse ships and
 * receives; a buyer reads; sales has no page: the missing permission in words).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: TransfersListModel
}

function page(over: Partial<TransfersListModel> = {}, role: RoleCase = 'owner'): DesignModel {
  return {
    role,
    model: { prefix: PREFIX, can: canFor(role), address: HOME_ADDRESS, list: listOf(), problem: null, sites: SITES, asOf: NOW, live: 'live', updates: 0, notice: null, created: null, ...over },
  }
}

const at = (over: Partial<ListAddress>): ListAddress => ({ ...HOME_ADDRESS, ...over })
const tile = (id: TransferTile, rows: typeof ROWS): Partial<TransfersListModel> => ({ address: at({ tile: id }), list: listOf(rows) })

const NEW_READY: NewTransferModel = {
  draft: { ...emptyNewDraft(SITES[0]!.id), toSiteId: SITES[2]!.id, transitLocationId: SITES[0]!.transitPlaces[0]!.id, fromLocationId: SITES[0]!.places[1]!.id, toLocationId: SITES[2]!.places[0]!.id, shipOn: '2026-11-13', expectedOn: '2026-11-14', note: 'Lining and leather for the workshop (demo).' },
  sites: SITES,
  busy: false,
  notice: null,
  lines: [],
  offline: false,
}

function ListDesign({ model }: { model: DesignModel }) {
  const [state, setState] = useState(model.model)
  useEffect(() => setState(model.model), [model])
  const view = createElement(TransfersListView, {
    model: state,
    actions: {
      onAddress: (patch) => setState((now) => ({ ...now, address: { ...now.address, ...patch } })),
      onClearFilters: () => setState((now) => ({ ...now, address: HOME_ADDRESS })),
      onNew: () => setState((now) => ({ ...now, created: { ...NEW_READY, draft: emptyNewDraft(SITES[0]!.id) } })),
      created: {
        onClose: () => setState((now) => ({ ...now, created: null })),
        onSubmit: () => setState((now) => ({ ...now, created: null })),
        onDraft: (patch) => setState((now) => (now.created ? { ...now, created: { ...now.created, draft: { ...now.created.draft, ...patch } } } : now)),
      },
      onDismissNotice: () => setState((now) => ({ ...now, notice: null })),
    },
  })
  return inShell('/warehouse/transfers', view, model.role)
}

const inTransit = ROWS.filter((one) => one.status === 'SHIPPED' || one.status === 'PARTLY_RECEIVED')

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-360',
  title: 'Transfers',
  view: ListDesign,
  holdsPage: true,
  cases: [
    { id: 'list', label: 'Transfers between sites: number, from, to, status, lines, ship date, expected arrival, DDT, differences', model: page(), note: 'A late one says so; a transfer between two companies says so under its number.' },
    { id: 'tile-in-transit', label: 'Tile: In transit', model: page(tile('IN_TRANSIT', inTransit)) },
    { id: 'tile-arriving', label: 'Tile: Arriving today', model: page(tile('ARRIVING_TODAY', inTransit.filter((one) => one.expectedOn === '2026-11-12'))) },
    { id: 'tile-differences', label: 'Tile: With differences (not settled yet)', model: page(tile('WITH_DIFFERENCES', ROWS.filter((one) => one.differences > 0))) },
    { id: 'filter-to', label: 'Filtered to one receiving plant', model: page({ address: at({ to: SITES[1]!.id }), list: listOf(ROWS.filter((one) => one.to.id === SITES[1]!.id)) }) },
    { id: 'selected', label: 'Two rows selected (Copy 2 numbers)', model: page({ selected: [ROWS[1]!.id, ROWS[2]!.id] }) },
    { id: 'new', label: 'New transfer: from, to (another company: said), ship date, expected arrival, the places', model: page({ created: NEW_READY }) },
    { id: 'new-held', label: 'New transfer held until the receiving site is chosen', model: page({ created: { ...NEW_READY, draft: { ...emptyNewDraft(SITES[0]!.id) } } }) },
    { id: 'new-transit', label: 'New transfer: the sending site has two transit places (pick the route’s)', model: page({ created: { ...NEW_READY, draft: { ...NEW_READY.draft, transitLocationId: null } } }) },
    { id: 'new-refused', label: 'New transfer refused by the factory (our words for its code)', model: page({ created: { ...NEW_READY, notice: { key: 'refusal.NO_TRANSFER_SERIES', tone: 'danger' } } }) },
    { id: 'new-reading', label: 'New transfer while the sites are read', model: page({ created: { ...NEW_READY, sites: null } }) },
    { id: 'updates', label: '3 changes waiting (Show)', model: page({ updates: 3 }) },
    { id: 'filtered-empty', label: 'No rows match these filters', model: page({ address: at({ status: 'CANCELLED', q: 'zzz' }), list: listOf([]) }) },
    { id: 'empty', label: 'No transfers yet (New transfer)', model: page({ list: { ...listOf([]), counts: { IN_TRANSIT: 0, ARRIVING_TODAY: 0, WITH_DIFFERENCES: 0, ALL: 0 } } }) },
    { id: 'loading', label: 'Loading', model: page({ list: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'Couldn’t load the transfers (Try again)', model: page({ list: null, problem: 'problem.unavailable' }) },
    { id: 'offline', label: 'Offline: as last read, New transfer held with the reason', model: page({ live: 'offline' }) },
    { id: 'more', label: 'More than 200 transfers (the first 200; narrow the filters)', model: page({ list: listOf(ROWS, false) }) },
    { id: 'keys', label: 'The keys in the footer icon', model: page({ keysOpen: true }) },
    { id: 'warehouse', label: 'Warehouse: ships, receives, settles', model: page({}, 'warehouse') },
    { id: 'buyer', label: 'Buyer: reads the transfers, New transfer held (no right)', model: page({}, 'buyer') },
    { id: 'no-permission', label: 'Sales: no access (the missing permission in words)', model: page({}, 'sales') },
  ],
})
