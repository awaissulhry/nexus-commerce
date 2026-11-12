import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { onlineFirst, type KeepsActions } from '../../../queue/online-first'
import { AsOfMemory, type Remembered } from '../../shared/as-of'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../../shared/task-api'
import { stepKey } from '../../mywork/warehouse/api'
import { STOP_SOURCES, WALK_QUALITIES, type Walk } from './model'

/**
 * The pick list by bin's calls (B-W2b-310 on B-W2b-298's API, apps/factory-api modules/inventory/pick-lists and substitutions;
 * office and floor, inventory.issue): one work order's walk (`GET /inventory/pick-lists/work-orders/:id`, kept for the visit so an
 * offline tablet still walks it "as of"), a stop taken by its scan (W1's `POST /inventory/picking/work-orders/:id/issue` with
 * the stop's place, online first, else kept as inventory.pick.issue with the same body under the try's id) and an approved
 * substitute's stop (`POST /inventory/substitutions/:id/issue`, else kept as inventory.substitute.issue). Every answer is checked
 * against the fields the screen reads; no field carries money or a person.
 */

const place = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), labelCode: z.string().nullable(), path: z.array(z.string()), rank: z.number(), blocked: z.boolean() })

const stop = z.object({
  turn: z.number(),
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  lineKey: z.string(),
  itemId: z.string(),
  itemCode: z.string(),
  itemName: z.string(),
  colourCode: z.string().nullable(),
  baseUom: z.string(),
  tracking: z.string(),
  location: place,
  lotId: z.string().nullable(),
  lotCode: z.string().nullable(),
  hideId: z.string().nullable(),
  hideCode: z.string().nullable(),
  quantity: z.string(),
  source: z.enum(STOP_SOURCES),
  reservationId: z.string().nullable(),
  substitutionId: z.string().nullable(),
  quality: z.enum(WALK_QUALITIES),
  issuable: z.boolean(),
})

const line = z.object({
  key: z.string(),
  itemId: z.string(),
  itemCode: z.string(),
  itemName: z.string(),
  itemColourId: z.string().nullable(),
  colourCode: z.string().nullable(),
  baseUom: z.string(),
  toIssue: z.string(),
  reserved: z.string(),
  substituted: z.string(),
  toPick: z.string(),
  covered: z.boolean(),
})

const walkSchema = z.object({
  asOf: z.string(),
  workOrders: z
    .array(
      z.object({
        workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), issuable: z.boolean() }),
        // B-W2b-310: the kit's version (an older API without it: 0, the first write's).
        kit: z.object({ location: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), checkedAt: z.string().nullable(), version: z.number().default(0) }),
        task: z.object({ id: z.string(), status: z.string(), version: z.number() }).nullable(),
        lines: z.array(line),
      }),
    )
    .min(1),
  stops: z.array(stop),
  places: z.array(place.extend({ stops: z.number() })),
})

/** The walks read in this visit (offline they stay on screen with their time; nothing is stored). */
const WALKS = new AsOfMemory<Walk>(40)

export async function fetchWalk(api: ApiClient, workOrderId: string): Promise<TaskOutcome<Walk>> {
  const answer = await floorRead(api, `/inventory/pick-lists/work-orders/${seg(workOrderId)}`, { schema: walkSchema })
  if (!answer.ok) return answer
  const [one] = answer.value.workOrders
  const walk: Walk = { asOf: answer.value.asOf, workOrder: one!.workOrder, kit: one!.kit, task: one!.task, lines: one!.lines, stops: answer.value.stops, places: answer.value.places }
  WALKS.keep(workOrderId, walk)
  return { ok: true, value: walk }
}

export const keptWalk = (workOrderId: string): Remembered<Walk> | null => WALKS.get(workOrderId)

export interface StopIssueBody {
  readonly code: string
  readonly fromLocationId: string
  readonly quantity?: string
}

const issueAnswer = z.object({ issue: z.object({ id: z.string(), baseQuantity: z.union([z.string(), z.number()]).transform(String) }), line: z.object({ planned: z.string(), issued: z.string(), toIssue: z.string() }) })
const substituteAnswer = z.object({ issued: z.string(), moveIds: z.array(z.string()) })

/** A stop of the work order's own material, online first: a network failure keeps it on the tablet with the same body. */
export const pickOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, workOrderId: string, body: StopIssueBody) =>
  onlineFirst(queue, {
    online,
    kind: 'inventory.pick.issue',
    payload: { workOrderId, ...body },
    attempt: (clientEventId) =>
      floorWrite(api, 'POST', `/inventory/picking/work-orders/${seg(workOrderId)}/issue`, { body: { ...body, occurredAt: new Date().toISOString() }, schema: issueAnswer, idempotencyKey: stepKey(deviceId, clientEventId) }).then((outcome) =>
        outcome.ok ? { ok: true as const, value: { quantity: outcome.value.issue.baseQuantity } } : outcome,
      ),
  })

/** An approved substitute's stop, online first: a network failure keeps it on the tablet with the same body. */
export const substituteOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, substitutionId: string, body: StopIssueBody) =>
  onlineFirst(queue, {
    online,
    kind: 'inventory.substitute.issue',
    payload: { substitutionId, ...body },
    attempt: (clientEventId) =>
      floorWrite(api, 'POST', `/inventory/substitutions/${seg(substitutionId)}/issue`, { body: { ...body, occurredAt: new Date().toISOString() }, schema: substituteAnswer, idempotencyKey: stepKey(deviceId, clientEventId) }).then((outcome) =>
        outcome.ok ? { ok: true as const, value: { quantity: outcome.value.issued } } : outcome,
      ),
  })
