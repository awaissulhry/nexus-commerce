import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_CAN, DEMO_GRAINS, demoBySize, demoRows, demoSizeWeights, DEMO_SIZES } from '../versions/demo/fixtures'
import type { SizeMixModel } from '../sizemix/view/SizeMixCard'
import type { CostSheetsModel } from '../versions/view/CostSheetsView'
import { CostSheetsView } from '../versions/view/CostSheetsView'

/** SCR-504 — Style › Cost › Cost by size with the suggested size surcharge for big sizes (B-W2b-430), made-up data only. */

const rows = demoRows()
const model = (bySize: Partial<NonNullable<CostSheetsModel['bySize']>> = {}): CostSheetsModel => ({
  bySize: { sheet: rows[2]!, result: { status: 'ready', value: demoBySize() }, can: DEMO_CAN.owner, grains: DEMO_GRAINS.all, busy: false, problem: null, notice: null, ...bySize },
})

// ---- B-W2b-GB02 (G054): the style's size mix, edited on screen.
const mix = (sizeMix: Partial<SizeMixModel> = {}): CostSheetsModel => ({
  sizeMix: { sizes: DEMO_SIZES, baseSize: '52', inView: rows[2]!, can: DEMO_CAN.owner, mixes: { status: 'ready', value: demoSizeWeights() }, editing: null, busy: false, problem: null, notice: null, ...sizeMix },
})
// ---- end B-W2b-GB02

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
    // ---- B-W2b-GB02 (G054): the size mix
    { id: 'gb02-mix', label: 'GB02 — Size mix: every season and AI27', model: mix(), note: 'Shares per size; Change opens the mix in a dialog. A version keeps its own mix until "Read the size mix again".' },
    { id: 'gb02-mix-dialog', label: 'GB02 — Change the AI27 mix', model: mix({ editing: rows[2]!.season!.id }), note: 'A weight per size; the shares follow as you type.' },
    { id: 'gb02-mix-bad', label: 'GB02 — A weight that is no figure', model: mix({ editing: '', draft: { seasonId: '', weights: { '46': '', '48': '1', '50': '2', '52': 'tre', '54': '2,5', '56': '1,5', '58': '' } } }) },
    { id: 'gb02-mix-clear', label: 'GB02 — Every size blank: the mix is cleared', model: mix({ editing: '', draft: { seasonId: '', weights: Object.fromEntries(DEMO_SIZES.map((size) => [size, ''])) } }) },
    { id: 'gb02-mix-saved', label: 'GB02 — Done: mix kept', model: mix({ notice: { key: 'mix.saved' } }) },
    { id: 'gb02-mix-none', label: 'GB02 — No size mix yet', model: mix({ mixes: { status: 'ready', value: demoSizeWeights({ none: true }) } }) },
    { id: 'gb02-mix-reader', label: 'GB02 — A reader: the mix is not theirs to change', model: mix({ can: DEMO_CAN.reader }) },
    { id: 'gb02-mix-error', label: 'GB02 — The mix could not be read', model: mix({ mixes: { status: 'error', problem: 'verProblem.read.unavailable' } }) },
    // ---- end B-W2b-GB02
  ],
})
