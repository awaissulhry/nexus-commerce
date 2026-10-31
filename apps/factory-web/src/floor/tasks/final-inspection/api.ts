import { z } from 'zod'
import { CHECK_STATES, FOUR_EYES_RULES, RELEASE_CHECKS, SECOND_PERSON_REASONS } from '@nexus/factory-domain/quality/release/rules'
import { DEFECT_CLASSES, INSPECTION_RESULTS, INSPECTION_STATUSES } from '@nexus/factory-domain/quality/final/rules'
import type { ApiClient, HttpMethod } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { floorRead, seg, taskProblemOf, type TaskOutcome } from '../shared/task-api'

/**
 * The bench's calls (SCR-097; apps/factory-api modules/quality/final, production/serials, platform/print): the site's
 * work orders to inspect (`GET /quality/final/work-orders`, by a traveller's number too), one work order's final state
 * (cells and their release checks, the maker check, the four-eyes rule), the inspection (open, record the checklist and
 * the defects, sign), the release, and the garment labels with their print jobs. Every answer is checked against its
 * shape. A write keeps its Idempotency-Key when it is sent again after the PIN (the same action, never twice). Online
 * only: inspections and releases take their number from the office at once (factory-domain floor-sync ONLINE_ONLY).
 */

const decimal = z.union([z.string(), z.number()]).transform(String)

export const benchRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  batchNumber: z.string().nullable(),
  status: z.string(),
  siteId: z.string(),
  dueDate: z.string().nullable(),
  priority: z.number(),
  style: z.object({ code: z.string(), name: z.string() }),
  pieces: z.number(),
  finished: z.number().nullable(),
  released: z.number(),
  openInspectionId: z.string().nullable(),
  ready: z.boolean(),
})
export type BenchRow = z.infer<typeof benchRowSchema>
const benchAnswer = z.object({ workOrders: z.array(benchRowSchema) })

const check = z.object({ code: z.enum(RELEASE_CHECKS), state: z.enum(CHECK_STATES), message: z.string(), fix: z.string().nullable() })

/** A quality hold of the work order as the bench shows it (B-W2a-75): why (both languages), since when, the NCR deciding it. */
export const benchHoldSchema = z.object({
  id: z.string(),
  reasonCode: z.string(),
  reasonIt: z.string(),
  reasonEn: z.string(),
  reasonNote: z.string().nullable(),
  placedAt: z.string(),
  placedBy: z.enum(['USER', 'WORKER', 'SYSTEM']),
  ncrNumber: z.string().nullable(),
})
export type BenchHold = z.infer<typeof benchHoldSchema>

export const finalStateSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), batchNumber: z.string().nullable(), companyId: z.string(), siteId: z.string() }),
  inspectionId: z.string().nullable(),
  inspections: z.array(z.object({ id: z.string(), inspectionNumber: z.string().nullable(), label: z.string(), status: z.enum(INSPECTION_STATUSES), lotSize: z.number(), released: z.number(), overridden: z.boolean(), decidedAt: z.string().nullable() })),
  cells: z.array(
    z.object({
      workOrderSizeId: z.string(),
      colourwayCode: z.string(),
      size: z.string(),
      pieces: z.number(),
      released: z.number(),
      labelsPrinted: z.number(),
      releasable: z.number(),
      readySerials: z.array(z.object({ id: z.string(), serial: z.string() })),
      summary: z.string(),
      checks: z.array(check),
      secondPersonReasons: z.array(z.enum(SECOND_PERSON_REASONS)),
    }),
  ),
  maker: z.object({ made: z.boolean(), words: z.string() }),
  documents: z.array(z.object({ code: z.string(), message: z.string() })),
  rule: z.object({ rule: z.enum(FOUR_EYES_RULES), source: z.string(), words: z.string(), customerListed: z.boolean() }),
  /** B-W2a-75: the work order's ACTIVE quality holds (releasing and packing wait for quality). */
  holds: z.array(benchHoldSchema).default([]),
})
export type FinalState = z.infer<typeof finalStateSchema>

export const inspectionSchema = z.object({
  id: z.string(),
  inspectionNumber: z.string().nullable(),
  label: z.string(),
  workOrderId: z.string(),
  status: z.enum(INSPECTION_STATUSES),
  plan: z.object({ lotSize: z.number(), sampleSize: z.number(), inspectionLevel: z.string(), aqlMajor: decimal, aqlMinor: decimal, acceptMajor: z.number(), acceptMinor: z.number(), hundredPercent: z.boolean() }),
  checklist: z.array(z.object({ code: z.string(), ok: z.boolean().nullable(), note: z.string().nullable() })),
  defects: z.array(z.object({ id: z.string(), defectClass: z.enum(DEFECT_CLASSES), code: z.string(), description: z.string().nullable(), quantity: z.number(), workOrderSizeId: z.string().nullable(), note: z.string().nullable() })),
  counts: z.object({ critical: z.number(), major: z.number(), minor: z.number() }),
  computed: z.object({ result: z.enum(INSPECTION_RESULTS), words: z.string() }),
  overridden: z.boolean(),
  notMakerStatement: z.boolean(),
  decidedAt: z.string().nullable(),
  version: z.number(),
})
export type Inspection = z.infer<typeof inspectionSchema>
const inspectionAnswer = z.object({ inspection: inspectionSchema })

export const inspectionReadSchema = z.object({
  inspection: inspectionSchema,
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), batchNumber: z.string().nullable() }),
  maker: z.object({ made: z.boolean(), words: z.string() }),
  statementNeeded: z.boolean(),
  yours: z.boolean(),
})
export type InspectionRead = z.infer<typeof inspectionReadSchema>

