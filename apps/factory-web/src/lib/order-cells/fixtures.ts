import { defineDesignScreen } from '../design/design-screen'
import { OrderCellsLab, type OrderCellsLabModel } from './view/OrderCellsLab'

/**
 * pg-t (portal grid plan § 2, T.2) — the lab of the shared order list parts (`/design/order-list-parts`): the groups band, the status
 * and mark chips, Promised, Shipped, the phone card and the bubble, each drawn by the office's face and the customer's side by side.
 * One part, one file, two pages. Made-up data only.
 */
export const designScreen = defineDesignScreen<OrderCellsLabModel>({
  screen: 'order-list-parts',
  title: 'Shared order list parts — office and customer faces (pg-)',
  view: OrderCellsLab,
  cases: [
    { id: 'band', label: 'The groups band: the Work tab’s seven phases · the portal’s eight groups', model: { show: 'band' }, note: 'The same frame, tiles, ⓘ and window; the office names the customer, the customer says “your” and counts what needs its answer.' },
    { id: 'band-states', label: 'The band while read and when the read failed', model: { show: 'band-states' }, note: 'A skeleton of the strip, numbers “—”; failed: said once, its words the button.' },
    { id: 'chips', label: 'The status chip and the mark chip', model: { show: 'chips' }, note: 'One tone for one status on every page; the office’s stop kinds stay office, the customer draws one mark: Needs your answer.' },
    { id: 'cells', label: 'Promised and Shipped', model: { show: 'cells' }, note: 'Office: the Late tag beside the day, “No promise”. Customer: “was …”, “date asked”, “wanted”; the next parcel named by its order.' },
    { id: 'card', label: 'The phone card', model: { show: 'card' }, note: 'The Work card’s block: the picture at the left, the sub line, the chips, the Promised line.' },
    { id: 'bubble', label: 'New messages: the bubble on both faces', model: { show: 'bubble' }, note: '“2”, “99+”; nothing new: an empty cell that says so to a screen reader.' },
  ],
})
