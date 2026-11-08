import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { SECONDARY_KINDS, SECONDARY_LIMITS, SECONDARY_PLACES, SECONDARY_STATUSES } from '@nexus/factory-domain/production/cutissue/secondary'
import { CUT_ISSUE_STATUSES, TROLLEY_LIMITS, TROLLEY_WARNINGS } from '@nexus/factory-domain/production/cutissue/trolley'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { PROCESS_VIEWS } from './secondary'
import { TROLLEY_VIEWS } from './trolleys'

/**
 * Secondary processes and trolleys to sewing (B-W2b-117; MES-047, MES-048): the contracts of ./secondary.ts and ./trolleys.ts.
 * Quantities are garments. No field carries money (an outside process names its subcontract order, never its fee; a tablet reads
 * none); no worker is named. A rule's refusal is a 409 whose issue path is `refusal/<CODE>` (factory-domain
 * production/cutissue SECONDARY_REFUSALS, TROLLEY_REFUSALS; FLOOR_NOT_READY from the floor's gate).
 */

const words = output({ it: z.string(), en: z.string() })
const count = z.number().int()
const ref = output({ id: id(), code: z.string(), name: z.string() })
const code = () => z.string().trim().min(1).max(60)
const trolley = z.string().trim().min(1).max(TROLLEY_LIMITS.code + 10)
const listLimit = <N extends number>(max: N) => z.coerce.number().int().min(1).max(max).optional()

// ---- secondary processes ----------------------------------------------------------------------------------------------------------

export const processView = output({
  id: id(),
  workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
  bundle: output({ id: id(), code: z.string(), part: z.string().nullable() }),
  cell: output({ id: id(), colourwayCode: z.string(), size: z.string() }),
  seq: count,
  kind: z.enum(SECONDARY_KINDS),
  /** The kind in words ("termoadesivatura" / "fusing"). */
  words,
  place: z.enum(SECONDARY_PLACES),
  workCentre: ref.nullable(),
  /** OUTSIDE, sent: its subcontract order (office answers only; never its fee). */
  subcontractOrder: output({ id: id(), number: z.string(), status: z.string() }).nullable(),
  quantity: count,
  status: z.enum(SECONDARY_STATUSES),
  startedAt: instant().nullable(),
  doneAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: instant(),
  version: count,
})

export const listProcessesContract = defineContract({
  querystring: input({
    view: z.enum(PROCESS_VIEWS).optional(),
    siteId: id().optional(),
    workOrderId: id().optional(),
    workCentreId: id().optional(),
    kind: z.enum(SECONDARY_KINDS).optional(),
    place: z.enum(SECONDARY_PLACES).optional(),
    cursor: id().optional(),
    limit: listLimit(SECONDARY_LIMITS.rows),
  }),
  response: { 200: output({ rows: z.array(processView), nextCursor: id().nullable(), tiles: output({ waiting: count, inProgress: count, done: count, cancelled: count }) }) },
})

export const bundleProcessesContract = defineContract({
  querystring: input({ code: code().optional(), bundleId: id().optional() }),
  response: {
    200: output({
      bundle: output({ id: id(), code: z.string(), part: z.string().nullable(), status: z.enum(['ACTIVE', 'VOID']), live: count }),
      workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
      cell: output({ id: id(), colourwayCode: z.string(), size: z.string() }),
      processes: z.array(processView),
      /** What a tap after the scan does here (null: no process open). */
      next: output({ processId: id(), move: z.enum(['start', 'done']), words }).nullable(),
      /** Why the bundle does not go to sewing yet (null: every process passed). */
      toSewing: words.nullable(),
      /** The trolley it is on (loading, on its way or received at a line). */
      trolley: output({ trolleyCode: z.string(), status: z.string() }).nullable(),
    }),
  },
})

export const addProcessesContract = defineContract({
  body: input({
    /** Each bundle by its ticket's code or its id. */
    bundles: z.array(input({ code: code().optional(), bundleId: id().optional() })).min(1).max(SECONDARY_LIMITS.bundles),
    kind: z.enum(SECONDARY_KINDS),
    place: z.enum(SECONDARY_PLACES),
    workCentreId: id().nullish(),
    /** Garments it is done on (default: each bundle's). */
    quantity: z.number().int().min(1).max(10_000).optional(),
    note: z.string().trim().max(SECONDARY_LIMITS.note).nullish(),
  }),
  response: { 201: output({ processes: z.array(processView), replayed: z.boolean() }) },
})

