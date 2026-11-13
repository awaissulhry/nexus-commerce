import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER, rolePermissions } from '../../../../shell/design-data'
import { inShell } from '../../../quality/_shared/fixtures'
import { BACKLOG, HEADLINE, INTAKE, NOW, RETURNS, SALES } from '../fixtures'
import { reportsCan } from '../model'
import { ReportsPrintView, type ReportsPrintModel } from './view/ReportsPrintView'

/**
 * SCR-427 — Sales reports on paper or as a PDF (design sales.reports tab:print, "Print stylesheet of the current view with filters
 * written at the top": the monthly sales review), made-up data only: November so far, without the price grain, loading (Print
 * held), a failed read, no right.
 */

const model = (over: Partial<ReportsPrintModel> = {}): ReportsPrintModel => ({
  person: DEMO_USER.displayName,
  at: NOW,
  company: 'Officina Demo S.r.l.',
  can: reportsCan(SALES),
  range: { from: '2026-11-01', to: '2026-11-12' },
  back: '/w/DEMO/sales/reports',
  headline: HEADLINE,
  intake: INTAKE,
  backlog: BACKLOG,
  returns: RETURNS,
  problem: null,
  ...over,
})

const strip = <T extends object>(value: T): T => JSON.parse(JSON.stringify(value, (key, item) => (key === 'value' || key === 'credited' ? undefined : key === 'values' ? false : item))) as T

function PrintDesign({ model: value }: { model: ReportsPrintModel }) {
  return inShell('/sales/reports/print', createElement(ReportsPrintView, { model: value }), 'owner')
}

export const designScreen = defineDesignScreen<ReportsPrintModel>({
  screen: 'SCR-427',
  title: 'Sales reports print view (Sales)',
  view: PrintDesign,
  cases: [
    { id: 'review', label: 'November so far', model: model(), note: 'The five numbers, intake per week, the backlog per promise week and per customer, the return reasons and the most returned styles by size.' },
    { id: 'no-price', label: 'Without the price grain (pieces only)', model: model({ can: reportsCan(rolePermissions('production_manager')), headline: strip(HEADLINE), intake: strip(INTAKE), backlog: strip(BACKLOG), returns: strip(RETURNS) }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ headline: null, intake: null, backlog: null, returns: null }) },
    { id: 'error', label: 'A part failed', model: model({ headline: null, intake: null, backlog: null, returns: null, problem: 'problem.read' }) },
    { id: 'no-permission', label: 'No right', model: model({ can: reportsCan(rolePermissions('planner')), headline: null, intake: null, backlog: null, returns: null }) },
  ],
})
