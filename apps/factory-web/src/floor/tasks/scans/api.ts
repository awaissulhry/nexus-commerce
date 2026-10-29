import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { floorRead, type TaskOutcome } from '../shared/task-api'
import type { BundleCard, CorrectionTarget } from './model'

/**
 * SCR-090's reads (apps/factory-api modules/production/scans, floor + production.scan): the bundle card of a scanned
 * ticket, and the person's own reports today (for "Ask a correction"). Its writes are queued (factory-domain floor-sync
 * `production.scan.report | undo | ask`, through the tablet's queue: they work offline), so none is here.
 */

const kind = z.enum(['REPORT', 'UNDO', 'CORRECTION'])
const operationRef = z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() })
const reason = z.object({ kind: z.enum(['SCRAP', 'REWORK']), code: z.string(), label: z.object({ it: z.string(), en: z.string() }), sortOrder: z.number() })

export const cardSchema = z.object({
  scanned: z.string(),
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
  bundle: z.object({
    id: z.string(),
    code: z.string(),
    status: z.enum(['ACTIVE', 'VOID']),
    quantity: z.number(),
    part: z.string().nullable(),
    workOrderSizeId: z.string(),
    colourwayCode: z.string(),
    colourwayName: z.string(),
    size: z.string(),
  }),
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), siteId: z.string(), style: z.object({ code: z.string(), name: z.string() }) }),
  station: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() }).nullable(),
  operations: z.array(
    operationRef.extend({
      scanRequired: z.boolean(),
      workCentreKind: z.string(),
      final: z.boolean(),
      sewn: z.boolean(),
      state: z.enum(['DONE', 'OPEN', 'NOT_REACHED']),
      expected: z.number().nullable(),
      report: z
        .object({
          scanId: z.string(),
          kind,
          goodQuantity: z.number(),
          scrapQuantity: z.number(),
          reworkQuantity: z.number(),
          serverTime: z.string(),
          station: z.object({ id: z.string(), code: z.string() }).nullable(),
          own: z.boolean(),
        })
        .nullable(),
    }),
  ),
  next: z.string().nullable(),
  choose: z.array(z.string()),
  hint: z.object({ code: z.string(), message: z.string(), fix: z.string() }).nullable(),
  reasons: z.array(reason),
}) satisfies z.ZodType<BundleCard>

/** The bundle card of a scanned ticket (404: not a bundle of this site; 400: another kind of label or a typo). */
export function fetchCard(api: ApiClient, code: string): Promise<TaskOutcome<BundleCard>> {
  return floorRead(api, '/production/scans/card', { query: { code }, schema: cardSchema })
}

const defect = z.object({ kind: z.enum(['SCRAP', 'REWORK']), reason: z.string(), quantity: z.number() })
const mineSchema = z.object({
  since: z.string(),
  undo: z.object({ scanId: z.string(), bundleCode: z.string(), until: z.string() }).nullable(),
  reports: z.array(
    z.object({
      id: z.string(),
      kind,
      bundleCode: z.string(),
      operation: operationRef,
      goodQuantity: z.number(),
      scrapQuantity: z.number(),
      reworkQuantity: z.number(),
      defects: z.array(defect),
      clientScanId: z.string(),
      serverTime: z.string(),
      standing: z.boolean(),
      correctionPending: z.boolean(),
    }),
  ),
})

export interface MineReports {
  /** Today's own reports that stand, newest first (UNDO rows never come). */
  readonly targets: readonly CorrectionTarget[]
}

const perReason = (defects: readonly z.infer<typeof defect>[], kind: 'SCRAP' | 'REWORK') => {
  const out: Record<string, number> = {}
  for (const line of defects) if (line.kind === kind) out[line.reason] = (out[line.reason] ?? 0) + line.quantity
  return out
}

/** The person's own reports today, as correction targets (a report a later one voids is left out). */
export async function fetchMine(api: ApiClient): Promise<TaskOutcome<MineReports>> {
  const answer = await floorRead(api, '/production/scans/mine', { schema: mineSchema })
  if (!answer.ok) return answer
  const targets = answer.value.reports
    .filter((row) => row.standing && row.kind !== 'UNDO')
    .map(
      (row): CorrectionTarget => ({
        key: row.id,
        scanId: row.id,
        clientScanId: row.clientScanId,
        bundleCode: row.bundleCode,
        operation: { seq: row.operation.seq, code: row.operation.code, name: row.operation.name },
        good: row.goodQuantity,
        scrap: perReason(row.defects, 'SCRAP'),
        rework: perReason(row.defects, 'REWORK'),
        at: row.serverTime,
        pending: row.correctionPending,
      }),
    )
  return { ok: true, value: { targets } }
}

const reasonsSchema = z.object({ reasons: z.array(reason) })

/** The scrap and rework reasons (the same list the card carries), for a correction opened without a card. */
export async function fetchReasons(api: ApiClient): Promise<TaskOutcome<readonly z.infer<typeof reason>[]>> {
  const answer = await floorRead(api, '/production/scans/reasons', { schema: reasonsSchema })
  return answer.ok ? { ok: true, value: answer.value.reasons } : answer
}
