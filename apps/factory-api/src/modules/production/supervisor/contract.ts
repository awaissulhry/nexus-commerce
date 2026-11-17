import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'

/**
 * B-PR-42a — the production supervisor, set and read by the office (production plan §3 "Supervisor"; lead pick L21; review fixes
 * R-53, R-56). Names only where one customer or one order is open (the pick list, the dialog's answer); the work order list says
 * Me / Someone else / Not set (modules/production/work-orders). Every write takes an Idempotency-Key. Refusals in words: a body
 * field (400, the person's refusals at `body/supervisorId` / `body/backupId`), nothing to change or a stale version (409), a
 * customer the caller does not reach (404, the words of an unknown one).
 */

/** The most people the pick list reads (by name), as the Inquiry assignees' list. */
export const PICK_LIST_MAX = 500
/** The most orders one "Assign supervisor…" sets (lead pick L21). */
export const ORDER_SUPERVISOR_MAX = 100

/** A person named in one customer's or one order's answer: the name, and whether still active ("no longer active"). */
const person = output({ id: id(), name: z.string(), active: z.boolean() })
const orderRef = output({ orderId: id(), number: z.string() })

export const pickListContract = defineContract({
  querystring: input({
    /** The customer. */
    partyId: id(),
    /** One company (an order's): the people allowed there. Left out: allowed at every company of the customer (its default). */
    companyId: id().optional(),
  }),
  response: {
    200: output({
      /** ACTIVE office people who may supervise this customer's production there, by name; nobody is counted. */
      people: z.array(output({ id: id(), name: z.string(), me: z.boolean() })),
      /** False: more office people than the list reads (PICK_LIST_MAX) — some may be missing. */
      complete: z.boolean(),
      /** The customer's open orders with no supervisor of their own: a new default moves them ("moves 7 orders"). */
      ordersOnDefault: z.number().int(),
    }),
  },
})

/** The customer's default supervisor and backup as the office reads them after a change. */
export const customerSupervisorView = output({
  partyId: id(),
  supervisor: person.nullable(),
  backup: person.nullable(),
  /** The portal settings' version (send it back with the next change; 0: the customer had no row). */
  version: z.number().int(),
  ordersOnDefault: z.number().int(),
})

export const customerSupervisorContract = defineContract({
  params: input({ partyId: id() }),
  body: input({
    /** The office person who supervises this customer's production (null: none — and then no backup either). */
    supervisorId: id().nullable(),
    /** The supervisor's backup: only beside a supervisor, never the same person (null: none). */
    backupId: id().nullable(),
    /** The portal settings' version as read (0 when the customer has none yet: the row is made with the portal OFF). */
    version: z.number().int().min(0),
  }),
  response: { 200: output({ customer: customerSupervisorView }) },
})

export const orderSupervisorsContract = defineContract({
  body: input({
    /** Sales orders, 1 to 100, of one or several customers. */
    orderIds: z.array(id()).min(1).max(ORDER_SUPERVISOR_MAX),
    /** The office person (null: back to each order's customer default). */
    supervisorId: id().nullable(),
  }),
  response: {
    200: output({
      supervisor: person.nullable(),
      /** The orders whose own supervisor is now this person (or the default again). */
      changed: z.array(orderRef),
      /** The orders that had it already. */
      unchanged: z.array(orderRef),
      /** Orders the caller sees that were not changed, each with why. */
      skipped: z.array(output({ orderId: id(), number: z.string(), why: z.string() })),
      /** Ids the caller does not see: counted, never named. */
      unknown: z.number().int(),
    }),
  },
})
