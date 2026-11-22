import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../../shared/task-api'
import { uploadNoteFile } from '../../scans/api'
import type { FloorAsk } from './model'

/**
 * F-OF-204 (order FILES tab W2; 13-backend B-OF-034, S2) — the tablet's asks for a file: the open floor asks of this site addressed to the
 * worker's team, floor role or a step this station or person holds (`GET /production/floor-notes/asks`, read as the system: never a price,
 * body data, a worker or "seen"), and the answer — a photo onto the ask's work order (online only: the queue keeps no bytes), then the note
 * with `askId` and the tile ASKED_FILE (`POST /production/floor-notes/work-orders/:id`): in the same command the ask arrives at the office.
 * S2 (#1881): the read answers `{ asOf, asks }`; the note's answer says `ask: { id, answered }` (false: closed meanwhile).
 */

const step = z.object({ id: z.string(), seq: z.number(), name: z.string() })
const customer = z.union([z.string(), z.object({ code: z.string() }).passthrough()]).nullable()
const floorAsk = z.object({
  askId: z.string(),
  words: z.string().nullable(),
  fileKind: z.string(),
  dueOn: z.string(),
  lateDays: z.number(),
  workOrder: z.object({ id: z.string(), number: z.string() }),
  step: step.nullable(),
  customer: customer.optional(),
  askedAgain: z.string().nullable().optional(),
  chasedAt: z.string().nullable().optional(),
})
const asksAnswer = z.union([z.array(floorAsk), z.object({ asks: z.array(floorAsk) })])

/** GET /production/floor-notes/asks (floor, production.scan). */
export async function fetchFloorAsks(api: ApiClient): Promise<TaskOutcome<readonly FloorAsk[]>> {
  const answer = await floorRead(api, '/production/floor-notes/asks', { schema: asksAnswer })
  if (!answer.ok) return answer
  const asks = Array.isArray(answer.value) ? answer.value : answer.value.asks
  return {
    ok: true,
    value: asks.map((ask) => ({
      askId: ask.askId,
      words: ask.words,
      dueOn: ask.dueOn,
      lateDays: ask.lateDays,
      workOrder: ask.workOrder,
      step: ask.step,
      customer: ask.customer ? (typeof ask.customer === 'string' ? ask.customer : ask.customer.code) : null,
      askedAgain: ask.askedAgain ?? null,
      chasedAt: ask.chasedAt ?? null,
    })),
  }
}

/** The photo for an ask: up to the work order first (announce, PUT, confirm), then the note that names it with the ask (one try, online). */
export async function sendAskPhoto(api: ApiClient, ask: Pick<FloorAsk, 'askId' | 'workOrder' | 'step'>, photo: Blob, clientEventId: string): Promise<TaskOutcome<{ readonly messageId: string | null; /* S2: false — the ask was closed meanwhile (the photo went on the work order as a note) */ readonly answered: boolean }>> {
  const file = await uploadNoteFile(api, ask.workOrder.id, photo, `ask-${ask.workOrder.number}.jpg`)
  if (!file.ok) return file
  const posted = await floorWrite(api, 'POST', `/production/floor-notes/work-orders/${seg(ask.workOrder.id)}`, {
    body: { clientEventId, tileCode: 'ASKED_FILE', fileIds: [file.value.fileId], askId: ask.askId, ...(ask.step ? { workOrderOperationId: ask.step.id } : {}) },
    schema: z.object({ messageId: z.string().nullable().optional(), ask: z.object({ id: z.string(), answered: z.boolean() }).nullable().optional() }).passthrough(),
    idempotencyKey: clientEventId,
  })
  return posted.ok ? { ok: true, value: { messageId: posted.value.messageId ?? null, answered: posted.value.ask?.answered ?? true } } : posted
}
