import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { canOf, inShell, PREFIX, TIME_ZONE, type Role } from '../../../../_shared/buying/fixtures'
import { EXPECTED } from '../../demo/fixtures'
import type { ReceiveModel } from '../../model'
import { ReceiveView } from '../../receive/view/ReceiveView'
import { CANCELLED_RECEIPT, HELD_LINE_ID, HELD_RECEIPT, heldModel, TASK_ID } from '../demo/fixtures'

/**
 * SCR-061-held — Post receipt answered 202 (B-W2b-382 on B-W2b-377): the receipt is recorded and WAITS for a yes, never said as
 * posted — which lines and why, who is asked, Open the request, Cancel, Open the receipt; then cancelled (Receive again).
 * Made-up data only; the posted result stays SCR-061's `posted` case.
 */

interface HeldReceiveCase {
  role: Role
  model: ReceiveModel
}

const held = [{ lineId: HELD_LINE_ID, seq: 20, taskId: TASK_ID }]
function heldCase(role: Role, over: Partial<ReceiveModel> = {}): HeldReceiveCase {
  return {
    role,
    model: { prefix: PREFIX, can: canOf(role), orders: { status: 'ready', value: EXPECTED }, draft: null, posting: false, problem: null, result: { receipt: HELD_RECEIPT, notes: [{ code: 'OVER', seq: 20 }], held }, timeZone: TIME_ZONE, today: '2026-10-29', held: heldModel(), ...over },
  }
}

function HeldReceiveDesign({ model }: { model: HeldReceiveCase }) {
  return inShell('/warehouse/receipts/new', createElement(ReceiveView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<HeldReceiveCase>({
  screen: 'SCR-061-held',
  title: 'Receive goods › the receipt waits for a yes (B-W2b-382)',
  view: HeldReceiveDesign,
  cases: [
    { id: 'held', label: 'Warehouse · recorded, waits for a yes: which line and why, who is asked', model: heldCase('warehouse'), note: 'Not "posted": no lot, no move; Open the request · Cancel this receipt · Open the receipt.' },
    { id: 'cancel', label: 'Cancel this receipt: the reason', model: heldCase('warehouse', { held: heldModel({ dialog: { reason: '', problem: null } }) }) },
    { id: 'cancelled', label: 'Cancelled: Receive PO-2026-0003 again', model: heldCase('warehouse', { result: { receipt: CANCELLED_RECEIPT, notes: [], held }, held: heldModel({ receipt: CANCELLED_RECEIPT, state: 'none', done: { key: 'held.notice.cancelled', number: CANCELLED_RECEIPT.number } }) }) },
    { id: 'owner', label: 'Owner · the same receipt (the request names Purchasing)', model: heldCase('owner') },
  ],
})
