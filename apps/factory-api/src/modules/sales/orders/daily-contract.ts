import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { PARTY_TAX_MODES } from '@nexus/factory-domain/parties/tax'
import { LINE_CHANGES } from '@nexus/factory-domain/sales/amendments/amendments'
import { IMPACT_CODES } from '@nexus/factory-domain/sales/orders/daily'
import { MAX_REASON, SALES_ORDER_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { MILESTONE_KINDS, MILESTONE_STATUSES } from '@nexus/factory-domain/sales/orders/schedule'
import { DEPOSIT_KINDS, MAX_QUOTE_LINES, MAX_SIZE_QUANTITY, MAX_TEXT } from '@nexus/factory-domain/sales/quotes/quotes'
import { orderView } from './contract'

/**
 * The contracts of an order every day (B-W2a-30; SAL-202, SAL-209, SAL-210, SAL-211, SAL-216, SAL-217): manual entry and
 * its preview, amendments (preview, apply, the Changes tab), close and reopen lines, the cancel's impact check, the
 * payment schedule. Prices are money.price, costs money.cost (dropped for a caller without the grain; a body that sends
 * one without it is refused). Every write sends the order's `version` (COL-078).
 */

const version = z.number().int().min(1)
const reason = z.string().trim().min(1).max(MAX_REASON)
const text = (max: number) => z.string().trim().max(max)
const pct = z.string().trim().max(12)
const orderParams = input({ orderId: id() })
const issue = output({ path: z.string(), message: z.string() })

const sizeInput = input({
  size: z.string().trim().min(1).max(10),
  quantity: z.number().int().min(0).max(MAX_SIZE_QUANTITY),
  /** The size's own unit price when it differs from the line's; null: the line's. */
  unitPrice: money.price(unitPrice().nullish()),
})

const newLineInput = input({
  styleId: id(),
  colourwayId: id(),
  sizes: z.array(sizeInput).min(1).max(50),
  /** On the order's basis; none: the customer's list price. */
  unitPrice: money.price(unitPrice().nullish()),
  /** A discount off the list price, percent (never with a unit price). */
  discountPct: pct.nullish(),
  description: text(MAX_TEXT.description).nullish(),
  note: text(MAX_TEXT.note).nullish(),
})

// ---- manual entry --------------------------------------------------------------------------------------------------------

const manualBody = input({
  companyId: id(),
  partyId: id(),
  contactId: id().nullish(),
  customerRef: text(MAX_TEXT.customerRef).nullish(),
  requestedDate: businessDate().nullish(),
  promiseDate: businessDate().nullish(),
  /** Library terms; null: none; left out: the customer's. */
  paymentTermsId: id().nullish(),
  /** Percent of the gross total asked as a deposit; null: none; left out: the customer's default. */
  depositPct: pct.nullish(),
  depositKind: z.enum(DEPOSIT_KINDS).nullish(),
  billToAddressId: id().nullish(),
  shipToAddressId: id().nullish(),
  language: z.enum(['it', 'en']).optional(),
  internalNote: text(MAX_TEXT.internalNote).nullish(),
  lines: z.array(newLineInput).min(1).max(MAX_QUOTE_LINES),
})

export const nextOrderNumberContract = defineContract({
  querystring: input({ companyId: id() }),
  response: { 200: output({ number: z.string().nullable() }) },
})

const previewLine = output({
  seq: z.number().int(),
  styleId: id(),
  colourwayId: id(),
  styleRevisionId: id().nullable(),
  description: z.string().nullable(),
  quantity: z.number().int(),
  sizes: z.array(output({ size: z.string(), quantity: z.number().int(), unitPrice: money.price(z.string().nullable()) })),
  unitPrice: money.price(z.string()),
  netAmount: money.price(z.number().int()),
  vatAmount: money.price(z.number().int()),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  costAmount: money.cost(z.number().int().nullable()),
})

export const previewManualContract = defineContract({
  body: manualBody,
  response: {
    200: output({
      ok: z.boolean(),
      /** The number it will get (the company's SALES_ORDER series); null without one. */
      number: z.string().nullable(),
      problems: z.array(issue),
      order: output({
        currency: z.string(),
        taxMode: z.enum(PARTY_TAX_MODES),
        priceBasis: notMoney(z.enum(['NET', 'GROSS'])),
        language: z.string(),
        contactId: id().nullable(),
        paymentTermsId: id().nullable(),
        paymentTerms: z.string().nullable(),
        depositPct: z.string().nullable(),
        depositAmount: money.price(z.number().int().nullable()),
        netAmount: money.price(z.number().int()),
        vatAmount: money.price(z.number().int()),
        grossAmount: money.price(z.number().int()),
        costAmount: money.cost(z.number().int().nullable()),
        lines: z.array(previewLine),
        /** The payment schedule it would get (a deposit's due day comes with its request). */
        schedule: z.array(output({ seq: z.number().int(), kind: z.enum(MILESTONE_KINDS), sharePct: z.string().nullable(), amount: money.price(z.number().int()), dueDate: z.string().nullable() })),
      }).nullable(),
    }),
  },
})

export const createManualContract = defineContract({ body: manualBody, response: { 201: output({ order: orderView }) } })

// ---- amendments --------------------------------------------------------------------------------------------------------------

const amendLine = input({
  /** An existing line; none: a new line (styleId and colourwayId then). */
  id: id().optional(),
  styleId: id().optional(),
  colourwayId: id().optional(),
  /** The whole size grid as it should be (a size at 0 leaves it out); none: unchanged. */
  sizes: z.array(sizeInput).max(50).optional(),
  unitPrice: money.price(unitPrice().nullish()),
  description: text(MAX_TEXT.description).nullish(),
  note: text(MAX_TEXT.note).nullish(),
})

const amendFields = {
  reason: z.string().trim().max(MAX_REASON).optional(),
  customerRef: text(MAX_TEXT.customerRef).nullish(),
  requestedDate: businessDate().nullish(),
  /** Every line the order keeps (a line left out is removed). */
  lines: z.array(amendLine).min(1).max(MAX_QUOTE_LINES),
}

const diffView = output({
  lines: z.array(
    output({
      change: z.enum(LINE_CHANGES),
      lineId: id(),
      seq: z.number().int(),
      styleId: id(),
      colourwayId: id(),
      piecesBefore: z.number().int(),
      piecesAfter: z.number().int(),
      sizes: z.array(output({ size: z.string(), before: z.number().int(), after: z.number().int() })),
      /** Its unit price changed (the prices themselves are in `prices`, with the price grain). */
      priceChanged: notMoney(z.boolean()),
      textChanged: z.boolean(),
    }),
  ),
  header: z.array(output({ field: z.enum(['customerRef', 'requestedDate']), before: z.string().nullable(), after: z.string().nullable() })),
  /** Per line: its unit price old → new (when it changed) and its net old → new. */
  prices: money.price(z.array(output({ lineId: id(), unitPrice: money.price(output({ before: z.string().nullable(), after: z.string().nullable() }).nullable()), netBefore: z.number().int(), netAfter: z.number().int() }))),
  netAmountBefore: money.price(z.number().int()),
  netAmountAfter: money.price(z.number().int()),
  grossAmountBefore: money.price(z.number().int()),
  grossAmountAfter: money.price(z.number().int()),
  /** The net total changed: the customer must accept the order again. */
  reacceptanceNeeded: z.boolean(),
})

const amendmentView = output({
  id: id(),
  revision: z.number().int(),
  reason: z.string(),
  createdAt: instant(),
  createdById: id().nullable(),
  createdBy: z.string().nullable(),
  /** NEEDED: the customer must accept the order again (the re-acceptance link is W2b, SAL-190). */
  reacceptance: z.enum(['NEEDED', 'NOT_NEEDED']),
  diff: diffView,
  /** The order before and after, frozen: header and lines with sizes and prices (never a cost). */
  before: money.price(z.record(z.string(), z.unknown())),
  after: money.price(z.record(z.string(), z.unknown())),
})

export const previewAmendmentContract = defineContract({
  params: orderParams,
  body: input({ version: version.optional(), ...amendFields }),
  response: { 200: output({ ok: z.boolean(), revision: z.number().int(), version: z.number().int(), problems: z.array(issue), diff: diffView.nullable() }) },
})

export const applyAmendmentContract = defineContract({
  params: orderParams,
  body: input({ version, ...amendFields, reason }),
  response: { 201: output({ order: orderView, amendment: amendmentView }) },
})

export const listAmendmentsContract = defineContract({
  params: orderParams,
  response: { 200: output({ orderId: id(), number: z.string(), reapprovalNeededAt: instant().nullable(), amendments: z.array(amendmentView) }) },
})

// ---- close and reopen lines ----------------------------------------------------------------------------------------------------

const linesBody = input({
  version,
  reason,
  /** None: every open line with something left (close), every closed line (reopen). */
  lineIds: z.array(id()).max(MAX_QUOTE_LINES).optional(),
})

export const closeLinesContract = defineContract({
  params: orderParams,
  body: linesBody,
  response: {
    200: output({
      order: orderView,
      closed: z.array(output({ lineId: id(), seq: z.number().int(), closedShortQuantity: z.number().int() })),
      /** The APPROVED REDUCE replacements of these lines' cells, now DONE. */
      reducesDone: z.array(id()),
      /** Pieces work orders still make of a closed line (Production decides about them). */
      stillInWorkOrders: z.array(output({ lineId: id(), pieces: z.number().int() })),
    }),
  },
})

export const reopenLinesContract = defineContract({ params: orderParams, body: linesBody, response: { 200: output({ order: orderView, reopened: z.array(id()) }) } })

// ---- cancel ------------------------------------------------------------------------------------------------------------------

const impactItem = output({
  code: z.enum(IMPACT_CODES),
  message: z.string(),
  refs: z.array(output({ type: z.string(), id: id(), number: z.string().nullable() })),
  amount: money.price(z.number().int().nullable()),
})
export const impactView = output({ cancellable: z.boolean(), blocks: z.array(impactItem), touches: z.array(impactItem), leavesBehind: z.array(impactItem) })

export const cancelContract = defineContract({
  params: orderParams,
  body: input({
    version,
    reason,
    /** The order's number, typed to confirm (the design's Cancel order dialog); when sent it must match. */
    confirmNumber: z.string().trim().max(50).optional(),
  }),
  response: {
    200: output({
      order: orderView,
      /** PAID deposit requests the cancellation leaves behind (a refund is the money module's). */
      paidDepositRequestIds: z.array(id()),
      /** B-W2a-30 (SAL-211): what it changed and what it left behind. */
      impact: impactView,
    }),
  },
})

export const cancelCheckContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      orderId: id(),
      number: z.string(),
      status: z.enum(SALES_ORDER_STATUSES),
      version: z.number().int(),
      impact: impactView,
      /** The leather cut for its work orders: hides and area in the hide's base unit (no worker, no money). */
      leatherCut: z.array(output({ workOrderId: id(), number: z.string(), hides: z.number().int(), area: z.string().nullable() })),
    }),
  },
})

// ---- the payment schedule ------------------------------------------------------------------------------------------------------

const milestoneView = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(MILESTONE_KINDS),
  label: z.string(),
  sharePct: z.string().nullable(),
  amount: money.price(z.number().int()),
  dueDate: z.string().nullable(),
  depositRequestId: id().nullable(),
  status: z.enum(MILESTONE_STATUSES),
  paidAt: instant().nullable(),
  statusNote: z.string().nullable(),
  version: z.number().int(),
})

export const scheduleContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      orderId: id(),
      number: z.string(),
      currency: z.string(),
      grossAmount: money.price(z.number().int()),
      /** Empty: paid on invoice terms; no milestones. */
      steps: z.array(milestoneView),
      cancelled: z.array(milestoneView),
      openAmount: money.price(z.number().int()),
      paidAmount: money.price(z.number().int()),
    }),
  },
})
