import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { MAX_LINES, MAX_TEXT, PURCHASE_ORDER_STATUSES, SEND_CHECK_CODES } from '@nexus/factory-domain/purchasing/orders'

/**
 * The purchasing routes' contracts (B-W1-30; A2 SCR-058 "Purchase orders", SCR-059 the record, SCR-037 the send dialog,
 * SCR-055 "Draft PO"). Purchase prices and amounts are costs: marked money.cost, so the API drops them for a caller
 * without the cost grain and refuses a body that sends one (a planner reads the order without its prices). The order's
 * `version` is the edit-conflict guard of every write (COL-078) and the compare-and-set that keeps a send and a cancel
 * from both happening.
 */

const version = z.number().int().min(1)
const text = (max: number) => z.string().trim().max(max)
const email = z.string().trim().min(3).max(254)
const decimalText = (max: number) => z.string().trim().max(max)

const orderParams = input({ purchaseOrderId: id() })
const lineParams = input({ purchaseOrderId: id(), lineId: id() })

const checkView = output({ code: z.enum(SEND_CHECK_CODES), severity: z.enum(['BLOCKS', 'WARNING']), path: z.string(), message: z.string() })

const linkStateView = output({
  id: id(),
  email: z.string().nullable(),
  state: z.enum(LINK_STATES),
  expiresAt: instant(),
  uses: z.number().int(),
  maxUses: z.number().int(),
  lastUsedAt: instant().nullable(),
  revokedAt: instant().nullable(),
  createdAt: instant(),
})

const lineView = output({
  id: id(),
  seq: z.number().int(),
  itemId: id(),
  item: output({ code: z.string(), name: z.string(), kind: z.string(), baseUom: z.enum(UOMS), purchaseUom: z.enum(UOMS) }),
  itemColourId: id().nullable(),
  colour: output({ code: z.string(), name: z.string() }).nullable(),
  description: z.string().nullable(),
  supplierArticleCode: z.string().nullable(),
  supplierColourCode: z.string().nullable(),
  quantity: z.string(),
  uom: z.enum(UOMS),
  /** The same quantity in the material's base unit (the area of a leather line). */
  baseQuantity: z.string(),
  baseUom: z.enum(UOMS),
  unitPrice: money.cost(z.string()),
  netAmount: money.cost(z.number().int()),
  needDate: z.string(),
  grade: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  oneDyeBatch: z.boolean(),
  areaTolerancePct: z.string().nullable(),
  /** Leather: about how many hides the area is (the base area over the material's hide factor, rounded up). */
  estimatedHides: z.number().int().nullable(),
  requiresCrViTest: z.boolean(),
  note: z.string().nullable(),
  confirmedQuantity: z.string().nullable(),
  confirmedDate: z.string().nullable(),
  /** The plan lines this line buys (What to buy & make), with their run's state and decision. */
  plan: z.array(output({ requirementId: id(), runId: id(), runStatus: z.string(), decision: z.string() })),
  version: z.number().int(),
})

