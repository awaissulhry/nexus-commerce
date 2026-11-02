import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PEOPLE_ROLES, PREFIX } from '../../_shared/fixtures'
import { TIMESHEET, TIMESHEET_LEAD } from '../demo/fixtures'
import { attendanceCan } from '../model'
import { TimesheetView, type TimesheetModel } from './view/TimesheetView'

/** SCR-157-timesheet — a person's month, made-up people only: HR with the hours, a lead with the days' state alone. */
const sheet = (over: Partial<TimesheetModel> = {}): TimesheetModel => ({ prefix: PREFIX, can: attendanceCan(PEOPLE_ROLES.hr), loaded: { status: 'ready', value: TIMESHEET }, gateShut: false, busy: false, problem: null, dialog: null, at: '2026-11-02T09:42:00.000Z', person: 'Anna Esempio', ...over })

export const designScreen = defineDesignScreen<TimesheetModel>({
  screen: 'SCR-157-timesheet',
  title: 'Person timesheet',
  view: ({ model }) => inShell('/people/attendance', createElement(TimesheetView, { model })),
  cases: [
    { id: 'hr', label: "HR: the hours, HR's turn", model: sheet() },
    { id: 'lead', label: 'A lead: days and states, no hours', model: sheet({ can: attendanceCan(PEOPLE_ROLES.supervisor), loaded: { status: 'ready', value: TIMESHEET_LEAD } }), note: 'Leads confirm days, not hours (B-W2b-42).' },
    { id: 'changed', label: 'Changed since the approval', model: sheet({ loaded: { status: 'ready', value: { ...TIMESHEET, changedSince: true } } }) },
    { id: 'returned', label: 'Sent back', model: sheet({ loaded: { status: 'ready', value: { ...TIMESHEET, returned: { at: '2026-11-01T10:00:00.000Z', by: 'Anna Esempio', reason: 'Controllare il 30' } } } }) },
    { id: 'send-back', label: 'Send back: the reason', model: sheet({ dialog: { reason: '', busy: false, problem: null } }) },
    { id: 'refused', label: 'Approval refused', model: sheet({ problem: { key: 'hold.timesheet.SAME_PERSON' } }) },
    { id: 'gate-off', label: 'Gate shut', model: sheet({ gateShut: true }) },
    { id: 'loading', label: 'Loading', model: sheet({ loaded: { status: 'loading' } }) },
    { id: 'error', label: "Couldn't read", model: sheet({ loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'not-found', label: 'Out of reach', model: sheet({ loaded: { status: 'notFound' } }) },
  ],
})
