import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LABEL_LANGUAGES } from '@nexus/factory-domain/labels/model'
import { REWORK_STATUSES } from '@nexus/factory-domain/production/rework/rules'
import { REPLACEMENT_KINDS, REPLACEMENT_STATUSES } from '@nexus/factory-domain/production/scrap/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { bundleView, ticketAnswerView } from '../bundles/contract'

/**
 * The rework loop (B-W2a-13; MES-126; design production.scrap "Scrap & rework", floor.operation "Rework"). Quantities
 * are garments. No field carries money; no worker is named (a floor rework names nobody; `createdBy` is an office user,
 * only in the office's answers). A refusal by a rework rule is a 409 whose issue path is `refusal/<CODE>`
 * (factory-domain production/rework/rules REWORK_REFUSALS).
 */

const operation = output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() })

export const reworkView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
  cell: output({ id: id(), colourwayCode: z.string(), size: z.string() }),
  /** The bundle carrying them (often split off for it), or null. */
  bundle: output({ id: id(), code: z.string(), status: z.enum(['ACTIVE', 'VOID']), parentBundleId: id().nullable() }).nullable(),
  /** The scan whose rework count opened it, or null (by hand). */
  sourceScanId: id().nullable(),
  /** Where the fault was found (null: outside the routing). */
  foundAt: operation.nullable(),
  /** Where the garments are made again. */
  reworkAt: operation,
  quantity: z.number().int(),
  reasonCode: z.string(),
  reasonLabel: output({ it: z.string(), en: z.string() }).nullable(),
  description: z.string().nullable(),
  /** The record behind it (a nonconformance, a hold), or null. */
  record: output({ type: z.string(), id: id() }).nullable(),
  status: z.enum(REWORK_STATUSES),
  goodQuantity: z.number().int(),
  scrapQuantity: z.number().int(),
  startedAt: instant().nullable(),
  doneAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  /** The office user who opened it; null on the floor's answers and for a rework the floor opened. */
  createdBy: output({ id: id(), name: z.string() }).nullable(),
  /** The replacements of its scrap (office only; null on the floor). */
  replacements: z.array(output({ id: id(), kind: z.enum(REPLACEMENT_KINDS), status: z.enum(REPLACEMENT_STATUSES), quantity: z.number().int() })).nullable(),
})

const openAnswer = output({
  rework: reworkView,
  /** The child bundle split off for it, with its parent (live garments), or null. */
  split: output({ bundle: bundleView, parent: bundleView.extend({ live: z.number().int() }) }).nullable(),
  /** The child's ticket, or null. */
  ticket: ticketAnswerView.nullable(),
  replayed: z.boolean(),
})

export const openReworkContract = defineContract({
  body: input({
    sourceScanId: id().optional(),
    workOrderId: id().optional(),
    workOrderSizeId: id().optional(),
    bundleId: id().nullish(),
    foundAtOperationId: id().nullish(),
    reworkAtOperationId: id(),
    quantity: z.number().int().min(1).max(10_000),
    reasonCode: z.string().trim().min(2).max(40).optional(),
    description: z.string().trim().min(1).max(500).optional(),
    recordType: z.string().trim().min(1).max(60).optional(),
    recordId: id().optional(),
    note: z.string().trim().min(1).max(500).optional(),
    /** False: name the bundle as it is (default: a part of a bundle is split off into a child with its own ticket). */
    split: z.boolean().optional(),
    clientEventId: z.string().trim().min(1).max(80).optional(),
    printerId: id().nullable().optional(),
    language: z.enum(LABEL_LANGUAGES).optional(),
  }),
  response: { 200: openAnswer, 201: openAnswer },
})

const reworkParams = input({ reworkId: id() })
const moveAnswer = output({ rework: reworkView, replayed: z.boolean() })

export const startReworkContract = defineContract({
  params: reworkParams,
  body: input({ version: z.number().int().min(1), note: z.string().trim().min(1).max(500).optional() }),
  response: { 200: moveAnswer, 201: moveAnswer },
})

export const doneReworkContract = defineContract({
  params: reworkParams,
  body: input({ version: z.number().int().min(1), good: z.number().int().min(0).max(10_000), scrap: z.number().int().min(0).max(10_000), note: z.string().trim().min(1).max(500).optional() }),
  response: { 200: moveAnswer, 201: moveAnswer },
})

export const cancelReworkContract = defineContract({
  params: reworkParams,
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(500), note: z.string().trim().min(1).max(500).optional() }),
  response: { 200: moveAnswer, 201: moveAnswer },
})

const statusList = z
  .string()
  .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
  .pipe(z.array(z.enum(REWORK_STATUSES)))

export const listReworkContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    workOrderId: id().optional(),
    bundleId: id().optional(),
    /** Comma-separated statuses. */
    status: statusList.optional(),
    /** true: OPEN and IN_PROGRESS only. */
    open: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ rework: z.array(reworkView), nextCursor: id().nullable() }) },
})

export const reworkRecordContract = defineContract({
  params: reworkParams,
  response: { 200: output({ rework: reworkView }) },
})
