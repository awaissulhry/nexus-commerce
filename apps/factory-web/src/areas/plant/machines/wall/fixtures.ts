import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { PREFIX } from '../../_shared/fixtures'
import { WALL } from '../depth/fixtures'
import { WallTabView, type WallTabModel } from './view/WallTabView'

/** SCR-150-wall — the status wall's own tab (a new tab from Machines & tools ⋯), made-up data only. */

const model = (over: Partial<WallTabModel> = {}): WallTabModel => ({ prefix: PREFIX, canView: true, siteCode: 'STAB-N', loaded: { status: 'ready', value: WALL }, filter: 'ALL', live: 'live', asOf: WALL.at, ...over })

function WallDesign({ model }: { model: WallTabModel }) {
  return createElement(WallTabView, { model })
}

export const designScreen = defineDesignScreen<WallTabModel>({
  screen: 'SCR-150-wall',
  title: 'Status wall (a tab left open on an office screen)',
  view: WallDesign,
  cases: [
    { id: 'wall', label: 'Every machine in use by line: running, down, under maintenance, locked as unsafe', model: model(), note: 'Live and read-only; a tile opens the machine in another tab.' },
    { id: 'every-site', label: 'Every site the person sees', model: model({ siteCode: null }) },
    { id: 'not-running', label: 'Filtered: not running', model: model({ filter: 'NOT_RUNNING' }) },
    { id: 'do-not-use', label: 'Filtered: do-not-use', model: model({ filter: 'DO_NOT_USE' }) },
    { id: 'none', label: 'Filtered: nothing down', model: model({ filter: 'DOWN', loaded: { status: 'ready', value: { ...WALL, lines: WALL.lines.map((line) => ({ ...line, machines: line.machines.filter((tile) => tile.status !== 'DOWN') })), counts: { ...WALL.counts, DOWN: 0 } } } }) },
    { id: 'truncated', label: 'More machines than one wall draws (said)', model: model({ loaded: { status: 'ready', value: { ...WALL, truncated: true } } }) },
    { id: 'offline', label: 'The live link is down (reconnecting)', model: model({ live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: model({ loaded: { status: 'loading' }, asOf: null }) },
    { id: 'error', label: "Couldn't be read", model: model({ loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'empty', label: 'No machine in use', model: model({ loaded: { status: 'ready', value: { ...WALL, lines: [], counts: { RUNNING: 0, DOWN: 0, UNDER_MAINTENANCE: 0, DO_NOT_USE: 0, locked: 0 } } } }) },
    { id: 'no-permission', label: 'Sales: no plant.view', model: model({ canView: false }) },
  ],
})