const processParams = input({ processId: id() })
const moved = { 200: output({ process: processView, replayed: z.boolean() }) }
export const startProcessContract = defineContract({ params: processParams, body: input({ version: z.number().int().min(1).optional(), workCentreId: id().optional(), subcontractOrderId: id().optional() }), response: moved })
export const doneProcessContract = defineContract({ params: processParams, body: input({ version: z.number().int().min(1).optional() }), response: moved })
export const cancelProcessContract = defineContract({ params: processParams, body: input({ version: z.number().int().min(1).optional(), reason: z.string().trim().min(1).max(SECONDARY_LIMITS.reason) }), response: moved })

// ---- trolleys -------------------------------------------------------------------------------------------------------------------

export const trolleyView = output({
  id: id(),
  /** The trolley's label. */
  trolleyCode: z.string(),
  status: z.enum(CUT_ISSUE_STATUSES),
  line: ref,
  sentAt: instant().nullable(),
  receivedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  /** The differences found at the line, in words (null: none). */
  note: z.string().nullable(),
  counts: output({ bundles: count, received: count, missing: count }),
  /** "Send 12 bundles to line L2". */
  send: words,
  /** Each bundle on it (lists: empty). */
  bundles: z.array(
    output({
      id: id(),
      bundle: output({ id: id(), code: z.string(), part: z.string().nullable(), quantity: count }),
      workOrder: output({ id: id(), number: z.string() }),
      cell: output({ colourwayCode: z.string(), size: z.string() }),
      receivedAt: instant().nullable(),
    }),
  ),
  createdAt: instant(),
  version: count,
})

export const listTrolleysContract = defineContract({
  querystring: input({ view: z.enum(TROLLEY_VIEWS).optional(), siteId: id().optional(), lineId: id().optional(), q: z.string().trim().max(60).optional(), cursor: id().optional(), limit: listLimit(TROLLEY_LIMITS.rows) }),
  response: { 200: output({ rows: z.array(trolleyView), nextCursor: id().nullable(), tiles: output({ loading: count, sent: count, received: count, cancelled: count }) }) },
})

export const trolleyRecordContract = defineContract({ params: input({ issueId: id() }), response: { 200: output({ trolley: trolleyView }) } })

export const openTrolleysContract = defineContract({
  querystring: input({ siteId: id().optional(), lineId: id().optional() }),
  response: { 200: output({ here: ref.nullable(), rows: z.array(trolleyView) }) },
})

export const scanTrolleyContract = defineContract({
  querystring: input({ code: trolley, siteId: id().optional() }),
  response: { 200: output({ code: z.string(), trolley: trolleyView.nullable(), next: z.enum(['LOAD', 'RECEIVE', 'NONE']) }) },
})

const warnings = z.array(output({ code: z.enum(TROLLEY_WARNINGS), message: z.string() }))

/** A queued load, unload, send or receive (platform/floor-sync) parses the same bodies. */
export const loadTrolleyBody = input({ trolley, bundle: code(), lineId: id().optional() })
export const unloadTrolleyBody = input({ trolley, bundle: code(), siteId: id().optional() })
export const sendTrolleyBody = input({ trolley, lineId: id().optional(), siteId: id().optional() })
export const receiveTrolleyBody = input({ trolley, missing: z.array(code()).max(TROLLEY_LIMITS.bundles).optional(), siteId: id().optional() })

export const loadTrolleyContract = defineContract({ body: loadTrolleyBody, response: { 200: output({ trolley: trolleyView, warnings, replayed: z.boolean() }) } })
export const unloadTrolleyContract = defineContract({ body: unloadTrolleyBody, response: { 200: output({ trolley: trolleyView, replayed: z.boolean() }) } })
export const sendTrolleyContract = defineContract({ body: sendTrolleyBody, response: { 200: output({ trolley: trolleyView, replayed: z.boolean() }) } })
export const receiveTrolleyContract = defineContract({ body: receiveTrolleyBody, response: { 200: output({ trolley: trolleyView, differences: z.string().nullable(), replayed: z.boolean() }) } })
export const cancelTrolleyContract = defineContract({
  params: input({ issueId: id() }),
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(1).max(TROLLEY_LIMITS.reason) }),
  response: { 200: output({ trolley: trolleyView }) },
})
