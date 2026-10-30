import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of the Production office screens (SCR-069 … SCR-073), with the answer's shape checked (zod; unknown fields
 * are dropped, so a new API field never breaks a page). The shapes mirror apps/factory-api modules/production/** and
 * inventory/issue contracts; the enum lists mirror factory-domain (production.vitest.test.ts holds them equal). The
 * API's English words (check messages, refusal messages, held stock words) are never drawn: a screen says its own words
 * from the codes. No money anywhere: the work order API carries none.
 */

// W2a wave 5: ON_HOLD (factory-domain production/work-orders/machine).
export const WORK_ORDER_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED', 'ON_HOLD'] as const
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number]
export const RELEASE_CHECKS = ['REVISION', 'LABEL_TEMPLATE', 'CERTIFICATE', 'WORK_CENTRES', 'BOM', 'CELLS', 'DEPOSIT', 'MATERIAL', 'BATCH_NUMBER'] as const
export type ReleaseCheckCode = (typeof RELEASE_CHECKS)[number]
export const CHECK_STATES = ['OK', 'BLOCKED', 'NOT_REQUIRED', 'OVERRIDDEN'] as const
export type CheckState = (typeof CHECK_STATES)[number]
export const UNUSABLE_REASONS = ['CR_VI_PENDING', 'CR_VI_FAILED', 'QUALITY_HOLD', 'BLOCKED', 'REJECTED'] as const
export const HIDE_STATES = ['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED'] as const
export type HideState = (typeof HIDE_STATES)[number]
export const WORK_CENTRE_KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING', 'SUBCONTRACT'] as const
export const INSPECTION_STATUSES = ['OPEN', 'PASSED', 'FAILED', 'CANCELLED'] as const

const status = z.enum(WORK_ORDER_STATUSES)
const progress = z.object({ cut: z.number().nullable(), bundled: z.number().nullable(), sewn: z.number().nullable(), finished: z.number().nullable() })

// ---- work orders ------------------------------------------------------------------------------------------------------------

export const workOrderRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  batchNumber: z.string().nullable(),
  status,
  kind: z.string(),
  version: z.number(),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  styleId: z.string(),
  styleCode: z.string(),
  styleName: z.string(),
  revision: z.number().nullable(),
  colourways: z.array(z.string()),
  orders: z.array(z.object({ id: z.string(), number: z.string(), partyName: z.string() })),
  cells: z.number(),
  pieces: z.number(),
  progress: progress.nullable(),
  dueDate: z.string().nullable(),
  daysLate: z.number().nullable(),
  priority: z.number(),
  releasedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type WorkOrderRow = z.infer<typeof workOrderRowSchema>

const listSchema = z.object({ workOrders: z.array(workOrderRowSchema), nextCursor: z.string().nullable() })
export type WorkOrderPage = z.infer<typeof listSchema>

export interface ListQuery {
  status?: WorkOrderStatus | null
  open?: boolean
  late?: boolean
  q?: string
  salesOrderId?: string
  cursor?: string | null
  limit?: number
}

export function listWorkOrders(api: ApiClient, query: ListQuery, signal?: AbortSignal): Promise<WorkOrderPage> {
  return api.get('/production/work-orders', {
    query: {
      status: query.status ?? undefined,
      open: query.open ? 'true' : undefined,
      late: query.late ? 'true' : undefined,
      q: query.q?.trim() || undefined,
      salesOrderId: query.salesOrderId,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 50,
    },
    schema: listSchema,
    signal,
  })
}

const countsSchema = z.object({ counts: z.object({ draft: z.number(), released: z.number(), inProgress: z.number(), completed: z.number(), open: z.number(), late: z.number() }) })
export type WorkOrderCounts = z.infer<typeof countsSchema>['counts']

export async function countWorkOrders(api: ApiClient, signal?: AbortSignal): Promise<WorkOrderCounts> {
  return (await api.get('/production/work-orders/counts', { schema: countsSchema, signal })).counts
}

