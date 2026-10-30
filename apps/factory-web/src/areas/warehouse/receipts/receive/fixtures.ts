import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canOf, inShell, PREFIX, TIME_ZONE, type Role } from '../../../_shared/buying/fixtures'
import { EXPECTED, LOTS, receipt, typedDraft } from '../demo/fixtures'
import type { ReceiveModel } from '../model'
import { ReceiveView } from './view/ReceiveView'

/**
 * SCR-061 — hides one by one (B-W1-32 part 2, in the receiving of goods against a purchase order) with made-up data only:
 * pick the order that takes goods, then its open lines — the leather by dye lot with every hide typed (tannery number,
 * area in m², dm² or ft², grade, thickness, shade, defects; Enter down, Tab right, a pasted column fills down), the
 * running totals against the line's tolerance, a hide with no area yet holding Post, more than the tolerance needing its
 * reason, a lot held for a quality check with its reason, the lining by lot — Ready to post in words, posting, the
 * result (numbers from the series, lots in quarantine and why) and a refusal. Roles: Warehouse, Owner, Buyer (no right
 * to receive).
 */

export interface ReceiveCase {
  role: Role
  model: ReceiveModel
}

function receiveCase(role: Role, over: Partial<ReceiveModel> = {}): ReceiveCase {
  return { role, model: { prefix: PREFIX, can: canOf(role), orders: { status: 'ready', value: EXPECTED }, draft: typedDraft('typed'), posting: false, problem: null, result: null, timeZone: TIME_ZONE, today: '2026-10-29', ...over } }
}

function ReceiveDesign({ model }: { model: ReceiveCase }) {
  return inShell('/warehouse/receipts/new', createElement(ReceiveView, { model: model.model }), model.role)
}

const posted = receipt({ number: 'GR-2026-0023', id: LOTS[0]!.id })

export const designScreen = defineDesignScreen<ReceiveCase>({
  screen: 'SCR-061',
  title: 'Hides one by one (receive goods against a purchase order)',
  view: ReceiveDesign,
  cases: [
    { id: 'pick-order', label: 'No order named yet: the orders that take goods', model: receiveCase('warehouse', { draft: null }) },
    { id: 'empty-form', label: 'The order’s open lines: one empty hide row, one empty lot', model: receiveCase('warehouse', { draft: typedDraft('empty') }) },
    { id: 'typed', label: 'Nine hides typed, the tenth without its area: Post held, the line within its tolerance', model: receiveCase('warehouse'), note: 'Enter goes to the next hide; a pasted column fills the hides down.' },
    { id: 'over', label: 'More than the tolerance: the reason is asked', model: receiveCase('warehouse', { draft: typedDraft('over') }) },
    { id: 'held-lot', label: 'A lot held for a quality check, with its reason', model: receiveCase('warehouse', { draft: typedDraft('held') }) },
    { id: 'posting', label: 'Posting', model: receiveCase('warehouse', { draft: typedDraft('held'), posting: true }) },
    { id: 'refused', label: 'Refused: the order no longer takes these goods (read again)', model: receiveCase('warehouse', { draft: typedDraft('held'), problem: { key: 'rc.refusal.order' } }) },
    { id: 'no-series', label: 'Refused: the company has no receipt or lot series yet', model: receiveCase('warehouse', { draft: typedDraft('held'), problem: { key: 'rc.refusal.series' } }) },
    {
      id: 'posted',
      label: 'Posted: the receipt and lot numbers from the series, which lots wait and why, the notes',
      model: receiveCase('warehouse', {
        result: {
          receipt: { ...posted, purchaseOrder: { ...posted.purchaseOrder!, status: 'PARTLY_RECEIVED' } },
          notes: [
            { code: 'SHORT', seq: 10 },
            { code: 'QUARANTINE', seq: 10 },
          ],
        },
      }),
    },
    { id: 'loading', label: 'Loading the order lines', model: receiveCase('warehouse', { orders: { status: 'loading' }, draft: null }) },
    { id: 'error', label: "The order lines couldn't be read", model: receiveCase('warehouse', { orders: { status: 'error', problem: 'problem.offline' }, draft: null }) },
    { id: 'nothing-open', label: 'Nothing expected: no order takes goods', model: receiveCase('warehouse', { orders: { status: 'ready', value: [] }, draft: null }) },
    { id: 'owner', label: 'Owner', model: receiveCase('owner') },
    { id: 'buyer', label: 'Buyer: no inventory.receive — the page says so', model: receiveCase('buyer') },
  ],
})
