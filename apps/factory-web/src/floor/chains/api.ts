import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { floorRead, floorWrite, type TaskOutcome } from '../tasks/shared/task-api'

/**
 * owb-fl9 step 3 — a chain on the floor (server B's fl4; settle 10): ONE step of the device's chain, its lots as big rows.
 *
 *   read    GET /production/chains/:lineId?operationId= → { line, steps, lots } (the same answer the office reads)
 *   +12     POST /production/chains/report { lineId, operationId, workOrderSizeId, clientEventId } → { scan: { id }, bundle: { id, code,
 *           quantity }, operationId }: the server reports the cell's next bundle not yet reported at that step through today's REPORT
 *           (pay, cost and guards unchanged); nothing left → refusal NOTHING_LEFT "Every bundle of this size is done here."
 *   −12     the worker's own Undo of that report (today's two-minute rule): the queue kind `production.scan.undo` { scanId }
 */

const department = z.object({ id: z.string(), number: z.number().int(), name: z.string(), shortName: z.string().nullable().optional(), nameI18n: z.record(z.string(), z.string()).nullable().optional(), tone: z.string(), icon: z.string() })

export const floorChainSchema = z.object({
  line: z.object({ id: z.string(), name: z.string() }).passthrough(),
  steps: z.array(z.object({ operationId: z.string(), name: z.string(), department: department.nullable().optional(), waiting: z.number(), done: z.number(), slowest: z.boolean() })),
  lots: z.array(z.object({ workOrderSizeId: z.string(), model: z.string(), size: z.string(), quantity: z.number().optional(), bundleSize: z.number().optional(), perStep: z.array(z.object({ operationId: z.string(), done: z.number(), waiting: z.number() })) })),
})
export type FloorChain = z.infer<typeof floorChainSchema>
export type FloorChainLot = FloorChain['lots'][number]

const reported = z.object({ scan: z.object({ id: z.string() }), bundle: z.object({ id: z.string(), code: z.string(), quantity: z.number() }), operationId: z.string().optional() })
export type ChainReported = z.infer<typeof reported>

export const readFloorChain = (api: ApiClient, lineId: string, operationId?: string | null): Promise<TaskOutcome<FloorChain>> =>
  floorRead(api, `/production/chains/${encodeURIComponent(lineId)}`, { query: { operationId: operationId ?? undefined }, schema: floorChainSchema })

export interface ReportBody {
  readonly lineId: string
  readonly operationId: string
  readonly workOrderSizeId: string
  readonly clientEventId: string
}

/** "+12": one report of the cell's next bundle (online: the server picks the bundle). */
export const reportNext = (api: ApiClient, body: ReportBody): Promise<TaskOutcome<ChainReported>> =>
  floorWrite(api, 'POST', '/production/chains/report', { body, schema: reported, idempotencyKey: body.clientEventId })