const orderView = output({
  id: id(),
  number: z.string(),
  /** The number the PDF prints (with its revision from the second one). */
  documentNumber: z.string(),
  companyId: id(),
  siteId: id(),
  site: output({ code: z.string(), name: z.string() }),
  partyId: id(),
  supplier: output({ code: z.string(), name: z.string(), status: z.string() }),
  contactId: id().nullable(),
  contact: output({ name: z.string(), email: z.string().nullable(), roles: z.array(z.string()) }).nullable(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  revision: z.number().int(),
  currency: z.string(),
  orderDate: z.string(),
  requestedDate: z.string().nullable(),
  incoterms: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  note: z.string().nullable(),
  internalNote: z.string().nullable(),
  netAmount: money.cost(z.number().int()),
  lineCount: z.number().int(),
  earliestNeedDate: z.string().nullable(),
  sentAt: instant().nullable(),
  sentById: id().nullable(),
  confirmedAt: instant().nullable(),
  confirmedVia: z.enum(['LINK', 'OFFICE']).nullable(),
  confirmedByName: z.string().nullable(),
  supplierRef: z.string().nullable(),
  confirmNote: z.string().nullable(),
  declinedAt: instant().nullable(),
  declineReason: z.string().nullable(),
  closedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
  createdById: id().nullable(),
  lines: z.array(lineView),
  /** A draft: what a send would check now (null once sent). */
  send: output({ ready: z.boolean(), checks: z.array(checkView) }).nullable(),
  confirmLinks: z.array(linkStateView),
})

const one = output({ order: orderView })

// ---- list and read ----------------------------------------------------------------------------------------------------

export const listOrdersContract = defineContract({
  querystring: input({
    status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
    companyId: id().optional(),
    siteId: id().optional(),
    partyId: id().optional(),
    /** The number, case-insensitive. */
    q: z.string().trim().min(1).max(60).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      /** "Where POs stand": drafts to send, waiting for the supplier, not confirmed 48 hours after the send, declined. */
      summary: output({ drafts: z.number().int(), waiting: z.number().int(), notConfirmedAfter48h: z.number().int(), declined: z.number().int() }),
      orders: z.array(
        output({
          id: id(),
          number: z.string(),
          companyId: id(),
          siteId: id(),
          partyId: id(),
          supplierName: z.string(),
          status: z.enum(PURCHASE_ORDER_STATUSES),
          revision: z.number().int(),
          currency: z.string(),
          orderDate: z.string(),
          requestedDate: z.string().nullable(),
          earliestNeedDate: z.string().nullable(),
          latestConfirmedDate: z.string().nullable(),
          lineCount: z.number().int(),
          netAmount: money.cost(z.number().int()),
          sentAt: instant().nullable(),
          confirmedAt: instant().nullable(),
          confirmedVia: z.enum(['LINK', 'OFFICE']).nullable(),
          confirmedByName: z.string().nullable(),
          declinedAt: instant().nullable(),
          createdById: id().nullable(),
          updatedAt: instant(),
          version: z.number().int(),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const getOrderContract = defineContract({ params: orderParams, response: { 200: one } })

// ---- create and edit --------------------------------------------------------------------------------------------------

const headerFields = {
  contactId: id().nullish(),
  /** ISO 4217; default the supplier's. Changes only while the order has no line. */
  currency: z.string().trim().length(3).optional(),
  requestedDate: businessDate().nullish(),
  incoterms: text(MAX_TEXT.incoterms).nullish(),
  paymentTerms: text(MAX_TEXT.paymentTerms).nullish(),
  note: text(MAX_TEXT.note).nullish(),
  internalNote: text(MAX_TEXT.internalNote).nullish(),
}

export const createOrderContract = defineContract({ body: input({ companyId: id(), siteId: id(), partyId: id(), ...headerFields }), response: { 201: one } })

export const updateOrderContract = defineContract({ params: orderParams, body: input({ version, ...headerFields }), response: { 200: one } })

const lineFields = {
  itemColourId: id().nullish(),
  /** Default the material's purchase unit; any unit it converts. */
  uom: z.enum(UOMS).optional(),
  /** Per `uom`, in the order's currency; default the material's standard purchase price in that unit. */
  unitPrice: money.cost(unitPrice().optional()),
  description: text(MAX_TEXT.description).nullish(),
  supplierArticleCode: text(MAX_TEXT.code).nullish(),
  supplierColourCode: text(MAX_TEXT.code).nullish(),
  /** Leather only: default the material's. */
  grade: text(MAX_TEXT.grade).nullish(),
  thicknessMinMm: decimalText(12).nullish(),
  thicknessMaxMm: decimalText(12).nullish(),
  /** Leather only: every hide from one dye batch (default on for leather). */
  oneDyeBatch: z.boolean().optional(),
  areaTolerancePct: decimalText(12).nullish(),
  note: text(MAX_TEXT.note).nullish(),
}

export const addLineContract = defineContract({
  params: orderParams,
  body: input({ version, itemId: id(), quantity: quantity(), needDate: businessDate(), ...lineFields }),
  response: { 201: one },
})

export const editLineContract = defineContract({
  params: lineParams,
  body: input({ version, quantity: quantity().optional(), needDate: businessDate().optional(), ...lineFields }),
  response: { 200: one },
})

export const removeLineContract = defineContract({ params: lineParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: one } })

// ---- draft from the plan ------------------------------------------------------------------------------------------------

export const draftFromPlanContract = defineContract({
  body: input({
    /** Plan lines to buy (What to buy & make), each with the version read; a supplier for a line that names none. */
    lines: z.array(input({ id: id(), version, supplierId: id().optional() })).min(1).max(MAX_LINES),
    /** Per supplier: the draft to add to, or null for a new one. Default: its open draft at the site, else a new one. */
    into: z.array(input({ supplierId: id(), purchaseOrderId: id().nullable() })).max(MAX_LINES).optional(),
  }),
  response: {
    200: output({
      orders: z.array(output({ id: id(), number: z.string(), created: z.boolean(), lineIds: z.array(id()), lineCount: z.number().int() })),
      lines: z.array(output({ requirementId: id(), purchaseOrderId: id(), purchaseOrderLineId: id() })),
    }),
  },
})

export const undoDraftContract = defineContract({
  body: input({
    lines: z.array(id()).min(1).max(MAX_LINES),
    /** The drafts the "Draft PO" made: cancelled when the undo leaves them without a line. */
    cancelOrderIds: z.array(id()).max(MAX_LINES).optional(),
  }),
  response: {
    200: output({
      orders: z.array(output({ id: id(), number: z.string(), lineCount: z.number().int(), cancelled: z.boolean() })),
      reopenedRequirementIds: z.array(id()),
    }),
  },
})

// ---- send, a new link, cancel ---------------------------------------------------------------------------------------------

export const sendCheckContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      ready: z.boolean(),
      checks: z.array(checkView),
      /** The order's contact: the mail and its confirm link go to them. */
      recipient: output({ contactId: id(), name: z.string(), email: z.string().nullable() }).nullable(),
      documentNumber: z.string(),
      language: z.enum(['it', 'en']),
      /** When the confirm link would stop opening. */
      linkExpiresAt: instant(),
      subject: z.string(),
      /** The mail's standard text as the thread keeps it (the link itself is only in the mail sent). */
      message: z.string(),
    }),
  },
})

/** Where the mail is: sent, failed (FAILED, with why: send a new link), or null on a repeated request. */
const delivery = z.enum(['sent', 'failed', 'retry', 'settled']).nullable()

export const sendContract = defineContract({
  params: orderParams,
  body: input({ version, cc: z.array(email).max(10).optional(), subject: text(200).nullish(), message: text(MAX_TEXT.message).nullish() }),
  response: {
    200: output({
      order: orderView,
      sent: output({
        revision: z.number().int(),
        sentAt: instant(),
        documentFileId: id(),
        documentSha256: z.string(),
        to: z.string(),
        /** The confirm link (never its address: only the mail holds it). */
        link: output({ id: id(), expiresAt: instant() }),
        emailId: id(),
      }),
      delivery,
    }),
  },
})

export const sendLinkContract = defineContract({
  params: orderParams,
  body: input({ version, cc: z.array(email).max(10).optional(), message: text(MAX_TEXT.message).nullish() }),
  response: {
    200: output({
      order: orderView,
      link: output({ id: id(), expiresAt: instant(), to: z.string(), revokedLinkIds: z.array(id()), emailId: id() }),
      delivery,
    }),
  },
})

export const cancelContract = defineContract({
  params: orderParams,
  body: input({ version, reason: text(MAX_TEXT.reason).min(1), message: text(MAX_TEXT.message).nullish() }),
  response: { 200: output({ order: orderView, supplierTold: z.boolean() }) },
})

// ---- documents and the supplier's view --------------------------------------------------------------------------------------

export const documentsContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      revision: z.number().int(),
      status: z.enum(PURCHASE_ORDER_STATUSES),
      sentAt: instant().nullable(),
      documents: z.array(output({ fileId: id(), name: z.string(), sha256: z.string(), sizeBytes: z.number().int(), status: z.string(), createdAt: instant() })),
      links: z.array(linkStateView),
      mails: z.array(
        output({
          id: id(),
          to: z.array(z.string()),
          cc: z.array(z.string()),
          subject: z.string(),
          status: z.string(),
          queuedAt: instant(),
          sentAt: instant().nullable(),
          deliveredAt: instant().nullable(),
          failedAt: instant().nullable(),
          lastError: z.string().nullable(),
        }),
      ),
    }),
  },
})

