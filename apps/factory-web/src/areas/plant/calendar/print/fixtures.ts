import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { calendarAnswer, inSafetyShell, ITEMS, NOW, SCOPE_ALL, type SafetyRoleDemo } from '../_demo/fixtures'
import { CalendarPrintView, type CalendarPrintModel } from './view/CalendarPrintView'

/**
 * SCR-267-cal-print — the safety calendar for the periodic meeting (design new tab "Calendar (print)"), made-up data:
 * this month and the next 11 by month; health visits as a count.
 */

interface CalPrintCase {
  role: SafetyRoleDemo
  model: CalendarPrintModel
}

const model = (over: Partial<CalendarPrintModel> = {}, role: SafetyRoleDemo = 'safety'): CalPrintCase => ({
  role,
  model: { person: DEMO_USER.displayName, at: NOW, company: 'Officina Demo S.r.l.', site: 'Stabilimento Demo Nord', allSites: false, window: { from: '2026-11-01', to: '2027-10-31' }, canView: true, calendar: { value: calendarAnswer({ from: '2026-11-01', to: '2027-10-31' }), problem: null }, ...over },
})

function CalPrintDesign({ model: value }: { model: CalPrintCase }) {
  return inSafetyShell('/plant/calendar/print', createElement(CalendarPrintView, { model: value.model }), value.role, value.model.allSites ? SCOPE_ALL : undefined)
}

export const designScreen = defineDesignScreen<CalPrintCase>({
  screen: 'SCR-267-cal-print',
  title: 'Safety calendar: calendar (print)',
  view: CalPrintDesign,
  cases: [
    { id: 'year', label: 'This month and the next 11', model: model(), note: 'What is still open from before the window comes first (October); a health visit is a count.' },
    { id: 'all-sites', label: 'All sites: each row says its site', model: model({ site: null, allSites: true }) },
    { id: 'failed-source', label: 'A source could not be read', model: model({ calendar: { value: calendarAnswer({ failed: ['MACHINE_CHECK'], items: ITEMS.filter((item) => item.kind !== 'MACHINE_CHECK') }), problem: null } }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ calendar: { value: null, problem: null } }) },
    { id: 'error', label: 'The read failed', model: model({ calendar: { value: null, problem: 'problem.read' } }) },
    { id: 'no-permission', label: 'Sales: no safety.view', model: model({ canView: false, calendar: { value: null, problem: null } }, 'sales') },
  ],
})
