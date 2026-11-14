import { createElement } from 'react'
import { BOARDS } from '@nexus/factory-domain/insights/dashboards/boards'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PREFIX } from '../demo/fixtures'
import { dashboardsHref, DEFAULT_ADDRESS, pinnableOf } from '../model'
import { PinDialog, type PinModel } from './view/PinDialog'

/**
 * SCR-491 — "Save as dashboard" (follow-up DB1:01: the report panels of W2b-5 pinned to a Home dashboard, saved per person on the
 * server), opened from Sales › Reports ⋯, with made-up data only: the dashboards with the person's own first and every panel of
 * the page ticked; nothing ticked (Pin held with why); pinning; pinned (a link to the dashboard); refused; the dashboards not
 * read; still reading them.
 */

const BOARD_LIST = [...BOARDS.filter((entry) => entry.key === 'sales'), ...BOARDS.filter((entry) => entry.key !== 'sales')].map((entry) => ({ key: entry.key, mine: entry.key === 'sales', panels: entry.panels.map((spec) => spec.id) }))
const base: PinModel = { open: true, area: 'sales', panels: pinnableOf('sales'), boards: { status: 'ready', value: BOARD_LIST }, board: 'sales', chosen: pinnableOf('sales'), busy: false, done: null, problem: null }

function PinDesign({ model }: { model: PinModel }) {
  return inShell('/sales/reports', createElement(PinDialog, { model }), 'sales')
}

export const designScreen = defineDesignScreen<PinModel>({
  screen: 'SCR-491',
  title: 'Save as dashboard (from Sales › Reports)',
  view: PinDesign,
  cases: [
    { id: 'open', label: 'Pin the page’s panels', model: base, note: 'My own dashboard first ("your role"); every panel of the page ticked; Pin 4 panels adds them at the end of my arrangement on the server.' },
    { id: 'one', label: 'One panel to the Owner group view', model: { ...base, board: 'owner-group', chosen: ['report:sales.intake'] } },
    { id: 'none-ticked', label: 'Nothing ticked — Pin held', model: { ...base, chosen: [] }, note: 'Pin says why it waits: tick at least one panel.' },
    { id: 'busy', label: 'Pinning', model: { ...base, busy: true } },
    { id: 'done', label: 'Pinned', model: { ...base, done: dashboardsHref(PREFIX, { ...DEFAULT_ADDRESS, board: 'sales' }) } },
    { id: 'refused', label: 'Refused (changed in another window)', model: { ...base, problem: 'error.stale' } },
    { id: 'boards-failed', label: 'The dashboards could not be read', model: { ...base, boards: { status: 'error', problem: 'error.offline' }, board: null } },
    { id: 'loading', label: 'Reading the dashboards', model: { ...base, boards: { status: 'loading' }, board: null } },
  ],
})
