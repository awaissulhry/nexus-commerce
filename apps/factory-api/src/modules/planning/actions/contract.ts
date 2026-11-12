import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ACTION_RECORD_TYPES, ACTION_STATUSES, DECISIONS, MAX_DECIDE, MAX_DECISION_NOTE, MRP_ACTIONS } from '@nexus/factory-domain/planning/actions/messages'
import { MAX_BULK_EDIT, MAX_SHIFT_DAYS, MAX_SIZE_QUANTITY } from '@nexus/factory-domain/planning/actions/protect'
import { MAX_SIZES, PROTECTABLE_FIELDS } from '@nexus/factory-domain/planning/planned-orders/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { lineView } from '../contract'
import { plannedOrderView } from '../planned-orders/contract'

/**
 * MRP you can trust (B-W2b-306; PLN-072, PLN-073, PLN-076, PLN-078, PLN-083; design planning.mrp "To make" with its action
 * messages, the protected cell with Reset to plan, the bulk edit with ReviewChangesModal, and the requirement kept for one
 * order). Days are calendar days at the site; quantities are decimal strings with four decimals (garments: whole numbers).
 * No money, no person.
 */

const fact = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const actionMessageView = output({
  id: id(),
  runId: id(),
  siteId: id(),
  /** Its place in the run's list. */
  seq: z.number().int(),
  /** The order it is about; `open` is the record the screen opens (a purchase order line opens its purchase order). */
  record: output({ type: z.enum(ACTION_RECORD_TYPES), id: id(), label: z.string(), open: output({ type: z.string(), id: id() }) }),
  action: z.enum(MRP_ACTIONS),
  /** The action in words ("Expedite"). */
  label: z.string(),
  fromDate: businessDate().nullable(),
  toDate: businessDate().nullable(),
  fromQuantity: z.string().nullable(),
  toQuantity: z.string().nullable(),
  uom: z.enum(UOMS).nullable(),
  /** What to do and why, in words. */
  message: z.string(),
  /** The numbers and days its words are made from (no cost, no person). */
  facts: z.record(z.string(), fact),
  status: z.enum(ACTION_STATUSES),
  decidedAt: instant().nullable(),
  decisionNote: z.string().nullable(),
  version: z.number().int(),
  may: output({ decide: z.boolean() }),
})
export type ActionMessageView = z.infer<typeof actionMessageView>

export const listActionMessagesContract = defineContract({
  querystring: input({
    siteId: id(),
    /** A run of the site; left out: its latest DONE run. */
    runId: id().optional(),
    /** Comma-separated statuses; left out: OPEN. */
    status: z.string().regex(/^(OPEN|DONE|IGNORED)(,(OPEN|DONE|IGNORED))*$/).optional(),
    action: z.enum(MRP_ACTIONS).optional(),
    recordType: z.enum(ACTION_RECORD_TYPES).optional(),
  }),
  response: {
    200: output({
      siteId: id(),
      run: output({ id: id(), startedAt: instant(), finishedAt: instant().nullable() }).nullable(),
      /** Of the run's whole list, never of the filter. */
      counts: output({ open: z.number().int(), done: z.number().int(), ignored: z.number().int() }),
      byAction: z.array(output({ action: z.enum(MRP_ACTIONS), open: z.number().int() })),
      messages: z.array(actionMessageView),
    }),
  },
})

export const decideActionMessagesContract = defineContract({
  body: input({
    messages: z.array(input({ id: id(), version: z.number().int().min(1) })).min(1).max(MAX_DECIDE),
    status: z.enum(DECISIONS),
    note: z.string().trim().max(MAX_DECISION_NOTE).optional(),
  }),
  response: { 200: output({ decided: z.number().int(), messages: z.array(actionMessageView), replayed: z.boolean() }) },
})

const sizeRun = z.array(input({ size: z.string().trim().min(1).max(20), quantity: z.number().int().min(1).max(MAX_SIZE_QUANTITY) })).min(1).max(MAX_SIZES)

/** What an edit may change (a field left out stays as it is; null clears a line, a kit date or the revision). */
const changes = {
  sizes: sizeRun.optional(),
  startDate: businessDate().optional(),
  dueDate: businessDate().optional(),
  lineId: id().nullable().optional(),
  partyId: id().optional(),
  operationSeqs: z.array(z.number().int().min(1)).max(200).optional(),
  kitDueAt: instant().nullable().optional(),
  styleRevisionId: id().nullable().optional(),
}

export const editPlannedOrderContract = defineContract({
  params: input({ plannedOrderId: id() }),
  body: input({ version: z.number().int().min(1), ...changes, note: z.string().trim().max(2000).nullable().optional() }),
  response: { 200: output({ plannedOrder: plannedOrderView, protectedNow: z.array(z.enum(PROTECTABLE_FIELDS)), replayed: z.boolean() }) },
})

export const resetPlannedOrderContract = defineContract({
  params: input({ plannedOrderId: id() }),
  body: input({ version: z.number().int().min(1), fields: z.array(z.enum(PROTECTABLE_FIELDS)).min(1).max(PROTECTABLE_FIELDS.length).optional() }),
  response: {
    200: output({
      plannedOrder: plannedOrderView,
      /** The fields given back to the plan, and whether their plan values came back now (false: the next run writes them). */
      reset: z.array(z.enum(PROTECTABLE_FIELDS)),
      restored: z.boolean(),
      replayed: z.boolean(),
    }),
  },
})

const change = output({ field: z.enum(PROTECTABLE_FIELDS), from: z.unknown(), to: z.unknown() })

export const bulkEditPlannedOrdersContract = defineContract({
  body: input({
    siteId: id(),
    /** Changes for every row (a row's own changes win). */
    set: input(changes).optional(),
    /** Move every row's start, due and kit by whole days (before `set` and the row's own changes). */
    shiftDays: z.number().int().min(-MAX_SHIFT_DAYS).max(MAX_SHIFT_DAYS).refine((value) => value !== 0, { message: 'Move by at least one day.' }).optional(),
    rows: z.array(input({ id: id(), version: z.number().int().min(1), changes: input(changes).optional() })).min(1).max(MAX_BULK_EDIT),
    /** true: the review (ReviewChangesModal): what changes on each row and every problem, nothing written. */
    preview: z.boolean().optional(),
  }),
  response: {
    200: output({
      preview: z.boolean(),
      /** Rows that change (or would). */
      changed: z.number().int(),
      rows: z.array(
        output({
          id: id(),
          /** The row (after the edit, or as it is in a preview). */
          plannedOrder: plannedOrderView.nullable(),
          changes: z.array(change),
          problems: z.array(output({ field: z.string(), message: z.string() })),
        }),
      ),
      replayed: z.boolean(),
    }),
  },
})

export const pegRequirementContract = defineContract({
  params: input({ requirementId: id() }),
  /** orderLineId: the order line the material is kept for alone; null: for every order again. */
  body: input({ version: z.number().int().min(1), orderLineId: id().nullable() }),
  response: { 200: output({ line: lineView, words: z.string(), replayed: z.boolean() }) },
})
