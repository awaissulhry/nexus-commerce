import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOWNGRADE_REASONS, DOWNGRADE_REFUSALS, DOWNGRADE_TARGETS, REPAIR_STATES, REPAIR_STEPS } from '@nexus/factory-domain/production/repair/rules'
import { REWORK_STATUSES } from '@nexus/factory-domain/production/rework/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * The repair station and second quality (B-W2b-126; MES-132, MES-133; design floor.mywork "repair queue", production.scrap
 * pop:sc-downgrade, sec:sc-metrics "Downgraded to second quality"). Quantities are garments; minutes are whole minutes per
 * rework, in the office's answers only (the floor's answers carry times, never a duration or a pace: F2). No field carries money, and no list names a person (an office record names who scanned behind the PERFORMANCE
 * gate). A refusal by a rule is a 409 whose issue paths are `refusal/<CODE>` and `fix` (factory-domain production/repair
 * rules REPAIR_REFUSALS, DOWNGRADE_REFUSALS).
 */

const operation = output({ seq: z.number().int(), code: z.string(), name: z.string() })
const cell = output({ id: id(), colourwayCode: z.string(), size: z.string() })

const queueRow = output({
  reworkId: id(),
  workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), dueDate: z.string().nullable(), rush: z.boolean(), holdReason: z.string().nullable(), style: output({ code: z.string(), name: z.string() }) }),
  cell,
  bundle: output({ id: id(), code: z.string(), part: z.string().nullable() }).nullable(),
  quantity: z.number().int(),
  /** The rework reason with its words (null words: a code no longer on the list). */
  reason: output({ code: z.string(), it: z.string().nullable(), en: z.string().nullable() }),
  /** What to redo, as the lead or inspector wrote it. */
  description: z.string().nullable(),
  foundAt: operation.nullable(),
  reworkAt: operation,
  state: z.enum(REPAIR_STATES),
  /** Scanned in at this station, or sent back to an operation of its work centre. */
  here: z.boolean(),
  /** The station that scanned it in. */
  station: output({ id: id(), code: z.string() }).nullable(),
  inAt: instant().nullable(),
  /** When it was sent back. */
  since: instant(),
  held: z.boolean(),
  version: z.number().int(),
})

export const stationQueueContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      station: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
      rows: z.array(queueRow),
      counts: output({ here: z.number().int(), waiting: z.number().int(), inRepair: z.number().int() }),
    }),
  },
})

const reworkParams = input({ reworkId: id() })
const scanAnswer = output({
  repair: output({
    reworkId: id(),
    workOrder: output({ id: id(), number: z.string() }),
    status: z.enum(REWORK_STATUSES),
    step: z.enum(REPAIR_STEPS),
    repairInAt: instant().nullable(),
    repairOutAt: instant().nullable(),
    goodQuantity: z.number().int(),
    scrapQuantity: z.number().int(),
    version: z.number().int(),
    /** The queue's row as it stands now (null once scanned out). */
    row: queueRow.nullable(),
  }),
  replayed: z.boolean(),
})

const code = z.string().trim().min(1).max(80)

export const scanInBody = input({ code: code.optional(), occurredAt: instant().optional() })
export const scanOutBody = input({ code: code.optional(), good: z.number().int().min(0).max(10_000), scrap: z.number().int().min(0).max(10_000), occurredAt: instant().optional() })

export const scanInContract = defineContract({ params: reworkParams, body: scanInBody, response: { 200: scanAnswer, 201: scanAnswer } })
export const scanOutContract = defineContract({ params: reworkParams, body: scanOutBody, response: { 200: scanAnswer, 201: scanAnswer } })

/** The floor's queued scan (`production.repair.scan`): the step and the rework with the route's body. */
export const queuedScanBody = input({ reworkId: id(), step: z.enum(REPAIR_STEPS), code: code.optional(), good: z.number().int().min(0).max(10_000).optional(), scrap: z.number().int().min(0).max(10_000).optional(), occurredAt: instant().optional() })

