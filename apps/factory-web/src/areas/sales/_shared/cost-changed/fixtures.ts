import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CostChangedDesign, type CostChangedDesignModel } from './view/CostChangedDesign'

/**
 * SCR-530 — "Cost changed since priced" on the lines (B-W2b-380, XF6:02; design quote.price.lines "Cost changed since priced ·
 * Re-price line"): the shared mark beside a line's cost, as the quote's Pricing by line and the order's lines show it (their own
 * cases: SCR-035-prices `pricing-cost-changed`, SCR-039 `lines-cost-changed`). Made-up styles and costs; the cost grain only.
 */

const LINES: CostChangedDesignModel['lines'] = [
  { id: 'l1', label: 'GIACCA-DEMO-01 · NER', pieces: 12, cost: '182.40', change: 4.2 },
  { id: 'l2', label: 'GIACCA-DEMO-01 · ROS', pieces: 6, cost: '186.10', change: -2.5 },
  { id: 'l3', label: 'PANTALONE-DEMO-04 · NER', pieces: 20, cost: '96.00', change: 0 },
  { id: 'l4', label: 'GUANTO-DEMO-07 · NER', pieces: 30, cost: '31.75', change: null },
]

export const designScreen = defineDesignScreen<CostChangedDesignModel>({
  screen: 'SCR-530',
  title: 'Cost changed since priced, on the quote and order lines (the shared mark, B-W2b-380)',
  view: CostChangedDesign,
  cases: [
    { id: 'lines', label: 'Four lines: dearer, cheaper, the same, not known', model: { currency: 'EUR', lines: LINES }, note: 'The mark only where the cost moved; hover it for what to do. A line whose sheet is incomplete or not readable shows nothing.' },
    { id: 'dearer', label: 'Every line dearer since priced', model: { currency: 'EUR', lines: LINES.map((line) => ({ ...line, change: 3.1 })) } },
    { id: 'cheaper', label: 'A line cheaper since priced', model: { currency: 'EUR', lines: [{ ...LINES[1]! }] } },
    { id: 'unchanged', label: 'Nothing moved: no mark at all', model: { currency: 'EUR', lines: LINES.map((line) => ({ ...line, change: 0 })) } },
    { id: 'chf', label: 'A Swiss franc document', model: { currency: 'CHF', lines: LINES.slice(0, 2) } },
  ],
})
