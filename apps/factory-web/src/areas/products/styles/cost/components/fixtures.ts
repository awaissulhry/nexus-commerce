import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_GRAINS, demoComponents } from '../versions/demo/fixtures'
import type { CostSheetsModel } from '../versions/view/CostSheetsView'
import { CostSheetsView } from '../versions/view/CostSheetsView'

/**
 * SCR-502 — Style › Cost › the cost sheet's W2b steps (B-W2b-430): Subcontract, Packaging, Freight and duties on materials,
 * Commissions, made-up data only (DEMO-JKT-01, revision 2, NERO): each step opens to its lines with "How is this made?".
 */

const model = (steps: Partial<NonNullable<CostSheetsModel['steps']>> = {}): CostSheetsModel => ({
  steps: { components: { status: 'ready', value: demoComponents() }, size: '52', cartonPieces: 12, grains: DEMO_GRAINS.all, ...steps },
})

export const designScreen = defineDesignScreen<CostSheetsModel>({
  screen: 'SCR-502',
  title: 'Style › Cost: subcontract, packaging, freight and commissions',
  view: CostSheetsView,
  cases: [
    { id: 'base-size', label: 'Revision 2, size 52, 12 garments a carton', model: model(), note: 'Open a step to see its lines; ⓘ says how each figure is made.' },
    { id: 'size-58', label: 'Size 58', model: model({ size: '58' }) },
    { id: 'no-carton', label: 'Garments per carton not typed', model: model({ components: { status: 'ready', value: demoComponents({ carton: false }) }, cartonPieces: null }), note: 'The carton is missing (in words), the total is "known so far"; two things to look at.' },
    { id: 'nothing-outside', label: 'No workshop, no packaging, no freight', model: model({ components: { status: 'ready', value: demoComponents({ empty: true }) } }) },
    { id: 'no-grain', label: 'Production manager: no cost grain', model: model({ grains: DEMO_GRAINS.none }), note: 'Lines and quantities stay; no figure reaches the page.' },
    { id: 'loading', label: 'Loading', model: model({ components: { status: 'loading' } }) },
    { id: 'error', label: 'Could not read', model: model({ components: { status: 'error', problem: 'verProblem.read.unavailable' } }) },
  ],
})
