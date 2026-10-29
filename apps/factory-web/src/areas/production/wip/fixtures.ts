import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, canOf, COUNTS, inShell, LIST_ROWS, PREFIX, SITE_WIP, type Role } from '../_shared/fixtures'
import { FloorNowView, type FloorNowModel } from './view/FloorNowView'

/**
 * SCR-073 — Floor now (design production.floor; MES-167, MES-305) with made-up data only: the tiles, every open work
 * order with its operations (waiting · done; the operation with the most waiting marked in words), the late work orders,
 * and the states (loading, error, nothing on the floor, no late work order, no permission). Roles: Owner, Production
 * manager, Team leader (the supervisor's tablet in the Office, A2 decision 7), Sales (read-only).
 */

interface FloorCase {
  role: Role
  floor: FloorNowModel
}

const late = LIST_ROWS.filter((row) => (row.daysLate ?? 0) > 0)
const floor = (role: Role, over: Partial<FloorNowModel> = {}): FloorCase => ({
  role,
  floor: { prefix: PREFIX, can: canOf(role), wip: { value: SITE_WIP, problem: null }, counts: COUNTS, late: { items: late, problem: null }, asOf: at(29, 9, 42), live: 'live', ...over },
})

function FloorDesign({ model }: { model: FloorCase }) {
  return inShell('/production/floor', createElement(FloorNowView, { model: model.floor }), model.role)
}

export const designScreen = defineDesignScreen<FloorCase>({
  screen: 'SCR-073',
  title: 'Floor now (Production)',
  view: FloorDesign,
  cases: [
    { id: 'floor', label: 'Production manager: the floor at a glance, live', model: floor('manager'), note: 'An operation opens the bundles waiting there (the work order’s Bundles tab).' },
    { id: 'owner', label: 'Owner', model: floor('owner') },
    { id: 'team-leader', label: 'Team leader (the supervisor’s tablet in the Office)', model: floor('teamLeader') },
    { id: 'sales', label: 'Sales (read-only)', model: floor('sales') },
    { id: 'no-late', label: 'No late work order', model: floor('manager', { late: { items: [], problem: null }, counts: { ...COUNTS, late: 0 } }) },
    { id: 'empty', label: 'Nothing on the floor right now', model: floor('manager', { wip: { value: { workOrders: [] }, problem: null }, late: { items: [], problem: null }, counts: { draft: 2, released: 0, inProgress: 0, completed: 0, open: 2, late: 0 } }) },
    { id: 'loading', label: 'Loading', model: floor('manager', { wip: { value: null, problem: null }, late: { items: null, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The read failed: in words, with Try again', model: floor('manager', { wip: { value: null, problem: 'error.offline' }, late: { items: null, problem: 'error.offline' }, counts: null, live: 'offline' }) },
    { id: 'no-permission', label: 'No permission (workorders.view): the API refused the read', model: floor('sales', { wip: { value: null, problem: 'error.forbidden' }, late: { items: null, problem: 'error.forbidden' }, counts: null }) },
  ],
})
