import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_CAN, DEMO_GRAINS, demoBySize, demoRows } from '../versions/demo/fixtures'
import type { CostSheetsModel } from '../versions/view/CostSheetsView'
import { CostSheetsView } from '../versions/view/CostSheetsView'

/** SCR-504 — Style › Cost › Cost by size with the suggested size surcharge for big sizes (B-W2b-430), made-up data only. */

const rows = demoRows()
const model = (bySize: Partial<NonNullable<CostSheetsModel['bySize']>> = {}): CostSheetsModel => ({
  bySize: { sheet: rows[2]!, result: { status: 'ready', value: demoBySize() }, can: DEMO_CAN.owner, grains: DEMO_GRAINS.all, busy: false, problem: null, notice: null, ...bySize },
})

export const designScreen = defineDesignScreen<CostSheetsModel>({
  screen: 'SCR-504',
  title: 'Style › Cost: cost by size and size surcharges',
  view: CostSheetsView,
  cases: [
    { id: 'suggested', label: 'Sizes 56 and 58 get a suggested surcharge', model: model(), note: 'Use this surcharge sets the style\'s own surcharge for the size (the price lists read it).' },
    { id: 'already-set', label: 'Size 56 already has it', model: model({ result: { status: 'ready', value: demoBySize({ current: true }) } }) },
    { id: 'used', label: 'Done: size 58 set', model: model({ notice: { key: 'bysize.used', params: { size: '58' } } }) },
    { id: 'no-target', label: 'No target margin on the version', model: model({ result: { status: 'ready', value: demoBySize({ target: false }) } }) },
    { id: 'none-big', label: 'No size far enough above the base size', model: model({ result: { status: 'ready', value: demoBySize({ none: true }) } }) },
    { id: 'no-right', label: 'A cost engineer: costs only, no price lists', model: model({ can: DEMO_CAN.engineer, grains: DEMO_GRAINS.cost }) },
    { id: 'no-grain', label: 'Production manager: no money', model: model({ can: DEMO_CAN.production, grains: DEMO_GRAINS.none }) },
    { id: 'refused', label: 'Setting the surcharge refused', model: model({ problem: { key: 'verProblem.write.forbidden' } }) },
    { id: 'no-version', label: 'No version yet', model: model({ sheet: null }) },
    { id: 'loading', label: 'Loading', model: model({ result: { status: 'loading' } }) },
    { id: 'error', label: 'Could not read', model: model({ result: { status: 'error', problem: 'verProblem.read.unavailable' } }) },
  ],
})
