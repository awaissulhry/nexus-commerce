import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_CAN, DEMO_GRAINS, DEMO_SIZES, demoGoal, demoRows } from '../versions/demo/fixtures'
import type { CostSheetsModel } from '../versions/view/CostSheetsView'
import { CostSheetsView } from '../versions/view/CostSheetsView'
import { goalAskOf } from './model'

/** SCR-503 — Style › Cost › Target price (B-W2b-430; goal-seek), made-up data only: version 3 of DEMO-JKT-01. */

const rows = demoRows()
const approved = demoRows({ v3: 'approved' })
const model = (goal: Partial<NonNullable<CostSheetsModel['goal']>> = {}): CostSheetsModel => ({
  goal: { sheet: rows[2]!, sizes: DEMO_SIZES, can: DEMO_CAN.owner, grains: DEMO_GRAINS.all, ask: goalAskOf(rows[2]!, 'en'), result: { status: 'ready', value: demoGoal() }, busy: false, problem: null, ...goal },
})

export const designScreen = defineDesignScreen<CostSheetsModel>({
  screen: 'SCR-503',
  title: 'Style › Cost: target price',
  view: CostSheetsView,
  cases: [
    { id: 'above', label: 'Above the allowed cost: the biggest lines', model: model(), note: '260.00 at 42 %: allowed 150.80, the weighted cost 157.95 is 7.15 above.' },
    { id: 'within', label: 'Within the allowed cost', model: model({ result: { status: 'ready', value: demoGoal('WITHIN') } }) },
    { id: 'price-only', label: 'A price alone: the margin it earns', model: model({ result: { status: 'ready', value: demoGoal('PRICE_ONLY') } }) },
    { id: 'not-asked', label: 'Not worked out yet', model: model({ result: { status: 'idle' } }) },
    { id: 'locked', label: 'An approved version: the target is kept only on a draft', model: model({ sheet: approved[2]! }), note: '"Keep this target" is held with why.' },
    { id: 'cost-only', label: 'A cost engineer: costs, no price or margin', model: model({ can: DEMO_CAN.engineer, grains: DEMO_GRAINS.cost, result: { status: 'idle' } }) },
    { id: 'refused', label: 'Keeping the target refused', model: model({ problem: { key: 'verRefusal.LOCKED' } }) },
    { id: 'no-version', label: 'No version yet', model: model({ sheet: null }) },
    { id: 'working', label: 'Working it out', model: model({ result: { status: 'loading' } }) },
    { id: 'error', label: 'Could not work it out', model: model({ result: { status: 'error', problem: 'verProblem.read.unavailable' } }) },
  ],
})