const operationSchema = z.object({
  id: z.string().nullable(),
  seq: z.number(),
  routingSeq: z.number(),
  code: z.string(),
  name: z.string(),
  standardMinutes: z.string(),
  scanRequired: z.boolean(),
  workCentreKind: z.string(),
  workCentreId: z.string().nullable(),
  workCentreCode: z.string().nullable(),
})

const materialSchema = z.object({
  itemId: z.string(),
  itemCode: z.string(),
  itemName: z.string(),
  itemColourId: z.string().nullable(),
  colourCode: z.string().nullable(),
  baseUom: z.string(),
  planned: z.string(),
  issued: z.string(),
  balance: z.string(),
})

export const workOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  batchNumber: z.string().nullable(),
  kind: z.string(),
  status,
  version: z.number(),
  companyId: z.string(),
  siteId: z.string(),
  site: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string(), sizes: z.array(z.string()) }),
  revision: z.object({ id: z.string(), revision: z.number(), status: z.string() }).nullable(),
  labelTemplate: z.object({ id: z.string(), code: z.string(), revision: z.number(), status: z.string() }).nullable(),
  dueDate: z.string().nullable(),
  daysLate: z.number().nullable(),
  priority: z.number(),
  note: z.string().nullable(),
  release: z
    .object({
      at: z.string(),
      byId: z.string().nullable(),
      materialOverride: z.object({ reason: z.string(), byId: z.string().nullable(), at: z.string(), shortages: z.array(z.string()) }).nullable(),
    })
    .nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextActions: z.array(status),
  orders: z.array(z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable(), status: z.string(), partyId: z.string(), partyName: z.string(), depositRequired: z.boolean() })),
  cells: z.array(
    z.object({
      id: z.string(),
      version: z.number(),
      colourwayId: z.string(),
      colourwayCode: z.string(),
      colourwayName: z.string(),
      size: z.string(),
      quantity: z.number(),
      salesOrderLineId: z.string(),
      salesOrderId: z.string(),
      lineSeq: z.number(),
      progress,
    }),
  ),
  pieces: z.number(),
  progress: z.object({ counted: z.boolean() }),
  spec: z.object({
    frozen: z.boolean(),
    frozenAt: z.string().nullable(),
    operations: z.array(operationSchema),
    materials: z.array(materialSchema),
    standardMinutes: z.object({ perGarment: z.string(), allPieces: z.string() }),
  }),
})
export type WorkOrder = z.infer<typeof workOrderSchema>
export type WorkOrderCell = WorkOrder['cells'][number]
const oneWorkOrder = z.object({ workOrder: workOrderSchema })

export async function getWorkOrder(api: ApiClient, id: string, signal?: AbortSignal): Promise<WorkOrder> {
  return (await api.get(`/production/work-orders/${encodeURIComponent(id)}`, { schema: oneWorkOrder, signal })).workOrder
}

const issueSchema = z.object({ path: z.string(), message: z.string() })
export const releaseCheckSchema = z.object({
  workOrderId: z.string(),
  status,
  version: z.number(),
  frozen: z.boolean(),
  releasable: z.boolean(),
  checks: z.array(z.object({ code: z.enum(RELEASE_CHECKS), state: z.enum(CHECK_STATES), problems: z.array(issueSchema) })),
  blockers: z.array(issueSchema),
  materials: z.array(
    z.object({
      itemId: z.string(),
      itemColourId: z.string().nullable(),
      label: z.string(),
      baseUom: z.string(),
      planned: z.string(),
      issued: z.string(),
      usable: z.string(),
      committed: z.string(),
      needed: z.string(),
      available: z.string(),
      short: z.string(),
      held: z.array(z.object({ reason: z.enum(UNUSABLE_REASONS), quantity: z.string() })),
    }),
  ),
})
export type ReleaseCheck = z.infer<typeof releaseCheckSchema>

