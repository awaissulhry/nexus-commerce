import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { ProfileRow, Tiles } from '../api'
import { canFor, COMPANY_ID, CUSTOMERS, inShell, ME, NOW, PREFIX, ROWS, TEMPLATES_ONE_ON, TILES_DATA, type RoleCase } from '../demo/fixtures'
import { HOME_ADDRESS, type ListAddress } from '../model'
import type { MtmListModel } from '../view-model'
import { MtmListView } from '../view/MtmListView'

/**
 * SCR-036-list-filters — Sales › Made-to-measure's filters beyond the review (B-W2b-371, XF2:03; design mtm.tiles "Outside the
 * certified range", "Fittings this week", savedRows "Outside range", "By customer", Export ▾) with made-up riders and customers
 * only: the tiles' counts as riders (outside known, or "—" while no unit's range is known), the Inside certified range column
 * (inside, outside with its points, not checked), the Outside tile pressed, the Fittings tile pressed, one customer chosen (its chip
 * by name), the customer picker, nothing outside, a role that reads no customers (no picker). In the browser the tiles, chips and the
 * customer picker work for real; Export ▾ comes with the Office's list tools (none in the design index).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: MtmListModel
}

const ranged: ProfileRow[] = ROWS.map((row, index) => ({
  ...row,
  range: index === 0 ? { inside: false, points: ['chest', 'sleeve'] } : index === 1 ? { inside: true, points: [] } : index === 2 ? { inside: false, points: [] } : { inside: null, points: [] },
  nextFittingAt: index % 2 === 0 ? '2026-11-14T09:00:00.000Z' : row.nextFittingAt,
}))
const TILES_KNOWN: Tiles = { ...TILES_DATA, outsideRange: 2 }
const at = (address: Partial<ListAddress>): ListAddress => ({ ...HOME_ADDRESS, ...address })
const list = (over: Partial<MtmListModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  role,
  model: {
    prefix: PREFIX,
    me: ME,
    companyId: COMPANY_ID,
    can: canFor(role),
    address: HOME_ADDRESS,
    rows: { items: ranged, more: false, problem: null, matching: ranged.length },
    tiles: TILES_KNOWN,
    tilesFailed: false,
    templates: TEMPLATES_ONE_ON,
    asOf: NOW,
    live: 'live',
    updates: 0,
    notice: null,
    measurements: null,
    link: null,
    quote: null,
    customers: CUSTOMERS,
    ...over,
  },
})
const only = (keep: (row: ProfileRow) => boolean) => ({ items: ranged.filter(keep), more: false, problem: null, matching: ranged.filter(keep).length })

function FiltersDesign({ model: design }: { model: DesignModel }) {
  const [address, setAddress] = useState(design.model.address)
  useEffect(() => setAddress(design.model.address), [design])
  const keep = (row: ProfileRow) => (address.view === 'outside' ? row.range.inside === false : address.view === 'fittings' ? row.nextFittingAt !== null : true) && (address.customer ? row.partyId === address.customer : true)
  const items = address === design.model.address ? design.model.rows.items : ranged.filter(keep)
  return inShell('/sales/made-to-measure', createElement(MtmListView, { model: { ...design.model, address, rows: { ...design.model.rows, items } }, actions: { onAddress: (patch) => setAddress((current) => ({ ...current, ...patch })), onClearFilters: () => setAddress(HOME_ADDRESS) } }), design.role)
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-036-list-filters',
  title: 'Made-to-measure › Outside the certified range, fittings this week, by customer, export',
  view: FiltersDesign,
  cases: [
    { id: 'ranges', label: 'The list: the range of each rider (outside with its points, inside, outside, not checked); the tiles count riders', model: list() },
    { id: 'outside', label: 'Tile pressed: Outside the certified range (the riders whose newest measures fall out)', model: list({ address: at({ view: 'outside' }), rows: only((row) => row.range.inside === false) }) },
    { id: 'fittings', label: 'Tile pressed: Fittings this week (the riders with a fitting booked or done this week)', model: list({ address: at({ view: 'fittings' }), rows: only((row) => row.nextFittingAt !== null) }) },
    { id: 'customer', label: 'One customer chosen: its chip by name, the picker on it', model: list({ address: at({ customer: CUSTOMERS[0]!.id }), rows: only((row) => row.partyId === CUSTOMERS[0]!.id) }) },
    { id: 'unknown', label: 'Made-to-measure off everywhere: the Outside tile says "—" (not known, never 0), every range "Not checked"', model: list({ tiles: TILES_DATA, rows: { items: ROWS, more: false, problem: null, matching: ROWS.length } }) },
    { id: 'outside-none', label: 'Outside pressed, none outside: Clear filters', model: list({ address: at({ view: 'outside' }), rows: { items: [], more: false, problem: null, matching: 0 }, tiles: { ...TILES_KNOWN, outsideRange: 0 } }) },
    { id: 'no-customers', label: 'A role that reads no customers: no customer picker (the rest as usual)', model: list({ customers: null }, 'production') },
  ],
})
