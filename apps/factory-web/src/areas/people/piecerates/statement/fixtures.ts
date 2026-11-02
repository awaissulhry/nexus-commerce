import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { StatementPdfView, type StatementPdfModel } from './view/StatementPdfView'

/** SCR-158-statement — the worker statement's PDF tab, its states (the PDF itself is made by the API, from the frozen row). */

const model = (over: Partial<StatementPdfModel> = {}): StatementPdfModel => ({ allowed: true, pdf: null, problem: null, ...over })

export const designScreen = defineDesignScreen<StatementPdfModel>({
  screen: 'SCR-158-statement',
  title: 'Worker statement (PDF)',
  view: StatementPdfView,
  cases: [
    { id: 'loading', label: 'Reading the PDF', model: model() },
    { id: 'error', label: "The PDF couldn't be read", model: model({ problem: { key: 'problem.unavailable' } }) },
    { id: 'no-permission', label: 'Without the right', model: model({ allowed: false }) },
  ],
})