const person = output({ id: id(), name: z.string() })

export const repairRecordContract = defineContract({
  params: reworkParams,
  response: {
    200: output({
      repair: output({
        reworkId: id(),
        workOrder: output({ id: id(), number: z.string() }),
        status: z.enum(REWORK_STATUSES),
        state: z.enum(REPAIR_STATES).nullable(),
        repairInAt: instant().nullable(),
        repairOutAt: instant().nullable(),
        station: output({ id: id(), code: z.string() }).nullable(),
        minutes: z.number().int().nullable(),
        goodQuantity: z.number().int(),
        scrapQuantity: z.number().int(),
        /** Only with the site's PERFORMANCE gate open; else null and `workerHidden`. */
        scannedInBy: person.nullable(),
        scannedOutBy: person.nullable(),
        workerHidden: z.boolean(),
      }),
    }),
  },
})

// ---- second quality ------------------------------------------------------------------------------------------------------------

const downgradeView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), style: output({ id: id(), code: z.string(), name: z.string() }).nullable() }),
  cell,
  bundle: output({ id: id(), code: z.string(), part: z.string().nullable() }).nullable(),
  /** The scrap it came from: a scan's scrap or a finished rework's (null: an older row that names neither). */
  source: output({ type: z.enum(['SCAN', 'REWORK']), id: id() }).nullable(),
  quantity: z.number().int(),
  reasonCode: z.string(),
  note: z.string().nullable(),
  target: z.enum(DOWNGRADE_TARGETS),
  item: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  sku: output({ id: id(), sku: z.string() }).nullable(),
  /** Where the garments went (null: an older row that moved no stock). */
  place: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  moveId: id().nullable(),
  withdrawnMoveId: id().nullable(),
  withdrawn: output({ at: instant(), reason: z.string() }).nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

const source = { sourceScanId: id().optional(), reworkOrderId: id().optional() }

export const downgradeOptionsContract = defineContract({
  querystring: input(source),
  response: {
    200: output({
      source: output({ type: z.enum(['SCAN', 'REWORK']), id: id() }),
      workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
      cell,
      bundle: output({ id: id(), code: z.string(), part: z.string().nullable() }).nullable(),
      scrapped: z.number().int(),
      downgraded: z.number().int(),
      left: z.number().int(),
      approval: z.enum(['WAITING', 'REFUSED']).nullable(),
      ppe: z.boolean(),
      sku: output({ variantId: id(), sku: z.string() }).nullable(),
      items: z.array(output({ id: id(), code: z.string(), name: z.string() })),
      places: z.array(output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), finishedGoods: z.boolean() })),
      reasons: z.array(z.enum(DOWNGRADE_REASONS)),
      held: output({ code: z.enum(DOWNGRADE_REFUSALS), message: z.string() }).nullable(),
      may: z.boolean(),
    }),
  },
})

const downgradeAnswer = output({ downgrade: downgradeView, replayed: z.boolean() })

export const downgradeContract = defineContract({
  body: input({
    ...source,
    quantity: z.number().int().min(1).max(10_000),
    reasonCode: z.string().trim().min(2).max(40),
    note: z.string().trim().min(1).max(500).optional(),
    target: z.enum(DOWNGRADE_TARGETS),
    itemId: id().optional(),
    toLocationId: id(),
    ppeConfirmed: z.boolean().optional(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: { 200: downgradeAnswer, 201: downgradeAnswer },
})

export const withdrawDowngradeContract = defineContract({
  params: input({ downgradeId: id() }),
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(500), periodLockOverride: periodLockOverride.optional() }),
  response: { 200: downgradeAnswer, 201: downgradeAnswer },
})

export const listDowngradesContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    workOrderId: id().optional(),
    from: instant().optional(),
    to: instant().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: { 200: output({ downgrades: z.array(downgradeView), /** Garments sent to second quality, withdrawn ones left out. */ garments: output({ today: z.number().int(), period: z.number().int() }) }) },
})
