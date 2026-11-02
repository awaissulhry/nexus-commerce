import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PEOPLE_ROLES, PREFIX } from '../../_shared/fixtures'
import { ROLL } from '../demo/fixtures'
import { attendanceCan } from '../model'
import { RollCallView, type RollCallModel } from './view/RollCallView'

/** SCR-157-rollcall — the evacuation list, made-up people only. */
const roll = (over: Partial<RollCallModel> = {}): RollCallModel => ({ allowed: true, can: attendanceCan(PEOPLE_ROLES.hr), prefix: PREFIX, site: 'Stabilimento Nord', gate: 'open', list: ROLL, problem: null, stale: false, reading: false, ...over })

export const designScreen = defineDesignScreen<RollCallModel>({
  screen: 'SCR-157-rollcall',
  title: 'Roll call',
  view: ({ model }) => inShell('/people/attendance', createElement(RollCallView, { model })),
  cases: [
    { id: 'list', label: 'Who is in, by area and line', model: roll() },
    { id: 'offline', label: 'Offline: the last known list with its time', model: roll({ stale: true }) },
    { id: 'nobody', label: 'Nobody in', model: roll({ list: { ...ROLL, people: 0, groups: [] } }) },
    { id: 'gate-off', label: 'Gate shut', model: roll({ gate: 'closed', list: null }) },
    { id: 'pick-site', label: 'All sites: asks for a site', model: roll({ gate: 'pickSite', list: null, site: '' }) },
    { id: 'loading', label: 'Loading', model: roll({ gate: 'reading', list: null, reading: true }) },
    { id: 'error', label: "Couldn't read", model: roll({ list: null, problem: 'problem.unavailable' }) },
    { id: 'no-permission', label: 'No roll call right', model: roll({ allowed: false, list: null }) },
  ],
})
