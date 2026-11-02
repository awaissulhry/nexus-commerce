import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PEOPLE_ROLES, PREFIX, TODAY } from '../../_shared/fixtures'
import { CODES, DAY_RECORD, EMPLOYEE_DAYS, MONTH, PERSON_CLOSED, PERSON_MONTH } from '../demo/fixtures'
import { attendanceCan } from '../model'
import { EmployeeAttendanceView, type EmployeeAttendanceModel } from './view/EmployeeAttendanceView'

/** SCR-085-attendance — Employee › Attendance, made-up people only: one person's month, inside one record. */
const tab = (over: Partial<EmployeeAttendanceModel> = {}): EmployeeAttendanceModel => ({ prefix: PREFIX, can: attendanceCan(PEOPLE_ROLES.hr), gate: 'open', month: MONTH, today: TODAY, now: Date.parse('2026-11-02T09:42:00.000Z'), days: EMPLOYEE_DAYS, status: PERSON_MONTH, problem: null, day: null, codes: CODES, ...over })

export const designScreen = defineDesignScreen<EmployeeAttendanceModel>({
  screen: 'SCR-085-attendance',
  title: 'Employee › Attendance',
  view: ({ model }) => inShell('/people/employees', createElement(EmployeeAttendanceView, { model })),
  cases: [
    { id: 'month', label: 'The month, open', model: tab() },
    { id: 'closed', label: 'Closed on a date (LUL), corrected', model: tab({ status: PERSON_CLOSED }) },
    { id: 'day', label: 'A day opens the same Day detail', model: tab({ day: { id: DAY_RECORD.id, loaded: { status: 'ready', value: DAY_RECORD }, corrections: null, busy: false, problem: null, dialog: null } }) },
    { id: 'empty', label: 'No attendance this month', model: tab({ days: { ...EMPLOYEE_DAYS, days: [] } }) },
    { id: 'gate-off', label: 'Gate shut: the reason, nothing of the person', model: tab({ gate: 'closed', days: null, status: null }) },
    { id: 'gate-unread', label: "The site's rules can't be read", model: tab({ gate: 'failed', days: null, status: null }) },
    { id: 'loading', label: 'Loading', model: tab({ gate: 'reading', days: null, status: null }) },
    { id: 'error', label: "Couldn't read", model: tab({ days: null, status: null, problem: 'problem.unavailable' }) },
    { id: 'no-permission', label: 'No right: HR only', model: tab({ can: attendanceCan(PEOPLE_ROLES.sales), days: null, status: null }) },
  ],
})
