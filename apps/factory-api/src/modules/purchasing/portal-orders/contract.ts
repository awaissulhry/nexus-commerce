import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ANSWER_OUTCOMES, LINE_CHANGES } from '@nexus/factory-domain/purchasing/confirm/answer'
import { MAX_LINES, MAX_TEXT, PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { MAX_SUBSTITUTE_NOTE, PORTAL_ANSWER_MODES, PORTAL_DECLINE_REASONS, PORTAL_LINE_ANSWERS } from '@nexus/factory-domain/purchasing/portal-orders/answer'
import { ORDER_CHIPS, SUPPLIER_STATES } from '@nexus/factory-domain/purchasing/portal-orders/views'
import { LINE_DIFF_KINDS, REVISION_ANSWERS } from '@nexus/factory-domain/purchasing/revisions/revisions'

/**
 * The supplier's purchase orders in the portal (B-W2b-174; SCM-094, SCM-086; design portal.supplier.orders). NOTHING here is
 * money (Owner answer C2: no price, cost or amount on any supplier screen; the partner role's grants hold none and the
 * routes hold no grain). Words come in both languages where the portal shows a state; the rest is the page's catalogue.
 * Quantities are decimal strings in the line's unit, dates calendar days, times UTC instants.
 */

const version = z.number().int().min(1)
const text = (max: number) => z.string().max(max)
const loose = z.string().max(40).nullable().optional()
const words = output({ it: z.string(), en: z.string() })
const status = z.enum(PURCHASE_ORDER_STATUSES)
const state = z.enum(SUPPLIER_STATES)
const live = output({ events: z.array(z.string()) })
const params = input({ purchaseOrderId: id() })
const language = z.enum(['it', 'en']).optional()

export const portalOrdersContract = defineContract({
  querystring: input({
    /** The design's chips; none: "To confirm" while any order waits, else all. */
    chip: z.enum(ORDER_CHIPS).optional(),
    /** Our PO number, your confirmation number, or your article code. */
    q: z.string().trim().max(100).optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      chip: z.enum(ORDER_CHIPS),
      chips: z.array(output({ chip: z.enum(ORDER_CHIPS), count: z.number().int(), words })),
      counts: output({ toConfirm: z.number().int(), late: z.number().int() }),
      items: z.array(
        output({
          id: id(),
          number: z.string(),
          /** "PO-2026-0101 rev. 2": the version the supplier holds. */
          documentNumber: z.string(),
          revision: z.number().int(),
          status,
          state,
          words,
          /** Your confirmation (or proposal) number. */
          supplierRef: z.string().nullable(),
          sentAt: instant().nullable(),
          orderDate: businessDate(),
          lines: z.number().int(),
          earliestNeedDate: businessDate().nullable(),
          /** The next day goods are expected (a confirmed date, else the date asked) of a line still open. */
          nextExpected: businessDate().nullable(),
          late: z.boolean(),
          /** While it waits for you: answer by. */
          confirmBy: instant().nullable(),
          canAnswer: z.boolean(),
          version: z.number().int(),
        }),
      ),
      /** False when the list was cut at its limit. */
      complete: z.boolean(),
      live,
    }),
  },
})

const delivery = output({ quantity: z.string(), date: z.string().nullable() })
const fieldChange = output({ field: z.string(), before: z.unknown(), after: z.unknown() })
const changes = output({
  revision: z.number().int(),
  documentNumber: z.string(),
  sentAt: instant(),
  changeNote: z.string().nullable(),
  /** In the supplier's words ("Line 10 … quantity 105 ft² → 140 ft²"). */
  words: z.array(z.string()),
  lines: z.array(output({ lineId: id(), seq: z.number().int(), kind: z.enum(LINE_DIFF_KINDS), changes: z.array(fieldChange) })),
  header: z.array(fieldChange),
})

const line = output({
  id: id(),
  seq: z.number().int(),
  /** Your article code first, else ours. */
  code: z.string().nullable(),
  name: z.string().nullable(),
  colour: output({ name: z.string().nullable(), supplierCode: z.string().nullable() }).nullable(),
  description: z.string().nullable(),
  quantity: z.string(),
  uom: z.string(),
  baseQuantity: z.string().nullable(),
  baseUom: z.string().nullable(),
  needDate: businessDate(),
  grade: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  oneDyeBatch: z.boolean(),
  areaTolerancePct: z.string().nullable(),
  estimatedHides: z.number().int().nullable(),
  requiresCrViTest: z.boolean(),
  note: z.string().nullable(),
  confirmedQuantity: z.string().nullable(),
  confirmedDate: businessDate().nullable(),
  /** Received so far in the item's base unit. */
  receivedBase: z.string(),
  ended: z.enum(['CANCELLED', 'CLOSED_SHORT']).nullable(),
  /** Confirmed already: not answered again. */
  locked: z.boolean(),
  /** Your latest proposal for the line (kept after our decision). */
  proposal: output({
    kind: z.enum(PORTAL_LINE_ANSWERS),
    quantity: z.string(),
    date: z.string().nullable(),
    deliveries: z.array(delivery),
    reason: z.string().nullable(),
    changes: z.array(z.enum(LINE_CHANGES)),
    substitute: output({ itemId: id().nullable(), code: z.string().nullable(), name: z.string().nullable(), note: z.string().nullable() }).nullable(),
    needsBuyer: z.boolean(),
  }).nullable(),
  version: z.number().int(),
})

