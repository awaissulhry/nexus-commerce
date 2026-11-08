import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CUT_TICKET_STATUSES } from '@nexus/factory-domain/production/cutorders/rules'
import { MAX_RECUT_COPIES, RECUT_LIMITS, RECUT_WARNINGS } from '@nexus/factory-domain/production/rework/recut'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { printJobView } from '../../../platform/print/contract'
import { RECUT_VIEWS } from './recut'

/**
 * Recut tickets (B-W2b-117; MES-044): the contracts of ./recut.ts. Sets are garments (of the part, or whole). No field carries
 * money; no worker is named. A rule's refusal is a 409 whose issue path is `refusal/<CODE>` (factory-domain production/rework/recut
 * RECUT_REFUSALS; FLOOR_NOT_READY from the floor's gate).
 */

const words = output({ it: z.string(), en: z.string() })
const language = z.enum(['it', 'en'])
const reason = z.string().trim().min(1).max(RECUT_LIMITS.reason)

export const recutView = output({
  id: id(),
  number: z.string(),
  /** What the label's barcode says (the ticket's number). */
  code: z.string(),
  status: z.enum(CUT_TICKET_STATUSES),
  workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), dueDate: z.string().nullable(), rush: z.boolean(), style: output({ code: z.string(), name: z.string() }) }),
  cell: output({ id: id(), colourwayCode: z.string(), size: z.string() }),
  /** The bundle its panels join (null: none named). */
  bundle: output({ id: id(), code: z.string(), part: z.string().nullable(), status: z.enum(['ACTIVE', 'VOID']) }).nullable(),
  /** The part as the pattern names it; null: whole garments. */
  part: z.string().nullable(),
  quantity: z.number().int(),
  /** The shade lot it is cut from (null: end bits only). */
  lot: output({ id: id(), code: z.string(), dyeBatch: z.string().nullable(), shade: z.string().nullable() }).nullable(),
  endBits: z.boolean(),
  /** Where it is cut from, in words ("Lotto L-1 + Ritagli"). */
  from: words,
  /** The office's recut request it answers (office answers only; a tablet reads none). */
  replacement: output({ id: id(), status: z.string(), quantity: z.number().int(), reason: z.string() }).nullable(),
  printedAt: instant().nullable(),
  startedAt: instant().nullable(),
  doneAt: instant().nullable(),
  voidedAt: instant().nullable(),
  voidReason: z.string().nullable(),
  createdAt: instant(),
  version: z.number().int(),
})

const refusal = output({ code: z.string(), message: z.string() })

export const listRecutsContract = defineContract({
  querystring: input({
    view: z.enum(RECUT_VIEWS).optional(),
    siteId: id().optional(),
    workOrderId: id().optional(),
    bundleId: id().optional(),
    q: z.string().trim().max(60).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(RECUT_LIMITS.rows).optional(),
  }),
  response: { 200: output({ rows: z.array(recutView), nextCursor: id().nullable(), tiles: output({ open: z.number().int(), started: z.number().int(), done: z.number().int(), void: z.number().int() }) }) },
})

export const waitingRecutsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ rows: z.array(recutView), counts: output({ open: z.number().int(), started: z.number().int() }) }) },
})

const card = output({ ticket: recutView, next: output({ next: z.enum(['START', 'FINISH', 'NONE']), refusal: refusal.nullable(), words }) })

export const scanRecutContract = defineContract({ querystring: input({ code: z.string().trim().min(1).max(60) }), response: { 200: card } })

export const recutOptionsContract = defineContract({
  querystring: input({ code: z.string().trim().min(1).max(60).optional(), bundleId: id().optional() }),
  response: {
    200: output({
      bundle: output({ id: id(), code: z.string(), part: z.string().nullable(), status: z.enum(['ACTIVE', 'VOID']), live: z.number().int() }),
      workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
      cell: output({ id: id(), colourwayCode: z.string(), size: z.string() }),
      /** The parts its materials and pattern name (empty: any words). */
      parts: z.array(z.string()),
      /** The bundle's own lots (its genealogy): a recut is cut from one of them, one of the same dye batch or shade, or end bits. */
      shadeLots: z.array(output({ id: id(), code: z.string(), dyeBatch: z.string().nullable(), shade: z.string().nullable() })),
      /** Office only: the cell's open recut requests without a ticket. */
      replacements: z.array(output({ id: id(), quantity: z.number().int(), part: z.string().nullable(), reason: z.string(), createdAt: instant() })),
      /** Why this bundle takes no recut now (null: it may). */
      refusal: refusal.nullable(),
    }),
  },
})

export const makeRecutContract = defineContract({
  body: input({
    /** The bundle the panels join: scanned (its ticket's code) or by id. */
    code: z.string().trim().min(1).max(60).optional(),
    bundleId: id().optional(),
    /** Office only: the open RECUT request it answers (its part, cell and sets by default). */
    replacementId: id().optional(),
    part: z.string().trim().max(RECUT_LIMITS.part).nullish(),
    quantity: z.number().int().min(1).max(RECUT_LIMITS.sets).optional(),
    lotId: id().nullish(),
    endBits: z.boolean().optional(),
    reason,
  }),
  response: { 201: output({ ticket: recutView, warnings: z.array(output({ code: z.enum(RECUT_WARNINGS), message: z.string() })), replayed: z.boolean() }) },
})

const labelLines = output({ heading: z.string(), title: z.string(), fields: z.array(output({ label: z.string(), value: z.string() })) })
const ticketParams = input({ ticketId: id() })

export const printRecutContract = defineContract({
  params: ticketParams,
  body: input({ printerId: id().nullish(), copies: z.number().int().min(1).max(MAX_RECUT_COPIES).optional(), language: language.optional() }),
  response: { 200: output({ ticket: recutView, label: labelLines, job: printJobView.nullable(), problem: z.string().nullable() }) },
})

const scanBody = input({ code: z.string().trim().min(1).max(60) })
export const startRecutContract = defineContract({ body: scanBody, response: { 200: card.extend({ replayed: z.boolean() }) } })
export const finishRecutContract = defineContract({ body: scanBody, response: { 200: card.extend({ replayed: z.boolean() }) } })

export const voidRecutContract = defineContract({
  params: ticketParams,
  body: input({ version: z.number().int().min(1), reason }),
  response: { 200: output({ ticket: recutView }) },
})
