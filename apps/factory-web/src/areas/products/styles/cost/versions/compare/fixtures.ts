import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import { DEMO_GRAINS, demoCompare, SHEET_IDS, versionsModel } from '../demo/fixtures'
import type { CostSheetsModel } from '../view/CostSheetsView'
import { CostSheetsView } from '../view/CostSheetsView'

/** SCR-501 — Compare two versions (B-W2b-430; the DS VersionCompare), made-up data only: version 2 against version 3. */

const model = (compare: NonNullable<Parameters<typeof versionsModel>[0]>['compare'], grains = DEMO_GRAINS.all): CostSheetsModel => ({ versions: versionsModel({ compare }, 'owner', grains) })

export const designScreen = defineDesignScreen<CostSheetsModel>({
  screen: 'SCR-501',
  title: 'Style › Cost: compare two versions',
  view: CostSheetsView,
  cases: [
    { id: 'v2-v3', label: 'Version 2 against version 3', model: model({ a: SHEET_IDS.v2, b: SHEET_IDS.v3, result: { status: 'ready', value: demoCompare() } }), note: 'The leather\'s price changed, the transport back is new; unchanged lines are counted and shown on request.' },
    { id: 'other-currency', label: 'Two currencies: figures not compared', model: model({ a: SHEET_IDS.v2, b: SHEET_IDS.v3, result: { status: 'ready', value: demoCompare({ comparable: false }) } }) },
    { id: 'no-grain', label: 'Without the cost grain: quantities only', model: model({ a: SHEET_IDS.v2, b: SHEET_IDS.v3, result: { status: 'ready', value: demoCompare() } }, DEMO_GRAINS.none) },
    { id: 'same', label: 'The same version picked twice', model: model({ a: SHEET_IDS.v3, b: SHEET_IDS.v3, result: { status: 'idle' } }) },
    { id: 'loading', label: 'Comparing', model: model({ a: SHEET_IDS.v2, b: SHEET_IDS.v3, result: { status: 'loading' } }) },
    { id: 'error', label: 'Could not compare', model: model({ a: SHEET_IDS.v2, b: SHEET_IDS.v3, result: { status: 'error', problem: 'verProblem.read.unavailable' } }) },
  ],
})
