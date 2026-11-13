import { at, PREFIX, TIME_ZONE, uid } from '../../../../_shared/buying/fixtures'
import { receipt } from '../../demo/fixtures'
import type { Receipt } from '../../api'
import type { HeldModel } from '../use-held-receipt'

/**
 * Made-up receipts that wait for a yes (B-W2b-382) for SCR-061-held and SCR-062-held: GR-2026-0024 of PO-2026-0003 brings 30
 * protectors where 24 were ordered (+25 %, beyond the delivery tolerance that needs a yes): OPEN, nothing posted, the line
 * held and its request in Home › Approvals. Design-only; it exports no `designScreen`.
 */

const base = receipt()
const protectors = base.lines[1]!
export const HELD_LINE_ID = protectors.id
export const TASK_ID = uid('3820', 1)

export const HELD_RECEIPT: Receipt = receipt({
  id: uid('6301', 24),
  number: 'GR-2026-0024',
  status: 'OPEN',
  postedAt: null,
  version: 1,
  reversal: null,
  summary: { lines: 1, lots: 0, lotsInQuarantine: 0, lotsReleased: 0, hides: 0, quantities: [{ uom: 'PCS', baseQuantity: '30.0000' }] },
  lines: [
    {
      ...protectors,
      quantity: '30.0000',
      baseQuantity: '30.0000',
      orderLine: { ...protectors.orderLine!, received: '0.0000', open: '24.0000' },
      difference: { kind: 'OVER', expected: '24.0000', receivedBefore: '0.0000', after: '30.0000', open: '0.0000', difference: '6.0000', tolerancePct: '0', upTo: '24.0000' },
      lots: [],
      heldForApprovalAt: at(29, 8, 20),
    },
  ],
})

export const RELEASED_RECEIPT: Receipt = { ...HELD_RECEIPT, version: 2, lines: HELD_RECEIPT.lines.map((line) => ({ ...line, heldForApprovalAt: null })) }
export const CANCELLED_RECEIPT: Receipt = { ...HELD_RECEIPT, status: 'CANCELLED', cancelledAt: at(29, 9, 5), version: 2 }

const approver = { kind: 'ROLE' as const, id: uid('9500', 1), name: 'Acquisti', me: false }

export function heldModel(over: Partial<HeldModel> = {}): HeldModel {
  return {
    receipt: HELD_RECEIPT,
    state: 'waiting',
    requests: { [HELD_LINE_ID]: { id: TASK_ID, status: 'PENDING', approver, decidedAt: null } },
    held: [{ lineId: HELD_LINE_ID, seq: protectors.seq, taskId: TASK_ID }],
    prefix: PREFIX,
    timeZone: TIME_ZONE,
    actionHeld: null,
    busy: false,
    dialog: null,
    problem: null,
    done: null,
    ...over,
  }
}

export const REFUSED_REQUESTS: HeldModel['requests'] = { [HELD_LINE_ID]: { id: TASK_ID, status: 'REJECTED', approver, decidedAt: at(29, 9, 0) } }
