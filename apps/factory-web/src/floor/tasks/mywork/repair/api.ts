import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { onlineFirst, type KeepsActions } from '../../../queue/online-first'
import { AsOfMemory, type Remembered } from '../../shared/as-of'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../../shared/task-api'
import type { RepairQueue } from './model'

/**
 * My work's repair queue (B-W2b-126; apps/factory-api modules/production/repair, floor + production.repair): the site's open
 * rework at the repair station (`GET /production/repair/station`), kept for the visit so an offline tablet still shows it "as
 * of …", and a bundle scanned in or out (`POST /production/repair/:id/in|out`) online first: a network failure keeps the scan
 * on the tablet (kind `production.repair.scan`) under the try's id, with the tablet's time, so the office's answer to the
 * retry is the try's own (B-W2b-77). The API's English words are never shown.
 */

const operation = z.object({ seq: z.number(), code: z.string(), name: z.string() })

const row = z.object({
  reworkId: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), dueDate: z.string().nullable(), rush: z.boolean(), holdReason: z.string().nullable(), style: z.object({ code: z.string(), name: z.string() }) }),
  cell: z.object({ id: z.string(), colourwayCode: z.string(), size: z.string() }),
  bundle: z.object({ id: z.string(), code: z.string(), part: z.string().nullable() }).nullable(),
  quantity: z.number(),
  reason: z.object({ code: z.string(), it: z.string().nullable(), en: z.string().nullable() }),
  description: z.string().nullable(),
  foundAt: operation.nullable(),
  reworkAt: operation,
  state: z.enum(['WAITING', 'IN_REPAIR']),
  here: z.boolean(),
  station: z.object({ id: z.string(), code: z.string() }).nullable(),
  inAt: z.string().nullable(),
  since: z.string(),
  held: z.boolean(),
  version: z.number(),
})

export const repairQueueSchema = z.object({
  asOf: z.string(),
  station: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  rows: z.array(row),
  counts: z.object({ here: z.number(), waiting: z.number(), inRepair: z.number() }),
}) satisfies z.ZodType<RepairQueue>

const scanAnswer = z.object({
  repair: z.object({
    reworkId: z.string(),
    workOrder: z.object({ id: z.string(), number: z.string() }),
    status: z.string(),
    step: z.enum(['IN', 'OUT']),
    repairInAt: z.string().nullable(),
    repairOutAt: z.string().nullable(),
    goodQuantity: z.number(),
    scrapQuantity: z.number(),
    version: z.number(),
    row: row.nullable(),
  }),
  replayed: z.boolean(),
})
export type ScanAnswer = z.infer<typeof scanAnswer>

const KEPT = new AsOfMemory<RepairQueue>(1)
const KEY = 'repair'

/** The repair queue, kept for the visit. */
export async function fetchRepairQueue(api: ApiClient): Promise<TaskOutcome<RepairQueue>> {
  const answer = await floorRead(api, '/production/repair/station', { schema: repairQueueSchema })
  if (answer.ok) KEPT.keep(KEY, answer.value)
  return answer
}

export function keptRepairQueue(): Remembered<RepairQueue> | null {
  return KEPT.get(KEY)
}

export interface RepairScan {
  readonly reworkId: string
  readonly step: 'IN' | 'OUT'
  /** The bundle label scanned (left out: a rework with no bundle). */
  readonly code?: string
  readonly good?: number
  readonly scrap?: number
}

/**
 * The Idempotency-Key of a scan tried online: the key the office gives the same scan when it comes through the queue
 * (`<device>.<client event id>`, platform/floor-sync sync.ts): the try and the queued retry are ONE command.
 */
export const scanKey = (deviceId: string | null, clientEventId: string): string => (deviceId ? `${deviceId}.${clientEventId}` : clientEventId)

export const postScan = (api: ApiClient, scan: RepairScan, key: string): Promise<TaskOutcome<ScanAnswer>> =>
  floorWrite(api, 'POST', `/production/repair/${seg(scan.reworkId)}/${scan.step === 'IN' ? 'in' : 'out'}`, {
    body: { ...(scan.code ? { code: scan.code } : {}), ...(scan.step === 'OUT' ? { good: scan.good ?? 0, scrap: scan.scrap ?? 0 } : {}) },
    schema: scanAnswer,
    idempotencyKey: key,
  })

/** A scan, online first: a network failure keeps it on the tablet (`production.repair.scan`) under the try's id. */
export const scanOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, scan: RepairScan) =>
  onlineFirst(queue, {
    online,
    kind: 'production.repair.scan',
    payload: { reworkId: scan.reworkId, step: scan.step, ...(scan.code ? { code: scan.code } : {}), ...(scan.step === 'OUT' ? { good: scan.good ?? 0, scrap: scan.scrap ?? 0 } : {}) },
    attempt: (clientEventId) => postScan(api, scan, scanKey(deviceId, clientEventId)),
  })
