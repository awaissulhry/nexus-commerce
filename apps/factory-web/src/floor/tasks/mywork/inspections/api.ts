import { z } from 'zod'
import { BLOCKS, QUEUE_KINDS, TAKEN } from '@nexus/factory-domain/quality/queue/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { keepModel, recordModelSchema } from '../../final-inspection/plan/api'
import { AsOfMemory, type Remembered } from '../../shared/as-of'
import { floorRead, type TaskOutcome } from '../../shared/task-api'
import type { InspectorQueue } from './model'

/**
 * My work's inspector queue (B-W2b-109 on B-W2b-106's API; design floor.mywork "queue" variant: inspector queue, QHS-068): the
 * inspections that wait for me or for nobody yet, what holds up most first (`GET /quality/queue?scope=mine`), kept for the visit
 * so an offline tablet still shows it "as of …". The offline pack (`GET /quality/queue/offline`) keeps my open final inspections'
 * sheets on the tablet too, so the bench opens them with the network gone (QHS-062). Words come in Italian and English from the
 * API (kinds, what a row holds up, how long it waits); no person anywhere: whose a row is says MINE or NOBODY only.
 */

const words = z.object({ it: z.string(), en: z.string() })

export const queueRowSchema = z.object({
  key: z.string(),
  kind: z.enum(QUEUE_KINDS),
  kindWords: words,
  recordType: z.string().nullable(),
  id: z.string().nullable(),
  number: z.string().nullable(),
  title: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
  item: z.object({ code: z.string(), name: z.string() }).nullable(),
  bundle: z.object({ id: z.string(), code: z.string() }).nullable(),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  plan: z.object({ code: z.string(), number: z.number() }).nullable(),
  progress: z.object({ done: z.number().nullable(), of: z.number().nullable(), words }).nullable(),
  openedAt: z.string().nullable(),
  waitingSince: z.string().nullable(),
  waiting: z.object({ minutes: z.number(), words }).nullable(),
  dueAt: z.string().nullable(),
  overdue: z.boolean(),
  blocks: z.object({ what: z.enum(BLOCKS), rank: z.number(), needBy: z.string().nullable(), count: z.number().nullable(), words }),
  taken: z.enum(TAKEN),
  may: z.object({ record: z.boolean(), start: z.boolean() }),
  start: z.object({ code: z.string(), stage: z.string() }).nullable(),
})

export const queueSchema = z.object({ asOf: z.string(), rows: z.array(queueRowSchema), capped: z.boolean() }) satisfies z.ZodType<InspectorQueue>

const offlineSchema = z.object({
  asOf: z.string(),
  keepUntil: z.string(),
  rows: z.array(queueRowSchema),
  records: z.array(z.object({ key: z.string(), recordType: z.string(), id: z.string(), kind: z.string(), version: z.number(), model: z.object({ final: z.unknown(), sheet: z.unknown() }).passthrough() })),
  capped: z.boolean(),
})

const KEPT = new AsOfMemory<InspectorQueue>(1)
const KEY = 'mine'

/** My inspections, kept for the visit. */
export async function fetchInspectorQueue(api: ApiClient): Promise<TaskOutcome<InspectorQueue>> {
  const answer = await floorRead(api, '/quality/queue', { query: { scope: 'mine' }, schema: queueSchema })
  if (answer.ok) KEPT.keep(KEY, answer.value)
  return answer
}

export function keptInspectorQueue(): Remembered<InspectorQueue> | null {
  return KEPT.get(KEY)
}

/**
 * The offline pack, read once a visit while online: the queue as of now and my open final inspections' records (W1's view and the
 * sheet), kept so the bench opens them with the network gone. Anything that does not read as a final record is left out.
 */
export async function fetchOfflinePack(api: ApiClient): Promise<TaskOutcome<{ readonly kept: number; readonly keepUntil: string }>> {
  const answer = await floorRead(api, '/quality/queue/offline', { schema: offlineSchema })
  if (!answer.ok) return answer
  let kept = 0
  for (const record of answer.value.records) {
    if (record.recordType !== 'Inspection') continue
    const model = recordModelSchema.safeParse({ final: record.model.final ?? null, sheet: record.model.sheet ?? null })
    if (!model.success || !model.data.final) continue
    keepModel(record.id, model.data)
    kept += 1
  }
  KEPT.keep(KEY, { asOf: answer.value.asOf, rows: answer.value.rows, capped: answer.value.capped })
  return { ok: true, value: { kept, keepUntil: answer.value.keepUntil } }
}