export function getReleaseCheck(api: ApiClient, id: string, signal?: AbortSignal): Promise<ReleaseCheck> {
  return api.get(`/production/work-orders/${encodeURIComponent(id)}/release-check`, { schema: releaseCheckSchema, signal })
}

export async function updateWorkOrder(api: ApiClient, id: string, body: { version: number; dueDate?: string | null; priority?: number; note?: string | null }): Promise<WorkOrder> {
  return (await api.request('PATCH', `/production/work-orders/${encodeURIComponent(id)}`, { body, schema: oneWorkOrder, idempotencyKey: newIdempotencyKey() })).workOrder
}

export async function setCells(api: ApiClient, id: string, body: { version: number; cells: Array<{ salesOrderLineId: string; size: string; quantity: number }> }): Promise<WorkOrder> {
  return (await api.request('PUT', `/production/work-orders/${encodeURIComponent(id)}/cells`, { body, schema: oneWorkOrder, idempotencyKey: newIdempotencyKey() })).workOrder
}

export async function releaseWorkOrder(api: ApiClient, id: string, body: { version: number; materialOverride?: { reason: string } }): Promise<WorkOrder> {
  return (await api.post(`/production/work-orders/${encodeURIComponent(id)}/release`, { body, schema: oneWorkOrder, idempotencyKey: newIdempotencyKey() })).workOrder
}

export type WorkOrderMove = 'start' | 'complete' | 'close'

export async function moveWorkOrder(api: ApiClient, id: string, move: WorkOrderMove, version: number): Promise<WorkOrder> {
  return (await api.post(`/production/work-orders/${encodeURIComponent(id)}/${move}`, { body: { version }, schema: oneWorkOrder, idempotencyKey: newIdempotencyKey() })).workOrder
}

export async function cancelWorkOrder(api: ApiClient, id: string, version: number, reason: string): Promise<WorkOrder> {
  return (await api.post(`/production/work-orders/${encodeURIComponent(id)}/cancel`, { body: { version, reason }, schema: oneWorkOrder, idempotencyKey: newIdempotencyKey() })).workOrder
}

// ---- New work order -----------------------------------------------------------------------------------------------------

const orderOptionSchema = z.object({ id: z.string(), number: z.string(), partyName: z.string(), customerRef: z.string().nullable(), status: z.string(), units: z.number() })
export type OrderOption = z.infer<typeof orderOptionSchema>

/** Open sales orders by number or customer reference (orders.view): what a work order is made from. */
export async function findOrders(api: ApiClient, q: string, signal?: AbortSignal): Promise<OrderOption[]> {
  const answer = await api.get('/sales/orders', { query: { open: 'true', q: q.trim() || undefined, limit: 20 }, schema: z.object({ orders: z.array(orderOptionSchema) }), signal })
  return answer.orders.filter((order) => order.status === 'CONFIRMED' || order.status === 'IN_PRODUCTION')
}

export const openLinesSchema = z.object({
  salesOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }),
  numberPreview: z.string().nullable(),
  lines: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      kind: z.string(),
      styleId: z.string(),
      styleCode: z.string(),
      styleName: z.string(),
      colourwayId: z.string(),
      colourwayCode: z.string(),
      madeToMeasure: z.boolean(),
      sizes: z.array(z.object({ size: z.string(), ordered: z.number(), onWorkOrders: z.number(), open: z.number() })),
    }),
  ),
})
export type OpenLines = z.infer<typeof openLinesSchema>

export function getOpenLines(api: ApiClient, salesOrderId: string, signal?: AbortSignal): Promise<OpenLines> {
  return api.get('/production/work-orders/open-lines', { query: { salesOrderId }, schema: openLinesSchema, signal })
}

