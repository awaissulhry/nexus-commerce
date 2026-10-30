import { z } from 'zod'
import { amountMinor, currency, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { REWORK_STATUSES } from '@nexus/factory-domain/production/rework/rules'
import { REPLACEMENT_KINDS, REPLACEMENT_STATUSES } from '@nexus/factory-domain/production/scrap/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * Scrap and its replacement (B-W2a-13; MES-129, MES-130; design production.scrap). Quantities of garments are whole
 * numbers; areas and stock quantities decimal strings (four places) in the material's base unit. Values are the cost
 * grain: a caller without money.cost never receives them. A refusal by a replacement rule is a 409 whose issue path is
 * `refusal/<CODE>` (factory-domain production/scrap/rules REPLACEMENT_REFUSALS). No worker is named: office users only,
 * inside one record.
 */

const kind = z.enum(REPLACEMENT_KINDS)
const status = z.enum(REPLACEMENT_STATUSES)
const user = output({ id: id(), name: z.string() })

const replacementView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
  cell: output({ id: id(), colourwayCode: z.string(), size: z.string(), quantity: z.number().int() }),
  kind,
  quantity: z.number().int(),
  /** A RECUT of one part; null: whole garments. */
  part: z.string().nullable(),
  sourceScanId: id().nullable(),
  reworkOrderId: id().nullable(),
  record: output({ type: z.string(), id: id() }).nullable(),
  reason: z.string(),
  status,
  decidedAt: instant().nullable(),
  decidedBy: user.nullable(),
  decisionNote: z.string().nullable(),
  /** A RECUT done: the cut log entry that cut it. */
  cutLogId: id().nullable(),
  doneAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  createdBy: user.nullable(),
})

const replacementAnswer = output({ replacement: replacementView, replayed: z.boolean() })

export const askReplacementContract = defineContract({
  body: input({
    kind,
    quantity: z.number().int().min(1).max(10_000),
    reason: z.string().trim().min(3).max(500),
    /** A RECUT of one part (as the pattern names it); absent or null: whole garments. */
    part: z.string().trim().min(1).max(80).nullish(),
    /** What scrapped them: a scan with scrap, or a rework DONE with scrap; or the work order and cell by hand. */
    sourceScanId: id().optional(),
    reworkOrderId: id().optional(),
    workOrderId: id().optional(),
    workOrderSizeId: id().optional(),
    recordType: z.string().trim().min(1).max(60).optional(),
    recordId: id().optional(),
    note: z.string().trim().min(1).max(500).optional(),
  }),
  response: { 200: replacementAnswer, 201: replacementAnswer },
})

const replacementParams = input({ replacementId: id() })

export const approveReplacementContract = defineContract({
  params: replacementParams,
  body: input({ version: z.number().int().min(1), note: z.string().trim().min(1).max(500).optional() }),
  response: { 200: replacementAnswer, 201: replacementAnswer },
})

export const refuseReplacementContract = defineContract({
  params: replacementParams,
  body: input({ version: z.number().int().min(1), note: z.string().trim().min(3).max(500) }),
  response: { 200: replacementAnswer, 201: replacementAnswer },
})

export const doneReplacementContract = defineContract({
  params: replacementParams,
  body: input({ version: z.number().int().min(1), cutLogId: id(), note: z.string().trim().min(1).max(500).optional() }),
  response: { 200: replacementAnswer, 201: replacementAnswer },
})

export const cancelReplacementContract = defineContract({
  params: replacementParams,
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(500) }),
  response: { 200: replacementAnswer, 201: replacementAnswer },
})

const commaList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
    .pipe(z.array(z.enum(values)))

export const listReplacementsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    workOrderId: id().optional(),
    kind: kind.optional(),
    /** Comma-separated statuses (the recut list: kind=RECUT&status=OPEN). */
    status: commaList(REPLACEMENT_STATUSES).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ replacements: z.array(replacementView), nextCursor: id().nullable() }) },
})

export const replacementRecordContract = defineContract({
  params: replacementParams,
  response: { 200: output({ replacement: replacementView }) },
})

// ---- the scrap list -------------------------------------------------------------------------------------------------------------

