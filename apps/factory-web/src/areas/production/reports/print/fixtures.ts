import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { DAILY, EMPTY_DAY, inShell, TODAY } from '../demo/fixtures'
import { ReportPrintView, type ReportPrintModel } from './view/ReportPrintView'

/**
 * SCR-240-print — the daily production report on paper (design production.reports tab:prr-tab-print "Report print /
 * PDF", the morning meeting), with made-up data only: a day, today so far, a day with nothing recorded, loading and a
 * failed read. Opened in a new tab from Production reports' ⋯ → Print; the browser's print hides the frame.
 */

const model = (daily: ReportPrintModel['daily']): ReportPrintModel => ({ person: DEMO_USER.displayName, daily })

function PrintDesign({ model: value }: { model: ReportPrintModel }) {
  return inShell('/production/reports/print', createElement(ReportPrintView, { model: value }), 'manager')
}

export const designScreen = defineDesignScreen<ReportPrintModel>({
  screen: 'SCR-240-print',
  title: 'Production reports: print / PDF (Production)',
  view: PrintDesign,
  cases: [
    { id: 'day', label: 'Yesterday for the morning meeting', model: model({ value: DAILY, problem: null }), note: 'Print sends it to the printer or a PDF; the frame is hidden on paper.' },
    { id: 'today', label: 'Today so far', model: model({ value: TODAY, problem: null }) },
    { id: 'empty', label: 'Nothing recorded on the day', model: model({ value: EMPTY_DAY, problem: null }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ value: null, problem: null }) },
    { id: 'error', label: 'The read failed', model: model({ value: null, problem: 'error.read' }) },
  ],
})