export async function createWorkOrder(
  api: ApiClient,
  body: { dueDate?: string; priority?: number; lines: Array<{ salesOrderLineId: string; sizes?: Array<{ size: string; quantity: number }> }> },
): Promise<WorkOrder> {
  return (await api.post('/production/work-orders', { body, schema: oneWorkOrder, idempotencyKey: newIdempotencyKey() })).workOrder
}

// ---- cutting ------------------------------------------------------------------------------------------------------------------

export const cutLogSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status, siteId: z.string() }),
  entries: z.array(
    z.object({
      id: z.string(),
      hideId: z.string(),
      hideCode: z.string(),
      lotCode: z.string(),
      uom: z.string(),
      baseAreaUsed: z.string(),
      baseRemnantArea: z.string(),
      reversalOfId: z.string().nullable(),
      reversedById: z.string().nullable(),
      live: z.boolean(),
      closing: z.boolean(),
      pattern: z.string().nullable(),
      note: z.string().nullable(),
      deviceId: z.string().nullable(),
      deviceTime: z.string().nullable(),
      serverTime: z.string(),
      worker: z.object({ id: z.string(), name: z.string() }).nullable(),
      station: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
      pieces: z.array(z.object({ workOrderSizeId: z.string(), part: z.string(), pieces: z.number() })),
      cells: z.array(z.object({ workOrderSizeId: z.string(), colourwayCode: z.string(), size: z.string() })),
    }),
  ),
  hides: z.array(z.object({ hideId: z.string(), code: z.string(), lotCode: z.string(), state: z.enum(HIDE_STATES), issued: z.string(), cut: z.string(), waste: z.string(), returned: z.string(), left: z.string() })),
  cells: z.array(
    z.object({
      id: z.string(),
      colourwayCode: z.string(),
      size: z.string(),
      quantity: z.number(),
      cut: z.number().nullable(),
      toCut: z.number().nullable(),
      parts: z.array(z.object({ part: z.string(), pieces: z.number(), planned: z.boolean() })),
    }),
  ),
})
export type CutLog = z.infer<typeof cutLogSchema>
export type CutEntry = CutLog['entries'][number]

export function getCutLog(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<CutLog> {
  return api.get(`/production/cutting/work-orders/${encodeURIComponent(workOrderId)}/cut-log`, { schema: cutLogSchema, signal })
}

export function correctCut(api: ApiClient, cutLogId: string, reason: string): Promise<unknown> {
  return api.post(`/production/cutting/cuts/${encodeURIComponent(cutLogId)}/correct`, { body: { reason }, idempotencyKey: newIdempotencyKey() })
}

// ---- bundles ------------------------------------------------------------------------------------------------------------------

const bundleCellSchema = z.object({
  workOrderSizeId: z.string(),
  colourwayCode: z.string(),
  size: z.string(),
  quantity: z.number(),
  cut: z.number().nullable(),
  bundled: z.number(),
  toBundle: z.number(),
  parts: z.array(z.object({ part: z.string(), pieces: z.number(), bundled: z.number(), toBundle: z.number() })),
})

export const workOrderBundlesSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status, siteId: z.string() }),
  cells: z.array(bundleCellSchema),
  bundles: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      replacedCodes: z.array(z.string()),
      workOrderSizeId: z.string(),
      colourwayCode: z.string(),
      size: z.string(),
      part: z.string().nullable(),
      quantity: z.number(),
      status: z.enum(['ACTIVE', 'VOID']),
      voidedAt: z.string().nullable(),
      cutLogIds: z.array(z.string()),
      createdAt: z.string(),
      scans: z.number(),
      doneAt: z.array(z.number()),
      lastScan: z.object({ at: z.string(), operation: z.object({ seq: z.number(), code: z.string() }), station: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable() }).nullable(),
      hides: z.array(z.object({ hideId: z.string(), code: z.string(), lotId: z.string(), lotCode: z.string() })),
      tickets: z.array(z.object({ jobId: z.string(), printerId: z.string(), status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']), createdAt: z.string() })).nullable(),
      reprints: z.array(z.object({ code: z.string(), replacedCode: z.string(), reason: z.string(), printerId: z.string().nullable(), postedBy: z.enum(['FLOOR', 'OFFICE']), at: z.string() })),
    }),
  ),
})
export type WorkOrderBundles = z.infer<typeof workOrderBundlesSchema>
export type BundleRow = WorkOrderBundles['bundles'][number]

