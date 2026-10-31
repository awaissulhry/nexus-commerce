import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'
import type { JobState, SplitReason } from './model'

/**
 * Bundles & tickets' calls (apps/factory-api modules/production/bundles, platform/print; B-W1-41): the work orders whose
 * cut waits for bundles, a work order at the bundles step, a scanned ticket, the reprint and the void of a bundle, and a
 * bundle's ticket print jobs (`recordType` Bundle, the print job's record) with Retry. Making bundles is NOT here: it is
 * the queued kind `production.bundles.make` (ONE bundle per event; floor/queue), so it works offline. Every answer is
 * checked against the part of its shape the screen reads (zod drops the rest); no field carries money or a person.
 */

const style = z.object({ id: z.string(), code: z.string(), name: z.string() })

const cell = z.object({
  workOrderSizeId: z.string(),
  colourwayCode: z.string(),
  size: z.string(),
  quantity: z.number(),
  cut: z.number().nullable(),
  bundled: z.number(),
  toBundle: z.number(),
})

const workOrdersAnswer = z.object({
  workOrders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      batchNumber: z.string().nullable(),
      status: z.string(),
      dueDate: z.string().nullable(),
      style,
      toBundle: z.number(),
      cells: z.array(cell),
    }),
  ),
})
export type BundleWorkOrder = z.infer<typeof workOrdersAnswer>['workOrders'][number]

const bundle = z.object({
  id: z.string(),
  code: z.string(),
  replacedCodes: z.array(z.string()),
  workOrderId: z.string(),
  workOrderSizeId: z.string(),
  colourwayCode: z.string(),
  size: z.string(),
  part: z.string().nullable(),
  quantity: z.number(),
  status: z.enum(['ACTIVE', 'VOID']),
  clientEventId: z.string().nullable(),
  /** W2a (B-W2a-13, MES-071): the bundle it was split off, or null. */
  parentBundleId: z.string().nullable().optional(),
  version: z.number(),
  createdAt: z.string(),
})

const operation = z.object({ seq: z.number(), code: z.string(), name: z.string() })

const orderAnswer = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), kind: z.string(), siteId: z.string(), open: z.boolean(), style }),
  bundleSize: z.number(),
  standardBundleSize: z.number(),
  singlePiece: z.boolean(),
  cells: z.array(cell.extend({ proposal: z.array(z.number()) })),
  bundles: z.array(bundle.extend({ scans: z.number() })),
  operations: z.array(operation.extend({ id: z.string() })),
  printers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  stationPrinterId: z.string().nullable(),
  defaultPrinterId: z.string().nullable(),
})
export type BundleOrder = z.infer<typeof orderAnswer>

const ticket = z.object({
  code: z.string(),
  workOrder: z.object({ number: z.string(), batchNumber: z.string().nullable() }),
  style: z.object({ code: z.string(), name: z.string() }),
  colourway: z.object({ code: z.string(), name: z.string() }),
  size: z.string(),
  quantity: z.number(),
  part: z.string().nullable(),
  operations: z.array(operation),
})
export type TicketAnswerContent = z.infer<typeof ticket>

const scanAnswer = z.object({
  scanned: z.string(),
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
  bundle: bundle.extend({ scans: z.number() }),
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), style }),
  operations: z.array(operation.extend({ id: z.string(), done: z.boolean() })),
  ticket,
})
export type ScannedBundle = z.infer<typeof scanAnswer>

const job = z.object({ id: z.string(), status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']), version: z.number(), scanId: z.string().nullable(), lastError: z.string().nullable(), createdAt: z.string() })

const ticketAnswer = z.object({ bundleId: z.string(), code: z.string(), ticket, job: job.nullable(), problem: z.string().nullable() })

const reprintAnswer = z.object({ bundle, replacedCode: z.string(), ticket: ticketAnswer, replayed: z.boolean() })
export type Reprinted = z.infer<typeof reprintAnswer>

const voidAnswer = z.object({ bundle, cell, replayed: z.boolean() })
export type Voided = z.infer<typeof voidAnswer>

/** B-W2a-75: a split (MES-071): the child bundle with its ticket, the parent with the garments still in it. */
const splitAnswer = z.object({ bundle, parent: bundle.extend({ live: z.number() }), ticket: ticketAnswer, replayed: z.boolean() })
export type SplitDone = z.infer<typeof splitAnswer>

/** The work orders whose cut waits for bundles; `number`: that one (the traveller), even when nothing waits. */
export function fetchWorkOrders(api: ApiClient, number?: string): Promise<TaskOutcome<BundleWorkOrder[]>> {
  return floorRead(api, '/production/bundles/work-orders', { query: { number, limit: number ? 1 : 30 }, schema: workOrdersAnswer }).then((outcome) =>
    outcome.ok ? { ok: true, value: outcome.value.workOrders } : outcome,
  )
}

export function fetchOrder(api: ApiClient, workOrderId: string, bundleSize?: number): Promise<TaskOutcome<BundleOrder>> {
  return floorRead(api, `/production/bundles/work-orders/${seg(workOrderId)}`, { query: { bundleSize }, schema: orderAnswer })
}

export function scanBundle(api: ApiClient, code: string): Promise<TaskOutcome<ScannedBundle>> {
  return floorRead(api, '/production/bundles/scan', { query: { code }, schema: scanAnswer })
}

export function reprintBundle(api: ApiClient, bundleId: string, body: { reason: string; language?: 'it' | 'en' }, idempotencyKey: string): Promise<TaskOutcome<Reprinted>> {
  return floorWrite(api, 'POST', `/production/bundles/${seg(bundleId)}/reprint`, { body, schema: reprintAnswer, idempotencyKey })
}

export function voidBundle(api: ApiClient, bundleId: string, reason: string, idempotencyKey: string): Promise<TaskOutcome<Voided>> {
  return floorWrite(api, 'POST', `/production/bundles/${seg(bundleId)}/void`, { body: { reason }, schema: voidAnswer, idempotencyKey })
}

/**
 * B-W2a-75 (design floor.bundles "Split a bundle"): `quantity` garments off into a child bundle with its own ticket,
 * printed where a reprint prints (the station's printer, else the site's only one). Online only, as reprint and void.
 */
export function splitBundle(api: ApiClient, bundleId: string, body: { quantity: number; reason: SplitReason; language?: 'it' | 'en' }, idempotencyKey: string): Promise<TaskOutcome<SplitDone>> {
  return floorWrite(api, 'POST', `/production/bundles/${seg(bundleId)}/split`, { body, schema: splitAnswer, idempotencyKey })
}

/** The print jobs of a bundle's tickets (the bundles module queues each ticket with `recordType: 'Bundle'`), newest first. */
export function fetchTicketJobs(api: ApiClient, bundleId: string): Promise<TaskOutcome<JobState[]>> {
  return floorRead(api, '/print/jobs', { query: { recordType: 'Bundle', recordId: bundleId }, schema: z.object({ jobs: z.array(job) }) }).then((outcome) =>
    outcome.ok ? { ok: true, value: outcome.value.jobs } : outcome,
  )
}

/** A failed ticket printed again (the same job, queued again). */
export function retryJob(api: ApiClient, current: Pick<JobState, 'id' | 'version'>, idempotencyKey: string): Promise<TaskOutcome<JobState>> {
  return floorWrite(api, 'POST', `/print/jobs/${seg(current.id)}/retry`, { body: { version: current.version }, schema: z.object({ job }), idempotencyKey }).then((outcome) =>
    outcome.ok ? { ok: true, value: outcome.value.job } : outcome,
  )
}