export const supplierViewContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      order: output({
        id: id(),
        number: z.string(),
        documentNumber: z.string(),
        status: z.enum(PURCHASE_ORDER_STATUSES),
        revision: z.number().int(),
        orderDate: z.string(),
        requestedDate: z.string().nullable(),
        incoterms: z.string().nullable(),
        paymentTerms: z.string().nullable(),
        note: z.string().nullable(),
        sentAt: instant().nullable(),
        confirmedAt: instant().nullable(),
        confirmedVia: z.enum(['LINK', 'OFFICE']).nullable(),
        confirmedByName: z.string().nullable(),
        supplierRef: z.string().nullable(),
        confirmNote: z.string().nullable(),
        declinedAt: instant().nullable(),
        declineReason: z.string().nullable(),
        cancelledAt: instant().nullable(),
        version: z.number().int(),
      }),
      lines: z.array(
        output({
          id: id(),
          seq: z.number().int(),
          code: z.string().nullable(),
          name: z.string().nullable(),
          colour: output({ name: z.string().nullable(), supplierCode: z.string().nullable() }).nullable(),
          description: z.string().nullable(),
          quantity: z.string(),
          uom: z.enum(UOMS),
          baseQuantity: z.string(),
          baseUom: z.enum(UOMS).nullable(),
          needDate: z.string(),
          grade: z.string().nullable(),
          thicknessMinMm: z.string().nullable(),
          thicknessMaxMm: z.string().nullable(),
          oneDyeBatch: z.boolean(),
          areaTolerancePct: z.string().nullable(),
          estimatedHides: z.number().int().nullable(),
          requiresCrViTest: z.boolean(),
          note: z.string().nullable(),
          confirmedQuantity: z.string().nullable(),
          confirmedDate: z.string().nullable(),
          version: z.number().int(),
        }),
      ),
    }),
  },
})