export function getBundles(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderBundles> {
  return api.get(`/production/bundles/work-orders/${encodeURIComponent(workOrderId)}/bundles`, { schema: workOrderBundlesSchema, signal })
}

const printersSchema = z.object({
  printers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  defaultPrinterId: z.string().nullable(),
})
export type TicketPrinters = z.infer<typeof printersSchema>

/** The site's active label printers for bundle tickets (production.bundles: the bundles view of the work order). */
export function getTicketPrinters(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<TicketPrinters> {
  return api.get(`/production/bundles/work-orders/${encodeURIComponent(workOrderId)}`, { schema: printersSchema, signal })
}

const reprintSchema = z.object({ bundle: z.object({ id: z.string(), code: z.string() }), replacedCode: z.string(), ticket: z.object({ job: z.object({ id: z.string() }).nullable(), problem: z.string().nullable() }) })

export function reprintBundle(api: ApiClient, bundleId: string, body: { reason: string; printerId: string }): Promise<z.infer<typeof reprintSchema>> {
  return api.post(`/production/bundles/${encodeURIComponent(bundleId)}/reprint`, { body, schema: reprintSchema, idempotencyKey: newIdempotencyKey() })
}

// ---- operations, WIP and scans ---------------------------------------------------------------------------------------------

const flow = { arrived: z.number(), waiting: z.number(), good: z.number(), scrap: z.number(), rework: z.number() }
const bundleCounts = z.object({ done: z.number(), waiting: z.number(), notReached: z.number() })

export const workOrderWipSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status, siteId: z.string() }),
  operations: z.array(
    z.object({
      operationId: z.string(),
      seq: z.number(),
      code: z.string(),
      name: z.string(),
      scanRequired: z.boolean(),
      final: z.boolean(),
      sewn: z.boolean(),
      workCentreKind: z.string(),
      ...flow,
      missing: z.number(),
      bundles: bundleCounts,
      partBundles: bundleCounts,
      cells: z.array(z.object({ workOrderSizeId: z.string(), colourwayCode: z.string(), size: z.string(), ...flow, missing: z.number() })),
      lines: z.array(z.object({ lineId: z.string(), code: z.string(), name: z.string(), good: z.number() })),
    }),
  ),
  cells: z.array(z.object({ workOrderSizeId: z.string(), colourwayCode: z.string(), size: z.string(), quantity: z.number(), bundled: z.number(), sewn: z.number().nullable(), finished: z.number().nullable(), scrapped: z.number(), inRework: z.number() })),
  finalOperationId: z.string().nullable(),
  sewnOperationId: z.string().nullable(),
  allFinished: z.boolean(),
  readyToComplete: z.boolean(),
  correctionsWaiting: z.number(),
})
export type WorkOrderWip = z.infer<typeof workOrderWipSchema>

export function getWorkOrderWip(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderWip> {
  return api.get(`/production/scans/work-orders/${encodeURIComponent(workOrderId)}/wip`, { schema: workOrderWipSchema, signal })
}

export const scansSchema = z.object({
  scans: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['REPORT', 'UNDO', 'CORRECTION']),
      bundleId: z.string(),
      operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }),
      correctsId: z.string().nullable(),
      goodQuantity: z.number(),
      scrapQuantity: z.number(),
      reworkQuantity: z.number(),
      serverTime: z.string(),
      worker: z.object({ id: z.string(), name: z.string() }).nullable(),
      station: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
      voidedById: z.string().nullable(),
    }),
  ),
})
export type BundleScan = z.infer<typeof scansSchema>['scans'][number]