const answerFacts = output({
  answer: z.enum(REVISION_ANSWERS),
  confirmation: output({ at: z.string(), byName: z.string().nullable(), supplierRef: z.string().nullable() }).nullable(),
  decline: output({ at: z.string(), reason: z.string().nullable() }).nullable(),
  proposal: output({ at: z.string(), byName: z.string().nullable(), supplierRef: z.string().nullable(), note: z.string().nullable(), decision: z.string().nullable() }).nullable(),
})

const orderPage = {
  order: output({
    id: id(),
    number: z.string(),
    documentNumber: z.string(),
    revision: z.number().int(),
    status,
    state,
    words,
    orderDate: businessDate(),
    requestedDate: businessDate().nullable(),
    incoterms: z.string().nullable(),
    paymentTerms: z.string().nullable(),
    note: z.string().nullable(),
    sentAt: instant().nullable(),
    confirmBy: instant().nullable(),
    confirmedAt: instant().nullable(),
    confirmedByName: z.string().nullable(),
    supplierRef: z.string().nullable(),
    confirmNote: z.string().nullable(),
    declinedAt: instant().nullable(),
    declineReason: z.string().nullable(),
    cancelledAt: instant().nullable(),
    version: z.number().int(),
  }),
  from: output({ legalName: z.string(), tradeName: z.string().nullable(), buyerName: z.string().nullable() }),
  deliverTo: output({ name: z.string(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string() }).nullable(),
  lines: z.array(line),
  /** Your latest proposal and our decision on it (ACCEPTED, REFUSED, or null while it waits). */
  proposal: output({ at: instant(), byName: z.string().nullable(), supplierRef: z.string().nullable(), note: z.string().nullable(), summary: z.string(), decision: z.enum(['ACCEPTED', 'REFUSED']).nullable(), decidedAt: instant().nullable() }).nullable(),
  answer: output({
    canAnswer: z.boolean(),
    message: z.string().nullable(),
    mayAnswer: z.boolean(),
    lineAnswers: z.array(z.enum(PORTAL_LINE_ANSWERS)),
    declineReasons: z.array(z.enum(PORTAL_DECLINE_REASONS)),
    /** Per line: the articles of ours you may offer instead (code and name; never a price). */
    substitutes: z.record(z.string(), z.array(output({ itemId: id(), code: z.string(), name: z.string() }))),
  }),
  /** What changed in the version you hold (version 1: null). */
  changes: changes.nullable(),
  /** Answers so far: each version as sent, your answer to it and our decision. */
  history: z.array(output({ revision: z.number().int(), documentNumber: z.string(), sentAt: instant() }).extend(answerFacts.shape)),
  copy: output({ href: z.string() }),
  live,
}

export const portalOrderContract = defineContract({ params, response: { 200: output(orderPage) } })

export const portalRevisionsContract = defineContract({
  params,
  querystring: input({ language }),
  response: { 200: output({ purchaseOrderId: id(), number: z.string(), revisions: z.array(changes) }) },
})

const endState = output({ ...orderPage, outcome: z.enum(ANSWER_OUTCOMES), summary: z.string().nullable(), done: z.string() })

export const portalConfirmContract = defineContract({
  params,
  body: input({
    version,
    mode: z.enum(PORTAL_ANSWER_MODES),
    lines: z
      .array(
        input({
          lineId: z.string().max(40),
          answer: z.enum(PORTAL_LINE_ANSWERS),
          quantity: loose,
          date: loose,
          deliveries: z.array(input({ quantity: z.string().max(40), date: z.string().max(40) })).max(10).nullable().optional(),
          reason: text(2 * MAX_TEXT.reason).nullable().optional(),
          /** SUBSTITUTE: one of the articles offered for the line. */
          substituteItemId: z.string().max(40).nullable().optional(),
          /** SUBSTITUTE: your own article, in your words. */
          substituteNote: text(2 * MAX_SUBSTITUTE_NOTE).nullable().optional(),
        }),
      )
      .max(MAX_LINES)
      .nullable()
      .optional(),
    supplierRef: text(2 * MAX_TEXT.code).nullable().optional(),
    note: text(2 * MAX_TEXT.note).nullable().optional(),
  }),
  response: { 200: endState },
})

export const portalDeclineContract = defineContract({
  params,
  body: input({ version, reason: z.enum(PORTAL_DECLINE_REASONS), note: text(2 * MAX_TEXT.note).nullable().optional() }),
  response: { 200: endState },
})

export const portalCopyContract = defineContract({ params, querystring: input({ language }), response: {} })
