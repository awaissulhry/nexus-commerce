import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { FIXTURES } from '../fixtures'
import type { LeatherControls } from '../model'
import { CutPlanPrintView, type CutPlanPrintModel } from './view/CutPlanPrintView'

/** SCR-252-print, the cut plan on paper, with the made-up need of SCR-252's fixtures. Nothing here is real. */

const ALL: LeatherControls = { site: null, tile: null, feas: 'all', q: '', open: null }
const PRINTED = new Date(Date.UTC(2026, 10, 16, 9, 40)).toISOString()

function PrintDesign({ model }: { model: CutPlanPrintModel }) {
  return createElement(CutPlanPrintView, { model })
}

export const designScreen = defineDesignScreen<CutPlanPrintModel>({
  screen: 'SCR-252-print',
  title: 'Cut plan: print (Planning › Leather & cut plan)',
  view: PrintDesign,
  cases: [
    { id: 'all', label: 'Every open order line that needs leather', model: { need: FIXTURES.NEED, problem: null, controls: ALL, printedAt: PRINTED }, note: 'The filters it was printed with sit on top; the frame and the button are hidden on paper.' },
    { id: 'filtered', label: 'Printed with the tile Cannot be cut from one shade', model: { need: FIXTURES.NEED, problem: null, controls: { ...ALL, tile: 'shade' }, printedAt: PRINTED } },
    { id: 'empty', label: 'Nothing to cut', model: { need: { ...FIXTURES.NEED, rows: [] }, problem: null, controls: ALL, printedAt: PRINTED } },
    { id: 'no-run', label: 'No plan run yet', model: { need: { ...FIXTURES.NEED, run: null, rows: [] }, problem: null, controls: ALL, printedAt: PRINTED } },
    { id: 'loading', label: 'Loading', model: { need: null, problem: null, controls: ALL, printedAt: PRINTED } },
    { id: 'error', label: 'Couldn’t load', model: { need: null, problem: 'error.offline', controls: ALL, printedAt: PRINTED } },
  ],
})