export async function getBundleScans(api: ApiClient, workOrderId: string, bundleId: string, signal?: AbortSignal): Promise<BundleScan[]> {
  return (await api.get(`/production/scans/work-orders/${encodeURIComponent(workOrderId)}/scans`, { query: { bundleId }, schema: scansSchema, signal })).scans
}

export const siteWipSchema = z.object({
  workOrders: z.array(
    z.object({
      workOrder: z.object({ id: z.string(), number: z.string(), status, siteId: z.string() }),
      siteCode: z.string(),
      style: z.object({ code: z.string(), name: z.string() }),
      dueDate: z.string().nullable(),
      daysLate: z.number().nullable(),
      priority: z.number(),
      pieces: z.number(),
      finished: z.number().nullable(),
      operations: z.array(
        z.object({
          operationId: z.string(),
          seq: z.number(),
          code: z.string(),
          name: z.string(),
          scanRequired: z.boolean(),
          final: z.boolean(),
          ...flow,
          bundles: bundleCounts,
          lines: z.array(z.object({ lineId: z.string(), code: z.string(), name: z.string(), good: z.number() })),
        }),
      ),
      allFinished: z.boolean(),
    }),
  ),
})
export type SiteWip = z.infer<typeof siteWipSchema>
export type SiteWipRow = SiteWip['workOrders'][number]

export function getSiteWip(api: ApiClient, signal?: AbortSignal): Promise<SiteWip> {
  return api.get('/production/scans/wip', { query: { limit: 100 }, schema: siteWipSchema, signal })
}

// ---- materials: the pick list ------------------------------------------------------------------------------------------------

export const pickListSchema = z.object({
  workOrder: z.object({ id: z.string(), issuable: z.boolean() }),
  lines: z.array(
    z.object({
      itemId: z.string(),
      itemCode: z.string(),
      itemName: z.string(),
      tracking: z.string(),
      baseUom: z.string(),
      itemColourId: z.string().nullable(),
      colourCode: z.string().nullable(),
      planned: z.string(),
      issued: z.string(),
      toIssue: z.string(),
      over: z.string(),
      covered: z.boolean(),
      usable: z.object({ onHand: z.string(), candidates: z.array(z.object({ lotCode: z.string().nullable(), hideCode: z.string().nullable(), locationCode: z.string(), onHand: z.string() })), more: z.number() }),
      held: z.array(z.object({ reason: z.enum(UNUSABLE_REASONS), lotCode: z.string(), onHand: z.string(), hides: z.number() })),
      atWorkOrder: z.array(z.object({ lotCode: z.string().nullable(), hideCode: z.string().nullable(), quantity: z.string(), cut: z.string(), returnable: z.string() })),
    }),
  ),
})
export type PickList = z.infer<typeof pickListSchema>

export function getPickList(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<PickList> {
  return api.get(`/inventory/picking/work-orders/${encodeURIComponent(workOrderId)}`, { schema: pickListSchema, signal })
}

// ---- quality: inspections and releases (read-only) -------------------------------------------------------------------------

export const finalStateSchema = z.object({
  inspections: z.array(z.object({ id: z.string(), inspectionNumber: z.string().nullable(), label: z.string(), status: z.enum(INSPECTION_STATUSES), lotSize: z.number(), released: z.number(), overridden: z.boolean(), decidedAt: z.string().nullable() })),
  cells: z.array(z.object({ workOrderSizeId: z.string(), colourwayCode: z.string(), size: z.string(), pieces: z.number(), released: z.number(), labelsPrinted: z.number(), releasable: z.number() })),
})
export type FinalState = z.infer<typeof finalStateSchema>

export function getFinalState(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<FinalState> {
  return api.get(`/quality/final/work-orders/${encodeURIComponent(workOrderId)}`, { schema: finalStateSchema, signal })
}
