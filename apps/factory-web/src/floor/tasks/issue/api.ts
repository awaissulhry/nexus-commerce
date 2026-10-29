import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'
import type { PickList, PickWorkOrderRow } from './model'

/**
 * Pick & issue's calls (apps/factory-api modules/inventory/issue, inventory.issue; office and floor alike): the work
 * orders to pick for at the device's site, one work order's pick list, issue a scanned stock code, undo one's own last
 * issue. Each answer is checked against the fields the screen reads (the rest is dropped); no field carries money. Every
 * write carries an Idempotency-Key (floorWrite), and the device's clock as `occurredAt`.
 */

const decimal = z.union([z.string(), z.number()]).transform(String)
const style = z.object({ id: z.string(), code: z.string(), name: z.string() })

const workOrdersAnswer = z.object({
  workOrders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      batchNumber: z.string().nullable(),
      status: z.string(),
      dueDate: z.string().nullable(),
      style,
      pieces: z.number(),
      colourways: z.array(z.string()),
    }),
  ),
})

const candidate = z.object({
  lotId: z.string().nullable(),
  lotCode: z.string().nullable(),
  hideId: z.string().nullable(),
  hideCode: z.string().nullable(),
  hideState: z.string().nullable(),
  grade: z.string().nullable(),
  locationCode: z.string(),
  onHand: decimal,
})

const pickListAnswer = z.object({
  workOrder: z.object({
    id: z.string(),
    number: z.string(),
    batchNumber: z.string().nullable(),
    status: z.string(),
    dueDate: z.string().nullable(),
    issuable: z.boolean(),
    style: style,
  }),
  lines: z.array(
    z.object({
      itemId: z.string(),
      itemCode: z.string(),
      itemName: z.string(),
      tracking: z.string(),
      baseUom: z.string(),
      itemColourId: z.string().nullable(),
      colourCode: z.string().nullable(),
      colourName: z.string().nullable(),
      planned: decimal,
      issued: decimal,
      toIssue: decimal,
      covered: z.boolean(),
      usable: z.object({ onHand: decimal, candidates: z.array(candidate), more: z.number() }),
      held: z.array(z.object({ reason: z.string(), lotCode: z.string(), onHand: decimal, hides: z.number() })),
      atWorkOrder: z.array(z.object({ lotId: z.string().nullable(), lotCode: z.string().nullable(), hideId: z.string().nullable(), hideCode: z.string().nullable(), quantity: decimal })),
    }),
  ),
  undo: z
    .object({
      issueId: z.string(),
      itemId: z.string(),
      itemColourId: z.string().nullable(),
      lotId: z.string().nullable(),
      hideId: z.string().nullable(),
      baseQuantity: decimal,
      occurredAt: z.string(),
    })
    .nullable(),
})

const issueAnswer = z.object({
  issue: z.object({
    id: z.string(),
    itemId: z.string(),
    itemColourId: z.string().nullable(),
    lotId: z.string().nullable(),
    hideId: z.string().nullable(),
    baseQuantity: decimal,
    overIssue: z.boolean(),
  }),
  line: z.object({ planned: decimal, issued: decimal, toIssue: decimal }),
})
export type IssueAnswer = z.infer<typeof issueAnswer>

const undoAnswer = z.object({ reversal: z.object({ reversedId: z.string(), baseQuantity: decimal }) })

const toRow = (row: z.infer<typeof workOrdersAnswer>['workOrders'][number]): PickWorkOrderRow => ({
  id: row.id,
  number: row.number,
  batchNumber: row.batchNumber,
  status: row.status,
  dueDate: row.dueDate,
  style: { code: row.style.code, name: row.style.name },
  pieces: row.pieces,
  colourways: row.colourways,
})

/** The work orders to pick for at this site (released and in progress, most urgent first), or the one with this number. */
export async function fetchPickWorkOrders(api: ApiClient, number?: string): Promise<TaskOutcome<PickWorkOrderRow[]>> {
  const answer = await floorRead(api, '/inventory/picking/work-orders', { query: number ? { number, limit: 1 } : { limit: 50 }, schema: workOrdersAnswer })
  return answer.ok ? { ok: true, value: answer.value.workOrders.map(toRow) } : answer
}

export async function fetchPickList(api: ApiClient, workOrderId: string): Promise<TaskOutcome<PickList>> {
  const answer = await floorRead(api, `/inventory/picking/work-orders/${seg(workOrderId)}`, { schema: pickListAnswer })
  if (!answer.ok) return answer
  const { workOrder, lines, undo } = answer.value
  return {
    ok: true,
    value: {
      workOrder: { id: workOrder.id, number: workOrder.number, batchNumber: workOrder.batchNumber, status: workOrder.status, dueDate: workOrder.dueDate, issuable: workOrder.issuable, style: { code: workOrder.style.code, name: workOrder.style.name } },
      lines: lines.map((line) => ({ ...line, key: `${line.itemId}:${line.itemColourId ?? '-'}` })),
      undo,
    },
  }
}

/**
 * Issues the scanned stock: a hide whole (no quantity), a lot or a material by `quantity` (a decimal string in the base
 * unit; absent: what the work order still needs, up to what is on hand). The key is the action's: kept for a retry.
 */
export function issueStock(api: ApiClient, workOrderId: string, stock: { code: string; quantity?: string }, idempotencyKey: string): Promise<TaskOutcome<IssueAnswer>> {
  return floorWrite(api, 'POST', `/inventory/picking/work-orders/${seg(workOrderId)}/issue`, {
    body: { code: stock.code, ...(stock.quantity !== undefined ? { quantity: stock.quantity } : {}), occurredAt: new Date().toISOString() },
    schema: issueAnswer,
    idempotencyKey,
  })
}

export function undoLastIssue(api: ApiClient, issueId: string, idempotencyKey: string): Promise<TaskOutcome<z.infer<typeof undoAnswer>>> {
  return floorWrite(api, 'POST', `/inventory/picking/issues/${seg(issueId)}/undo`, { schema: undoAnswer, idempotencyKey })
}