const releaseAnswer = z.object({
  release: z.object({ id: z.string(), releaseNumber: z.string().nullable(), number: z.string(), workOrderSizeId: z.string(), quantity: z.number(), secondPerson: z.object({ reasons: z.array(z.string()), words: z.string() }) }),
  words: z.string(),
})
export type ReleaseAnswer = z.infer<typeof releaseAnswer>

const jobStatus = z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED'])
export const printJobSchema = z.object({ id: z.string(), printerId: z.string(), status: jobStatus, lastError: z.string().nullable(), copies: z.number(), version: z.number(), createdAt: z.string() })
export type PrintJob = z.infer<typeof printJobSchema>
const labelsAnswer = z.object({
  printerId: z.string(),
  printed: z.array(z.object({ workOrderSizeId: z.string(), count: z.number(), job: printJobSchema.nullable(), problem: z.string().nullable(), serials: z.array(z.object({ id: z.string(), serial: z.string(), job: printJobSchema.nullable(), problem: z.string().nullable() })) })),
  refused: z.array(z.object({ code: z.string(), message: z.string(), fix: z.string(), workOrderSizeId: z.string().nullable() })),
  replayed: z.boolean(),
})
export type LabelsAnswer = z.infer<typeof labelsAnswer>

// ---- writes (the maker refusal is a 409 `maker`: the bench says it in its own words) -----------------------------------

async function write<T>(api: ApiClient, method: Exclude<HttpMethod, 'GET'>, path: string, body: unknown, schema: z.ZodType<T>, idempotencyKey: string): Promise<TaskOutcome<T>> {
  try {
    await api.get('/auth/csrf')
    return { ok: true, value: await api.request(method, path, { body, schema, idempotencyKey }) }
  } catch (error) {
    if (isApiError(error) && error.issues.some((issue) => issuePath(issue) === 'maker')) return { ok: false, problem: { kind: 'forbidden', path: 'maker', message: error.issues[0]?.message ?? null } }
    return { ok: false, problem: taskProblemOf(error) }
  }
}

export const freshKey = (): string => newIdempotencyKey()

export const listBench = (api: ApiClient, number?: string) => floorRead(api, '/quality/final/work-orders', { query: { number, limit: number ? 5 : 30 }, schema: benchAnswer })

export const readFinal = (api: ApiClient, workOrderId: string) => floorRead(api, `/quality/final/work-orders/${seg(workOrderId)}`, { schema: finalStateSchema })

export const readInspection = (api: ApiClient, inspectionId: string) => floorRead(api, `/quality/inspections/${seg(inspectionId)}`, { schema: inspectionReadSchema })

export const openInspection = (api: ApiClient, body: { workOrderId: string; lotSize: number; sampleSize: number; inspectionLevel: string; aqlMajor: string; aqlMinor: string; acceptMajor: number; acceptMinor: number }, key: string) =>
  write(api, 'POST', '/quality/inspections', body, inspectionAnswer, key)

export const recordChecklist = (api: ApiClient, inspectionId: string, body: { version: number; checklist: readonly { code: string; ok: boolean | null; note: string | null }[]; notMakerStatement?: boolean }, key: string) =>
  write(api, 'PATCH', `/quality/inspections/${seg(inspectionId)}`, body, inspectionAnswer, key)

export const putDefects = (api: ApiClient, inspectionId: string, body: { version: number; defects: readonly { defectClass: string; code: string; quantity: number }[] }, key: string) =>
  write(api, 'PUT', `/quality/inspections/${seg(inspectionId)}/defects`, body, inspectionAnswer, key)

export const decide = (
  api: ApiClient,
  inspectionId: string,
  body: { version: number; result: 'PASS' | 'FAIL'; checklist: readonly { code: string; ok: boolean | null; note: string | null }[]; notMakerStatement?: boolean; overrideReason?: string | null },
  key: string,
) => write(api, 'POST', `/quality/inspections/${seg(inspectionId)}/decide`, body, inspectionAnswer, key)

export const releaseCell = (api: ApiClient, body: { inspectionId: string; workOrderSizeId: string; quantity: number }, key: string) => write(api, 'POST', '/quality/releases', body, releaseAnswer, key)

export const printLabels = (api: ApiClient, workOrderId: string, cellId: string, key: string) =>
  write(api, 'POST', `/production/serials/work-orders/${seg(workOrderId)}/labels`, { cells: [{ workOrderSizeId: cellId }] }, labelsAnswer, key)

export const readJob = (api: ApiClient, jobId: string) => floorRead(api, `/print/jobs/${seg(jobId)}`, { schema: z.object({ job: printJobSchema }) })

export const retryJob = (api: ApiClient, job: Pick<PrintJob, 'id' | 'version'>) => write(api, 'POST', `/print/jobs/${seg(job.id)}/retry`, { version: job.version }, z.object({ job: printJobSchema }), freshKey())

// ---- Hold lot at the bench (B-W2a-75; design floor.final "Hold lot": a reason, and an NCR) --------------------------------------

const holdAnswer = z.object({ hold: benchHoldSchema, workOrderHeld: z.boolean(), ncr: z.object({ id: z.string(), number: z.string() }), replayed: z.boolean() })
export type HeldAtBench = z.infer<typeof holdAnswer>

/** Holds the work order's garments with a reason and raises the NCR that decides it (ONE call; keep `key` for a resend). */
export const holdLot = (api: ApiClient, workOrderId: string, body: { reasonCode: string; quantity: number; inspectionId?: string | null }, key: string) =>
  write(api, 'POST', `/quality/final/work-orders/${seg(workOrderId)}/hold`, body, holdAnswer, key)

