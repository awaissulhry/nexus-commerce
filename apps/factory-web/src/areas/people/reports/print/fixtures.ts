import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { inShell, NOW } from '../../_shared/fixtures'
import { EARNINGS, REPORT } from '../fixtures'
import { reportsAddressOf, reportsCan } from '../model'
import { ReportsPrintView, type ReportsPrintModel } from './view/ReportsPrintView'

/** SCR-264-print — People reports on paper or as a PDF (design tab:pdf), made-up data: the filters on top, groups only. */

const CAN = reportsCan(['people.attendance.view', 'people.earnings.view', 'money.pay'])
const model = (over: Partial<ReportsPrintModel> = {}): ReportsPrintModel => ({ person: DEMO_USER.displayName, at: NOW, company: 'Officina Demo', site: 'Stabilimento Nord', month: '2026-10', can: CAN, address: reportsAddressOf(null), attendance: { value: REPORT, problem: null }, earnings: { value: EARNINGS, problem: null }, noSite: false, ...over })

function PrintDesign({ model: value }: { model: ReportsPrintModel }) {
  return inShell('/people/reports/print', createElement(ReportsPrintView, { model: value }), 'hr')
}

export const designScreen = defineDesignScreen<ReportsPrintModel>({
  screen: 'SCR-264-print',
  title: 'People reports: PDF (People)',
  view: PrintDesign,
  cases: [
    { id: 'report', label: 'Both reports', model: model() },
    { id: 'no-pay', label: 'Without the pay grain', model: model({ can: reportsCan(['people.attendance.view']), earnings: { value: null, problem: null } }) },
    { id: 'gate-off', label: 'Attendance off at the site', model: model({ attendance: { value: null, problem: { ns: 'people-reports', words: { key: 'attendance.gateOff' } } } }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ attendance: { value: null, problem: null }, earnings: { value: null, problem: null } }) },
    { id: 'error', label: 'The reads failed', model: model({ attendance: { value: null, problem: { ns: 'people', words: { key: 'problem.unavailable' } } }, earnings: { value: null, problem: { ns: 'people', words: { key: 'problem.unavailable' } } } }) },
    { id: 'all-sites', label: 'All sites', model: model({ noSite: true, site: null, attendance: { value: null, problem: null } }) },
    { id: 'no-permission', label: 'No right', model: model({ can: reportsCan([]) }) },
  ],
})
