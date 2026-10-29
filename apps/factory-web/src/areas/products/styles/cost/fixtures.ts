import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { COLOURWAY_IDS, demoBom, demoCompare, demoCost, demoRouting, demoStyle, recordModel, REV, REVISIONS, withoutCost } from '../demo/fixtures'
import type { StyleRecordViewModel } from '../record/record-model'
import { StyleRecordView } from '../record/view/StyleRecordView'

/**
 * SCR-044 Cost of DEMO-JKT-01 — made-up prices and rates only: leather €3.20/ft², lining €4.50/m, membrane €9.80/m,
 * protectors €6.40 and €5.90, zip €2.75, thread €0.012/m, label €0.18; cost per minute cutting €0.62, sewing €0.55 at
 * 80 %, assembly €0.50, finishing €0.48, inspection €0.60; overhead 12 %. Base size 52 NERO, revision 2: leather
 * 7.4 × 1.18 = 8.732 ft² × 3.20 = €27.94; labour 12.5 × 0.62 + 64 × 0.55 ÷ 0.8 + 9 × 0.50 + 6 × 0.48 + 5 × 0.60 = €59.13.
 * Money by grain: the Owner and the product office see figures; the production manager and sales the structure only.
 */

const releasedCost = demoCost({ revision: REVISIONS[1] })
const releasedView = { style: { status: 'ready' as const, value: demoStyle() }, revisionId: REV.r2, bom: { status: 'ready' as const, value: demoBom({ revision: REVISIONS[1] }) }, routing: { status: 'ready' as const, value: demoRouting({ revision: REVISIONS[1] }) } }
const cost = (overrides: Partial<StyleRecordViewModel> = {}, role: 'owner' | 'product' | 'production' | 'sales' = 'owner') => recordModel(role, { tab: 'cost', ...releasedView, cost: { status: 'ready', value: releasedCost }, ...overrides })

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-044',
  title: 'Style studio: Cost',
  view: StyleRecordView,
  cases: [
    { id: 'owner', label: 'Released revision 2, base size', model: cost(), note: 'Every figure with ⓘ "How is this made?"; each step opens to its lines; bars show the share.' },
    { id: 'product', label: 'Product office', model: cost({}, 'product') },
    { id: 'draft', label: 'Draft revision 3: estimate, change vs rev 2', model: cost({ ...{ style: { status: 'ready', value: demoStyle() } }, revisionId: REV.r3, bom: { status: 'ready', value: demoBom() }, routing: { status: 'ready', value: demoRouting() }, cost: { status: 'ready', value: demoCost() }, costCompare: demoCompare() }), note: 'Size 58 cannot be costed (no leather quantity): "—", never 0, and it says why.' },
    { id: 'other-cell', label: 'ROSSO size 56', model: cost({ costCell: { colourwayId: COLOURWAY_IDS.RED, size: '56' } }) },
    { id: 'missing-price', label: 'A material without a price', model: cost({ cost: { status: 'ready', value: demoCost({ revision: REVISIONS[1], noPrice: true }) } }), note: 'The cost is not complete: what is known so far, and the missing input in words.' },
    { id: 'production', label: 'Production manager (no cost grain)', model: cost({ cost: { status: 'ready', value: withoutCost(releasedCost) } }, 'production'), note: 'Quantities, minutes and what is missing; no figure reaches the page.' },
    { id: 'sales', label: 'Sales (no cost grain)', model: cost({ cost: { status: 'ready', value: withoutCost(releasedCost) } }, 'sales'), note: 'S2: margin % and price live on quotes; never a cost amount here.' },
    { id: 'empty', label: 'Nothing to cost yet', model: cost({ cost: { status: 'ready', value: { ...releasedCost, cells: [], missing: [{ key: 'NO_BOM', code: 'NO_BOM', itemId: null, lineId: null, size: null, workCentreKind: null, message: 'x' }, { key: 'NO_ROUTING', code: 'NO_ROUTING', itemId: null, lineId: null, size: null, workCentreKind: null, message: 'x' }] } } }) },
    { id: 'loading', label: 'Loading', model: cost({ cost: { status: 'loading' } }) },
    { id: 'error', label: 'Could not compute', model: cost({ cost: { status: 'error', problem: 'problem.read.unavailable' } }) },
  ],
})
