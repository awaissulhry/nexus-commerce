import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_CELL_PIECES, MAX_CELLS, MAX_LINES } from '@nexus/factory-domain/production/work-orders/cells'
import { WORK_ORDER_KINDS, WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { CHECK_STATES, RELEASE_CHECKS } from '@nexus/factory-domain/production/work-orders/release'
import { UNUSABLE_REASONS } from '@nexus/factory-domain/planning/usable'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'

/**
 * The office's work orders (B-W1-38; MES-001, MES-002, MES-003, MES-005, MES-007, MES-305; A2 SCR-069, SCR-070): the
 * list and the record, a DRAFT from sales order lines and the open lines to make it from, its cells and details, the
 * release check and the release, the moves after it, and the frozen spec against today's master. A version is the
 * edit-conflict guard (COL-078): the work order's version as read. No money anywhere.
 */

const version = z.number().int().min(1).optional()
const status = z.enum(WORK_ORDER_STATUSES)
const size = () => z.string().trim().min(1).max(10)
const issue = output({ path: z.string(), message: z.string() })
const workOrderParams = input({ workOrderId: id() })

const operation = output({
  id: id().nullable(),
  seq: z.number().int(),
  routingSeq: z.number().int(),
  code: z.string(),
  name: z.string(),
  standardMinutes: z.string(),
  scanRequired: z.boolean(),
  workCentreKind: z.enum(WORK_CENTRE_KINDS),
  workCentreId: id().nullable(),
  workCentreCode: z.string().nullable(),
})

const material = output({
  itemId: id(),
  itemCode: z.string(),
  itemName: z.string(),
  itemColourId: id().nullable(),
  colourCode: z.string().nullable(),
  baseUom: z.string(),
  /** Planned, in the base unit, waste included. */
  planned: z.string(),
  /** Issued to the work order by the ledger, net of returns. */
  issued: z.string(),
  balance: z.string(),
  lines: z.array(output({ bomLineId: id(), lineSeq: z.number().int(), placement: z.string().nullable(), uom: z.string(), quantity: z.string() })),
  cells: z.array(output({ cellId: id(), baseQuantity: z.string() })),
})

export const workOrderSchema = output({
  id: id(),
  number: z.string(),
  batchNumber: z.string().nullable(),
  kind: z.enum(WORK_ORDER_KINDS),
  status,
  version: z.number().int(),
  companyId: id(),
  siteId: id(),
  site: output({ id: id(), code: z.string(), name: z.string() }),
  style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string(), sizes: z.array(z.string()) }),
  revision: output({ id: id(), revision: z.number().int(), status: z.string() }).nullable(),
  labelTemplate: output({ id: id(), code: z.string(), revision: z.number().int(), status: z.string() }).nullable(),
  dueDate: businessDate().nullable(),
  daysLate: z.number().int().nullable(),
  priority: z.number().int(),
  note: z.string().nullable(),
  /** From RELEASED on: when, by whom, and the planner's material override (from the release's audit row). */
  release: output({
    at: instant(),
    byId: id().nullable(),
    materialOverride: output({ reason: z.string(), byId: id().nullable(), at: instant(), shortages: z.array(z.string()) }).nullable(),
  }).nullable(),
  startedAt: instant().nullable(),
  completedAt: instant().nullable(),
  closedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: instant(),
  updatedAt: instant(),
  createdById: id().nullable(),
  nextActions: z.array(status),
  orders: z.array(output({ id: id(), number: z.string(), customerRef: z.string().nullable(), status: z.string(), partyId: id(), partyName: z.string(), depositRequired: z.boolean() })),
  cells: z.array(
    output({
      id: id(),
      version: z.number().int(),
      colourwayId: id(),
      colourwayCode: z.string(),
      colourwayName: z.string(),
      size: z.string(),
      quantity: z.number().int(),
      salesOrderLineId: id(),
      salesOrderId: id(),
      lineSeq: z.number().int(),
      /** Counted from the cut log and the floor's scans (B-W1-40, B-W1-42): null until then. */
      progress: output({ cut: z.number().int().nullable(), sewn: z.number().int().nullable(), finished: z.number().int().nullable() }),
    }),
  ),
  pieces: z.number().int(),
  progress: output({ counted: z.boolean(), note: z.string() }),
  spec: output({
    /** DRAFT: what the release would freeze now; from RELEASED on: the frozen rows. */
    frozen: z.boolean(),
    frozenAt: instant().nullable(),
    operations: z.array(operation),
    materials: z.array(material),
    standardMinutes: output({ perGarment: z.string(), allPieces: z.string() }),
  }),
})

