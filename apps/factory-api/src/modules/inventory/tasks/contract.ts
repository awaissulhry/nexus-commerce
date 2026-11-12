import { z } from 'zod'
import { defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { TASK_AUDIENCES, TASK_KINDS, TASK_LIMITS, TASK_SOURCE_TYPES, TASK_STATUSES } from '@nexus/factory-domain/inventory/tasks/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * The warehouse task inbox (B-W2b-292; SCM-274): the tablet's inbox and its steps, the office's list, one task, a task by hand,
 * its change and its cancel. No field carries money; no list names a person (a task is for a role, a person or anyone); the
 * office's one-task read names who took and did it only where the site's PERFORMANCE gate is open.
 */

const version = () => z.number().int().min(1)
const place = output({ id: id(), code: z.string(), name: z.string(), kind: z.string() })

export const taskView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  kind: z.enum(TASK_KINDS),
  status: z.enum(TASK_STATUSES),
  /** The record that made it (its model name and id); null: by hand. */
  source: output({ type: z.string(), id: id() }).nullable(),
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.string() }).nullable(),
  colour: output({ code: z.string(), name: z.string() }).nullable(),
  lot: output({ id: id(), code: z.string() }).nullable(),
  hide: output({ id: id(), code: z.string() }).nullable(),
  from: place.nullable(),
  /** Where it goes: a put-away's suggestion (the bin scanned confirms it), a move's or a quarantine move's place. */
  to: place.nullable(),
  quantity: z.string().nullable(),
  uom: z.string().nullable(),
  /** For one person, a floor role, or anyone at the site. */
  assigned: z.enum(['PERSON', 'ROLE', 'ANYONE']),
  assignedRoleId: id().nullable(),
  dueAt: instant().nullable(),
  takenAt: instant().nullable(),
  doneAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  /** The tablet only: for this worker, their role, anyone; and whether it is in their hands. */
  audience: z.enum(TASK_AUDIENCES).optional(),
  mine: z.boolean().optional(),
})

const params = input({ taskId: id() })
const one = output({ task: taskView })

// ---- the tablet --------------------------------------------------------------------------------------------------------

export const inboxContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      tasks: z.array(taskView),
      /** What waits per kind (the Home tiles' counts: "a count on the Move tile"). */
      counts: output(Object.fromEntries(TASK_KINDS.map((kind) => [kind, z.number().int()])) as Record<(typeof TASK_KINDS)[number], z.ZodNumber>),
      /** True when more tasks wait than the inbox shows. */
      more: z.boolean(),
    }),
  },
})

/** The version the tablet read; left out (a queued step): as the task stands when it arrives. */
export const stepBody = input({ version: version().optional() })
export const takeContract = defineContract({ params, body: stepBody, response: { 200: one } })
export const giveBackContract = defineContract({ params, body: stepBody, response: { 200: one } })

export const doneBody = input({
  version: version().optional(),
  /** A quarantine move: the quarantine place's label, scanned (the scan is the confirmation). */
  placeCode: z.string().trim().min(1).max(80).optional(),
  occurredAt: instant().optional(),
})

export const doneContract = defineContract({
  params,
  body: doneBody,
  response: {
    200: output({
      task: taskView,
      /** A quarantine move: what moved into the place and what stays where it is (at an outside workshop). */
      moved: z.array(output({ fromCode: z.string(), onHand: z.string(), uom: z.string() })).optional(),
      stays: z.array(output({ atCode: z.string(), onHand: z.string(), uom: z.string() })).optional(),
    }),
  },
})

// ---- the office --------------------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    status: z.enum(['OPEN', 'DONE', 'CANCELLED', 'ALL']).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    sourceType: z.enum(TASK_SOURCE_TYPES).optional(),
    sourceId: id().optional(),
  }),
  response: {
    200: output({
      tasks: z.array(taskView),
      /** Open tasks per kind at the sites read (OPEN and TAKEN). */
      counts: output(Object.fromEntries(TASK_KINDS.map((kind) => [kind, z.number().int()])) as Record<(typeof TASK_KINDS)[number], z.ZodNumber>),
      more: z.boolean(),
    }),
  },
})

export const recordContract = defineContract({
  params,
  response: {
    200: output({
      task: taskView,
      /** Who took it and who did it (a worker by name only where the site's PERFORMANCE gate is open; an office user by id). */
      takenBy: output({ id: id().nullable(), name: z.string().nullable(), worker: z.boolean(), hidden: z.boolean() }).nullable(),
      doneBy: output({ id: id().nullable(), name: z.string().nullable(), worker: z.boolean(), hidden: z.boolean() }).nullable(),
      /** For whom, when it is one person: their name only where the site's gate is open. */
      assignedTo: output({ id: id().nullable(), name: z.string().nullable(), hidden: z.boolean() }).nullable(),
    }),
  },
})

const assignment = {
  /** A floor role (its workers at the site). */
  assignedRoleId: id().nullish(),
  /** One worker of the site. */
  assignedWorkerId: id().nullish(),
}

export const createContract = defineContract({
  body: input({
    siteId: id(),
    kind: z.enum(['RECEIVE', 'PUT_AWAY', 'PICK', 'MOVE', 'COUNT']),
    itemId: id().nullish(),
    itemColourId: id().nullish(),
    lotId: id().nullish(),
    hideId: id().nullish(),
    fromLocationId: id().nullish(),
    toLocationId: id().nullish(),
    quantity: quantity().nullish(),
    uom: z.enum(UOMS).nullish(),
    ...assignment,
    dueAt: instant().nullish(),
    note: z.string().trim().max(TASK_LIMITS.note).nullish(),
    /** A record it is for (a purchase order to receive, a work order to pick, a transfer). */
    source: input({ type: z.enum(['PurchaseOrder', 'WorkOrder', 'TransferOrder', 'GoodsReceipt']), id: id() }).nullish(),
  }),
  response: { 201: one },
})

export const changeContract = defineContract({
  params,
  body: input({
    version: version(),
    fromLocationId: id().nullish(),
    toLocationId: id().nullish(),
    quantity: quantity().nullish(),
    uom: z.enum(UOMS).nullish(),
    ...assignment,
    dueAt: instant().nullish(),
    note: z.string().trim().max(TASK_LIMITS.note).nullish(),
  }),
  response: { 200: one },
})

export const cancelContract = defineContract({
  params,
  body: input({ version: version(), reason: z.string().trim().min(1).max(TASK_LIMITS.cancelReason) }),
  response: { 200: one },
})
