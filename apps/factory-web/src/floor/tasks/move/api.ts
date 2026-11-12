import { z } from 'zod'
import { QUALITY_STATES, SCANNED_KINDS } from '@nexus/factory-domain/inventory/bin-moves/rules'
import { SUGGESTION_REASONS } from '@nexus/factory-domain/inventory/putaway/rules'
import type { ApiClient } from '../../../lib/api/client'
import { onlineFirst, type KeepsActions } from '../../queue/online-first'
import { AsOfMemory, codeKey, type Remembered } from '../shared/as-of'
import { floorRead, seg, type TaskOutcome } from '../shared/task-api'
import { stepKey, taskSchema } from '../mywork/warehouse/api'
import { warehouseWrite } from '../mywork/warehouse/write'
import type { MoveBody, MovePurpose, MoveScan } from './model'

/**
 * Move & put away's calls (B-W2b-308 on B-W2b-292's API, apps/factory-api modules/inventory/{putaway,bin-moves}; office and floor,
 * inventory.transfer): "In your hands" (`GET /inventory/putaway/scan`: what a label names, where it lies, its quality state, its
 * open tasks and, for goods waiting on a dock or in quarantine, the suggested bin), the move by its two scans (`POST
 * /inventory/putaway` | `/inventory/bin-moves`, online first, else kept in the tablet's queue as inventory.putAway |
 * inventory.binMove with the same body under the try's id) and its undo within 2 minutes (online only). Every answer checked
 * against the fields the screen reads; no field carries money or a person.
 */

const place = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() })

const handSchema = z.object({
  kind: z.enum(SCANNED_KINDS),
  code: z.string(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), tracking: z.string(), baseUom: z.string() }),
  colour: z.object({ code: z.string(), name: z.string() }).nullable(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string(), lifecycle: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string(), state: z.string() }).nullable(),
  roll: z.object({ id: z.string(), code: z.string(), state: z.string() }).nullable(),
  remnant: z.object({ id: z.string(), code: z.string() }).nullable(),
  quality: z.enum(QUALITY_STATES),
  holdIds: z.array(z.string()),
  whole: z.boolean(),
  uom: z.string(),
  onHand: z.string(),
  lying: z.array(z.object({ locationId: z.string(), code: z.string(), name: z.string(), kind: z.string(), onHand: z.string() })),
})

const scanSchema = z.object({
  hand: handSchema,
  from: z.object({ locationId: z.string(), code: z.string() }).nullable(),
  suggestion: z.object({ location: place, why: z.enum(SUGGESTION_REASONS) }).nullable(),
  tasks: z.array(taskSchema),
}) satisfies z.ZodType<MoveScan>

const moveAnswer = z.object({ moveIds: z.array(z.string()), from: place, to: place, hand: handSchema, tasks: z.array(taskSchema) })
export type MoveAnswer = z.infer<typeof moveAnswer>

const undoAnswer = z.object({ undoneIds: z.array(z.string()), moveIds: z.array(z.string()), tasks: z.array(taskSchema) })
export type UndoAnswer = z.infer<typeof undoAnswer>

/** What this tablet read in this visit, by label (facts about stock, no person): offline it opens "as of". */
const HANDS = new AsOfMemory<MoveScan>(120)

export async function scanForMove(api: ApiClient, code: string): Promise<TaskOutcome<MoveScan>> {
  const answer = await floorRead(api, '/inventory/putaway/scan', { query: { code: code.trim() }, schema: scanSchema })
  if (answer.ok) HANDS.keep(codeKey(code), answer.value)
  return answer
}

export const keptHand = (code: string): Remembered<MoveScan> | null => HANDS.get(codeKey(code))

/** After a move the facts on this tablet are old: forget them (the next scan reads again, or says "not on this tablet"). */
export const forgetHand = (code: string): void => HANDS.forget(codeKey(code))

const PATHS: Readonly<Record<MovePurpose, string>> = { PUT_AWAY: '/inventory/putaway', MOVE: '/inventory/bin-moves' }
const KINDS: Readonly<Record<MovePurpose, 'inventory.putAway' | 'inventory.binMove'>> = { PUT_AWAY: 'inventory.putAway', MOVE: 'inventory.binMove' }

export function postMove(api: ApiClient, purpose: MovePurpose, body: MoveBody, key: string): Promise<TaskOutcome<MoveAnswer>> {
  return warehouseWrite(api, PATHS[purpose], { body: { ...body, occurredAt: new Date().toISOString() }, schema: moveAnswer, idempotencyKey: key })
}

/** The move, online first: a network failure keeps it on the tablet with the same body, under the try's id. */
export const moveOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, purpose: MovePurpose, body: MoveBody) =>
  onlineFirst(queue, {
    online,
    kind: KINDS[purpose],
    payload: { ...body },
    attempt: (clientEventId) => postMove(api, purpose, body, stepKey(deviceId, clientEventId)),
  })

export function undoMove(api: ApiClient, moveId: string, key: string): Promise<TaskOutcome<UndoAnswer>> {
  return warehouseWrite(api, `/inventory/bin-moves/${seg(moveId)}/undo`, { body: {}, schema: undoAnswer, idempotencyKey: key })
}