const oneWorkOrder = output({ workOrder: workOrderSchema })

export const listContract = defineContract({
  querystring: input({
    status: status.optional(),
    styleId: id().optional(),
    salesOrderId: id().optional(),
    siteId: id().optional(),
    /** Open work orders past their due date (MES-305). */
    late: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      workOrders: z.array(
        output({
          id: id(),
          number: z.string(),
          batchNumber: z.string().nullable(),
          status,
          kind: z.enum(WORK_ORDER_KINDS),
          version: z.number().int(),
          companyId: id(),
          siteId: id(),
          siteCode: z.string(),
          styleId: id(),
          styleCode: z.string(),
          styleName: z.string(),
          revision: z.number().int().nullable(),
          colourways: z.array(z.string()),
          orders: z.array(output({ id: id(), number: z.string(), partyName: z.string() })),
          cells: z.number().int(),
          pieces: z.number().int(),
          /** Cut / sewn / finished come with B-W1-40 and B-W1-42: null until then. */
          progress: z.null(),
          dueDate: businessDate().nullable(),
          daysLate: z.number().int().nullable(),
          priority: z.number().int(),
          releasedAt: instant().nullable(),
          createdAt: instant(),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const openLinesContract = defineContract({
  querystring: input({ salesOrderId: id() }),
  response: {
    200: output({
      salesOrder: output({ id: id(), number: z.string(), status: z.string() }),
      /** The number the next work order of the company gets, when its series says it. */
      numberPreview: z.string().nullable(),
      lines: z.array(
        output({
          id: id(),
          seq: z.number().int(),
          kind: z.string(),
          styleId: id(),
          styleCode: z.string(),
          styleName: z.string(),
          styleRevisionId: id().nullable(),
          colourwayId: id(),
          colourwayCode: z.string(),
          siteId: id().nullable(),
          /** Made-to-measure comes later (B-W1-17/18): such a line is refused. */
          madeToMeasure: z.boolean(),
          sizes: z.array(output({ size: z.string(), ordered: z.number().int(), onWorkOrders: z.number().int(), open: z.number().int() })),
        }),
      ),
    }),
  },
})

export const getContract = defineContract({ params: workOrderParams, response: { 200: oneWorkOrder } })

const pieces = () => z.number().int().min(0).max(MAX_CELL_PIECES)

export const createContract = defineContract({
  body: input({
    /** Default: the lines' site, else the company's only active plant. */
    siteId: id().optional(),
    /** Default: the revision the lines fix, else the style's released one. */
    styleRevisionId: id().optional(),
    /** Default: the earliest promise (or request) of the lines and their orders. */
    dueDate: businessDate().optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    note: z.string().trim().max(2000).nullish(),
    lines: z
      .array(input({ salesOrderLineId: id(), /** Default: every size still open on the line. */ sizes: z.array(input({ size: size(), quantity: pieces() })).min(1).max(MAX_CELLS).optional() }))
      .min(1)
      .max(MAX_LINES),
  }),
  response: { 201: oneWorkOrder },
})

export const cellsContract = defineContract({
  params: workOrderParams,
  body: input({ version, cells: z.array(input({ salesOrderLineId: id(), size: size(), quantity: pieces() })).min(1).max(MAX_CELLS) }),
  response: { 200: oneWorkOrder },
})

export const updateContract = defineContract({
  params: workOrderParams,
  body: input({
    version,
    dueDate: businessDate().nullish(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    note: z.string().trim().max(2000).nullish(),
    styleRevisionId: id().optional(),
  }),
  response: { 200: oneWorkOrder },
})

const check = output({ code: z.enum(RELEASE_CHECKS), state: z.enum(CHECK_STATES), message: z.string(), problems: z.array(issue) })

export const releaseCheckContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrderId: id(),
      number: z.string(),
      status,
      version: z.number().int(),
      /** From RELEASED on the spec is frozen and the checklist is empty: the record shows the frozen spec. */
      frozen: z.boolean(),
      releasable: z.boolean(),
      checks: z.array(check),
      blockers: z.array(issue),
      materials: z.array(
        output({
          itemId: id(),
          itemColourId: id().nullable(),
          label: z.string(),
          baseUom: z.string(),
          planned: z.string(),
          issued: z.string(),
          usable: z.string(),
          committed: z.string(),
          needed: z.string(),
          available: z.string(),
          short: z.string(),
          held: z.array(output({ reason: z.enum(UNUSABLE_REASONS), quantity: z.string() })),
        }),
      ),
    }),
  },
})

export const releaseContract = defineContract({
  params: workOrderParams,
  body: input({ version, materialOverride: input({ reason: z.string().trim().min(3).max(500) }).optional() }),
  response: { 200: oneWorkOrder },
})

export const moveContract = defineContract({ params: workOrderParams, body: input({ version }), response: { 200: oneWorkOrder } })

export const cancelContract = defineContract({ params: workOrderParams, body: input({ version, reason: z.string().trim().min(1).max(500) }), response: { 200: oneWorkOrder } })

const lineRef = output({ lineId: id(), seq: z.number().int(), itemId: id(), code: z.string(), placement: z.string().nullable(), colourwayId: id().nullable() })
const stepRef = output({ stepId: id(), seq: z.number().int(), code: z.string(), name: z.string(), standardMinutes: z.string() })
const fieldChange = output({ field: z.string(), from: z.union([z.string(), z.number(), z.boolean(), z.null()]), to: z.union([z.string(), z.number(), z.boolean(), z.null()]) })
const revisionRef = output({ id: id(), revision: z.number().int(), status: z.string() })
const labelRef = output({ id: id(), code: z.string(), revision: z.number().int(), status: z.string() })

export const compareContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrderId: id(),
      number: z.string(),
      frozen: z.boolean(),
      revision: revisionRef,
      label: labelRef.nullable(),
      master: output({ revision: revisionRef, label: labelRef.nullable() }).nullable(),
      sameRevision: z.boolean(),
      noMaster: z.boolean(),
      summary: z.array(z.string()),
      bom: output({
        revision: z.array(fieldChange),
        added: z.array(lineRef),
        removed: z.array(lineRef),
        changed: z.array(
          output({
            from: lineRef,
            to: lineRef,
            fields: z.array(fieldChange),
            sizes: z.array(output({ size: z.string(), from: z.string().nullable(), to: z.string().nullable() })),
            colours: z.array(output({ colourwayId: id(), from: z.string().nullable(), to: z.string().nullable() })),
          }),
        ),
        unchanged: z.number().int(),
      }).nullable(),
      routing: output({
        added: z.array(stepRef),
        removed: z.array(stepRef),
        changed: z.array(output({ from: stepRef, to: stepRef, fields: z.array(fieldChange) })),
        unchanged: z.number().int(),
        minutes: output({ from: z.string(), to: z.string() }),
      }).nullable(),
      labelChanged: z.boolean(),
      certificate: output({ state: z.enum(CHECK_STATES), message: z.string(), problems: z.array(issue) }),
    }),
  },
})