const material = output({
  lotId: id(),
  lotCode: z.string(),
  hideId: id(),
  hideCode: z.string(),
  itemId: id(),
  uom: z.enum(UOMS),
  /** The leather the scrapped garments held from this hide (base unit). */
  area: quantity(),
  /** Its value at the cost the hide's issue was valued at (cost grain; null: not valued yet). */
  value: money.cost(amountMinor().nullable()),
})

export const scrapListContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    workOrderId: id().optional(),
    from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
    to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
    kind: z.enum(['SCRAP', 'REWORK']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: {
    200: output({
      rows: z.array(
        output({
          id: z.string(),
          kind: z.enum(['SCRAP', 'REWORK']),
          /** What it comes from: a scan's scrap line, or a rework (its order, or its scrap when done). */
          source: output({ type: z.enum(['SCAN', 'REWORK']), id: id() }),
          at: instant(),
          /** B-W2a-60: the work order's style (the page's pareto by style). */
          workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), style: output({ id: id(), code: z.string(), name: z.string() }).nullable() }),
          bundle: output({ id: id(), code: z.string() }).nullable(),
          operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
          cell: output({ id: id(), colourwayCode: z.string(), size: z.string() }),
          part: z.string().nullable(),
          pieces: z.number().int(),
          reasonCode: z.string(),
          reasonLabel: output({ it: z.string(), en: z.string() }).nullable(),
          /** A rework's status; null for a scan's scrap. */
          status: z.enum(REWORK_STATUSES).nullable(),
          station: output({ id: id(), code: z.string() }).nullable(),
          /** The leather it held, per lot and hide (MES-129). */
          materials: z.array(material),
          replacements: z.array(output({ id: id(), kind, status, quantity: z.number().int() })),
          /** The value of its leather (cost grain; null when a hide's issue has no value yet). */
          value: money.cost(amountMinor().nullable()),
          currency: money.cost(currency().nullable()),
        }),
      ),
      tiles: output({
        /** Garments scrapped today (Europe/Rome), scans and finished rework. */
        scrapToday: z.number().int(),
        reworkOpen: z.number().int(),
        recutsToCut: z.number().int(),
        reductionsToApprove: z.number().int(),
      }),
    }),
  },
})

// ---- scrap stock by lot ---------------------------------------------------------------------------------------------------------

const values = money.cost(output({ valued: z.number().int(), moves: z.number().int(), byCurrency: z.array(output({ currency: currency(), amount: money.cost(amountMinor()) })) }))

export const scrapStockContract = defineContract({
  body: input({
    workOrderId: id(),
    /** An active SCRAP reason of the floor list. */
    reasonCode: z.string().trim().min(2).max(40),
    note: z.string().trim().min(1).max(500).optional(),
    /** The scan or rework whose scrap it posts, when there is one. */
    sourceScanId: id().optional(),
    reworkOrderId: id().optional(),
    lines: z
      .array(
        input({
          /** An area of a hide (all it holds when no quantity is given). */
          hideId: id().optional(),
          itemId: id().optional(),
          itemColourId: id().nullish(),
          lotId: id().nullish(),
          fromLocationId: id().optional(),
          quantity: quantity().optional(),
          uom: z.enum(UOMS).optional(),
        }),
      )
      .min(1)
      .max(50),
  }),
  response: {
    201: output({
      scrap: output({
        id: id(),
        workOrderId: id(),
        number: z.string(),
        reasonCode: z.string(),
        note: z.string(),
        moves: z.array(output({ id: id(), itemId: id(), lotId: id().nullable(), hideId: id().nullable(), fromLocationId: id().nullable(), quantity: quantity(), uom: z.enum(UOMS), baseQuantity: quantity() })),
        /** Hides left with nothing in stock: SCRAPPED for good. */
        scrappedHides: z.array(id()),
        values: values.optional(),
      }),
      /** Keys the scrap leaves reserved beyond their stock, in words (never a silent refusal). */
      overReserved: z.array(output({ itemId: id(), itemColourId: id().nullable(), /** A hide reserved whole that holds less now; null: the material and colour at the site. */ hideId: id().nullable(), available: z.string(), reserved: quantity(), words: z.string() })),
    }),
  },
})
