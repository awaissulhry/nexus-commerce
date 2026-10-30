import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { CALENDARS, COMPANY_NAME, inShell, LINE_2, PATTERNS, PLANT_1, PREFIX, workingTimeOf } from '../calendars/demo/fixtures'
import { CalendarPrintView, type CalendarPrintModel } from './view/CalendarPrintView'

/**
 * SCR-124-print — Planning settings › Plant calendar (print) (design planning.settings tab:calendar-print, "posted on
 * the notice board"), with made-up data only (calendars/demo.ts): Plant 1's 2026, Line 2's own days, loading and a
 * failed read. Opened in a new tab from Calendars & shifts; the browser's print hides the frame.
 */

const ready = (lanes = true): CalendarPrintModel['load'] => ({
  status: 'ready',
  time: workingTimeOf({ scope: 'SITE', id: PLANT_1.id }),
  calendars: CALENDARS,
  patterns: PATTERNS,
  lanes: lanes ? [{ code: LINE_2.code, name: LINE_2.name, time: workingTimeOf({ scope: 'LINE', id: LINE_2.id }) }] : [],
})
const model = (load: CalendarPrintModel['load']): CalendarPrintModel => ({ prefix: PREFIX, person: DEMO_USER.displayName, companyName: COMPANY_NAME, site: PLANT_1, year: 2026, printedAt: '2026-10-20T08:30:00.000Z', load })

function PrintDesign({ model: value }: { model: CalendarPrintModel }) {
  return inShell(createElement(CalendarPrintView, { model: value }), 'planner', '/planning/settings/calendar-print')
}

export const designScreen = defineDesignScreen<CalendarPrintModel>({
  screen: 'SCR-124-print',
  title: 'Plant calendar (print) (Planning settings)',
  view: PrintDesign,
  cases: [
    { id: 'year', label: 'Plant 1, 2026', model: model(ready()), note: 'The year with its key, the week and shifts in words, every holiday, closure and exception in date order, and Line 2’s days that differ. Print sends it to the printer or a PDF.' },
    { id: 'site-only', label: 'No line differs', model: model(ready(false)), note: 'Every line follows the site: said, not left blank.' },
    { id: 'loading', label: 'Loading (Print held)', model: model({ status: 'loading' }) },
    { id: 'error', label: 'The read failed', model: model({ status: 'error', problem: 'ps.problem.offline' }) },
  ],
})
