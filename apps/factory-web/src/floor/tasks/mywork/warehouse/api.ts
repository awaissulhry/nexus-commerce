import { z } from 'zod'
import { TASK_AUDIENCES, TASK_KINDS, TASK_STATUSES } from '@nexus/factory-domain/inventory/tasks/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { onlineFirst, type KeepsActions } from '../../../queue/online-first'
import { AsOfMemory, type Remembered } from '../../shared/as-of'
import { floorRead, seg, type TaskOutcome } from '../../shared/task-api'
import type { StepKind, TaskInbox, WarehouseTask } from './model'
import { warehouseWrite } from './write'

/**
 * The warehouse task inbox's calls (B-W2b-308 on B-W2b-292's API, apps/factory-api modules/inventory/tasks; floor + floor.work):
 * `GET /inventory/tasks/inbox` (the signed-in worker's tasks, next first, counts per kind), kept for the visit PER PERSON so an
 * offline tablet still shows it "as of …" (never to the next person on the tablet), and a step on a task — take, give back,
 * done — online first: a network failure keeps it on the tablet (inventory.task.take | giveBack | done) under the try's id, so
 * the office's answer to the retry is the try's own (B-W2b-77). Every answer is checked against the fields the screens read; no
 * field carries money or a person.
 */

const place = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() })

export const taskSchema = z.object({
  id: z.string(),
  kind: z.enum(TASK_KINDS),
  status: z.enum(TASK_STATUSES),
  source: z.object({ type: z.string(), id: z.string() }).nullable(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }).nullable(),
  colour: z.object({ code: z.string(), name: z.string() }).nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  from: place.nullable(),
  to: place.nullable(),
  quantity: z.string().nullable(),
  uom: z.string().nullable(),
  dueAt: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  // The office's reads have no viewer: anyone's.
  audience: z.enum(TASK_AUDIENCES).default('ANYONE'),
  mine: z.boolean().default(false),
}) satisfies z.ZodType<WarehouseTask>

const counts = z.object(Object.fromEntries(TASK_KINDS.map((kind) => [kind, z.number().int().default(0)])) as Record<(typeof TASK_KINDS)[number], z.ZodDefault<z.ZodNumber>>)

const inboxSchema = z.object({ asOf: z.string(), tasks: z.array(taskSchema), counts, more: z.boolean() })

/** The inbox read in this visit, per person (another person on the tablet never sees it). */
const KEPT = new AsOfMemory<TaskInbox>(8)

export async function fetchInbox(api: ApiClient, workerId: string): Promise<TaskOutcome<TaskInbox>> {
  const answer = await floorRead(api, '/inventory/tasks/inbox', { schema: inboxSchema })
  if (answer.ok) KEPT.keep(workerId, answer.value)
  return answer
}

/** What this tablet read for this person in this visit, with its time; null: nothing. */
export const keptInbox = (workerId: string): Remembered<TaskInbox> | null => KEPT.get(workerId)

const doneAnswer = z.object({
  task: taskSchema,
  moved: z.array(z.object({ fromCode: z.string(), onHand: z.string(), uom: z.string() })).optional(),
  stays: z.array(z.object({ atCode: z.string(), onHand: z.string(), uom: z.string() })).optional(),
})
export type DoneAnswer = z.infer<typeof doneAnswer>

const PATH: Readonly<Record<StepKind, string>> = { take: 'take', giveBack: 'give-back', done: 'done' }
const KIND: Readonly<Record<StepKind, 'inventory.task.take' | 'inventory.task.giveBack' | 'inventory.task.done'>> = { take: 'inventory.task.take', giveBack: 'inventory.task.giveBack', done: 'inventory.task.done' }

/** The key the office gives the same step when it comes through the queue (`<device>.<client event id>`). */
export const stepKey = (deviceId: string | null, clientEventId: string): string => (deviceId ? `${deviceId}.${clientEventId}` : clientEventId)

export interface TaskStepBody {
  readonly taskId: string
  /** The version the tablet read; a queued step goes without it (applied as the task stands when it arrives). */
  readonly version?: number
  /** A quarantine move's done: the quarantine place's label, scanned. */
  readonly placeCode?: string
}

export function postStep(api: ApiClient, step: StepKind, body: TaskStepBody, key: string): Promise<TaskOutcome<DoneAnswer>> {
  const { taskId, ...rest } = body
  return warehouseWrite(api, `/inventory/tasks/${seg(taskId)}/${PATH[step]}`, {
    body: step === 'done' ? { ...rest, occurredAt: new Date().toISOString() } : rest,
    // Take and give back answer the task alone (moved / stays only come with a quarantine move's done).
    schema: doneAnswer,
    idempotencyKey: key,
  })
}

/**
 * A step, online first: a network failure keeps it on the tablet under the try's id. The queued body has no version (a step
 * that waited is applied as the task stands then; the office refuses it in words when it no longer can).
 */
export const stepOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, step: StepKind, body: TaskStepBody) =>
  onlineFirst(queue, {
    online,
    kind: KIND[step],
    payload: { taskId: body.taskId, ...(body.placeCode ? { placeCode: body.placeCode } : {}) },
    attempt: (clientEventId) => postStep(api, step, body, stepKey(deviceId, clientEventId)),
  })
