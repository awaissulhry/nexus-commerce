import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { DAILY, DAILY_ABOUT, EMPTY_RESULT, OPEN_ORDERS, OPEN_ORDERS_ABOUT, OPEN_ORDERS_PLANNER, OPEN_ORDERS_PLANNER_ABOUT, STOCK_VALUE_HELD, inShell } from '../demo/fixtures'
import { ReportPrintView, type ReportPrintModel } from './view/ReportPrintView'

/**
 * SCR-104-print — a report as PDF (design home.reports tab:report-print), with made-up data only: Open orders for the
 * owner, for a planner (what the rights left out, at the top), Daily production (a small line's efficiency hidden), no
 * rows, a held report, loading and a failed read. Opened in a new tab from the report's Print; the frame is hidden on paper.
 */

const model = (about: ReportPrintModel['about']['value'], results: ReportPrintModel['results']['value'], problem: string | null = null): ReportPrintModel => ({ person: DEMO_USER.displayName, about: { value: about, problem: null }, results: { value: results, problem } })

function PrintDesign({ model: value }: { model: ReportPrintModel }) {
  return inShell(`/home/reports/${value.about.value?.key ?? 'sales.open-orders'}/print`, createElement(ReportPrintView, { model: value }))
}

export const designScreen = defineDesignScreen<ReportPrintModel>({
  screen: 'SCR-104-print',
  title: 'Reports: a report as PDF (Home › Insights)',
  view: PrintDesign,
  cases: [
    { id: 'rows', label: 'Open orders (owner)', model: model(OPEN_ORDERS_ABOUT, OPEN_ORDERS), note: 'Title, question, what it looked at, when it was read and who printed it; every row and the totals. Print sends it to the printer or a PDF.' },
    { id: 'planner', label: 'A planner: the net value left out', model: model(OPEN_ORDERS_PLANNER_ABOUT, OPEN_ORDERS_PLANNER), note: '"Left out because of your rights: price" on paper too.' },
    { id: 'small-groups', label: 'Daily production: a small line hidden', model: model(DAILY_ABOUT, DAILY) },
    { id: 'empty', label: 'No rows', model: model(OPEN_ORDERS_ABOUT, EMPTY_RESULT) },
    { id: 'held', label: 'A report the person may not run', model: model(STOCK_VALUE_HELD, null), note: 'Print held, the reason said.' },
    { id: 'loading', label: 'Loading (Print held)', model: model(null, null) },
    { id: 'error', label: 'The read failed', model: model(OPEN_ORDERS_ABOUT, null, 'error.offline') },
  ],
})
