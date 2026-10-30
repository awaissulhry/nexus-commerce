import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { MAX_LINES, MAX_TEXT, PURCHASE_ORDER_STATUSES, SEND_CHECK_CODES } from '@nexus/factory-domain/purchasing/orders'
import { REACH_ACTIONS } from '@nexus/factory-domain/purchasing/orders/changes'
import { DELIVERY_STATES } from '@nexus/factory-domain/purchasing/orders/delivery'
import { LINE_DIFF_KINDS, MAX_CHANGE_NOTE, REVISION_ANSWERS } from '@nexus/factory-domain/purchasing/revisions/revisions'
import { ERROR_CODES } from '@nexus/factory-domain/core/errors'

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
  /** Received so far by the posted goods receipts, in the material's base unit. */
  receivedBaseQuantity: z.string(),
  /** The plan lines this line buys (What to buy & make), with their run's state and decision. */
  plan: z.array(output({ requirementId: id(), runId: id(), runStatus: z.string(), decision: z.string() })),
  /** B-W2a-52: cancelled (nothing more of it is wanted) or closed short (the rest will not come); null while open. */
  ended: output({ kind: z.enum(['CANCELLED', 'CLOSED_SHORT']), at: instant(), byId: id().nullable(), reason: z.string().nullable() }).nullable(),
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
  /** B-W2a-52: the lines not cancelled (a sent order's netAmount stays as it was sent). */
  openNetAmount: money.cost(z.number().int()),
  lineCount: z.number().int(),
  earliestNeedDate: z.string().nullable(),
  sentAt: instant().nullable(),
  sentById: id().nullable(),
  /** B-W2a-52 (SCM-087): when the supplier is asked to answer by (set at the send; the office may move it). */
  confirmBy: instant().nullable(),
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
    /** Only orders sent more than 48 hours ago that the supplier has not answered (the "Not confirmed after 48 h" tile). */
    waitingOver48h: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    /** B-W2a-52 (SCM-067): only orders with an open line expected late (before today) or this week (today to Sunday). */
    due: z.enum(['LATE', 'THIS_WEEK']).optional(),
    /** B-W2a-52 (SCM-087): only orders still waiting for the supplier's answer after their confirm-by time. */
    pastConfirmBy: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      /** "Where POs stand": drafts to send, waiting for the supplier, not confirmed 48 hours after the send, declined. */
      summary: output({
        drafts: z.number().int(),
        waiting: z.number().int(),
        notConfirmedAfter48h: z.number().int(),
        changesProposed: z.number().int(),
        declined: z.number().int(),
        /** B-W2a-52: orders with an open line expected this week / late; null when not every open line could be read ("—"). */
        dueThisWeek: z.number().int().nullable(),
        late: z.number().int().nullable(),
        /** B-W2a-52: orders still waiting after their confirm-by time. */
        pastConfirmBy: z.number().int(),
      }),
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
          confirmBy: instant().nullable(),
          confirmedAt: instant().nullable(),
          confirmedVia: z.enum(['LINK', 'OFFICE']).nullable(),
          confirmedByName: z.string().nullable(),
          declinedAt: instant().nullable(),
          /** B-W2a-52: the next open line's expected day (confirmed, else needed) and where the deliveries stand. */
          nextExpectedDate: z.string().nullable(),
          delivery: z.enum(DELIVERY_STATES).nullable(),
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

/** The order's PDF before it is sent (the cost grain: it prints the prices); stored nowhere. */
export const previewContract = defineContract({
  params: orderParams,
  querystring: input({ language: z.enum(['it', 'en']).optional() }),
  response: {},
})

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
      /** B-W2a-52: the confirm-by time the send sets unless one is given; the revision; what a later one changes (words). */
      confirmBy: instant(),
      revision: z.number().int(),
      changes: z.array(z.string()).nullable(),
    }),
  },
})

/** Where the mail is: sent, failed (FAILED, with why: send a new link), or null on a repeated request. */
const delivery = z.enum(['sent', 'failed', 'retry', 'settled']).nullable()

export const sendContract = defineContract({
  params: orderParams,
  body: input({
    version,
    cc: z.array(email).max(10).optional(),
    subject: text(200).nullish(),
    message: text(MAX_TEXT.message).nullish(),
    /** B-W2a-52 (SCM-087): when the supplier is asked to answer by; default 48 hours, longer by its closed days. */
    confirmBy: instant().nullish(),
    /** B-W2a-52 (SCM-058): a later revision's note to the supplier: what changed and why. */
    changeNote: text(MAX_CHANGE_NOTE).nullish(),
  }),
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
        confirmBy: instant(),
        /** The revision row of this send (factory-db PurchaseOrderRevision). */
        revisionId: id(),
        /** A later revision: what changed, in the supplier's words (the mail says it too). */
        changes: z.array(z.string()).nullable(),
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

/** B-W2a-52: what a cancel or close short reaches (the dialogs' "Reach"): per line, and the pegged work and sales orders. */
const peggedView = output({
  kind: z.string(),
  workOrder: output({ id: id(), number: z.string().nullable() }).nullable(),
  salesOrder: output({ id: id(), number: z.string().nullable() }).nullable(),
  size: z.string().nullable(),
  demandDate: z.string(),
  quantity: z.string(),
})
const reachView = output({
  /** The site's latest plan the pegging is read from (null: none). */
  runId: id().nullable(),
  lines: z.array(
    output({
      lineId: id(),
      seq: z.number().int(),
      label: z.string(),
      baseUom: z.string(),
      orderedBase: z.string(),
      receivedBase: z.string(),
      outstandingBase: z.string(),
      planLineIds: z.array(id()),
      pegged: z.array(peggedView),
    }),
  ),
  workOrders: z.array(output({ id: id(), number: z.string().nullable() })),
  salesOrders: z.array(output({ id: id(), number: z.string().nullable() })),
})

export const cancelContract = defineContract({
  params: orderParams,
  body: input({ version, reason: text(MAX_TEXT.reason).min(1), message: text(MAX_TEXT.message).nullish() }),
  response: { 200: output({ order: orderView, supplierTold: z.boolean(), reach: reachView }) },
})

// ---- B-W2a-52: changes after the send ------------------------------------------------------------------------------------

export const changeContract = defineContract({
  params: orderParams,
  body: input({ version, note: text(MAX_CHANGE_NOTE).nullish() }),
  response: { 200: output({ order: orderView, revision: z.number().int(), revokedLinkIds: z.array(id()) }) },
})

const endBody = input({
  version,
  lineIds: z.array(id()).min(1).max(MAX_LINES),
  reason: text(MAX_TEXT.reason).min(1),
  /** The office's own words for the supplier, after the standard text. */
  message: text(MAX_TEXT.message).nullish(),
})

export const cancelLinesContract = defineContract({ params: orderParams, body: endBody, response: { 200: output({ order: orderView, reach: reachView, supplierTold: z.boolean() }) } })

export const closeShortContract = defineContract({ params: orderParams, body: endBody, response: { 200: output({ order: orderView, reach: reachView, supplierTold: z.boolean() }) } })

export const reachContract = defineContract({
  params: orderParams,
  querystring: input({
    action: z.enum(REACH_ACTIONS),
    /** CANCEL_LINES and CLOSE_SHORT: the lines, comma-separated. */
    lineIds: z
      .string()
      .max(MAX_LINES * 37)
      .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part !== ''))
      .pipe(z.array(id()).max(MAX_LINES))
      .optional(),
  }),
  response: {
    200: output({
      action: z.enum(REACH_ACTIONS),
      status: z.enum(PURCHASE_ORDER_STATUSES),
      allowed: z.boolean(),
      problems: z.array(z.string()),
      /** The caller holds what it takes (manage, and send when the supplier is told). */
      mayDo: z.boolean(),
      supplierTold: z.boolean(),
      /** The supplier confirmed the order: a cancel ends a contract. */
      confirmed: z.boolean(),
      ...reachView.shape,
    }),
  },
})

const diffView = output({
  header: z.array(output({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
  lines: z.array(output({ lineId: id(), seq: z.number().int(), itemId: id(), kind: z.enum(LINE_DIFF_KINDS), changes: z.array(output({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() })) })),
  count: z.number().int(),
})
const pricesView = output({ currency: z.string(), netAmount: money.cost(z.number().int()), lines: z.array(output({ id: id(), seq: z.number().int(), unitPrice: money.cost(z.string()), netAmount: money.cost(z.number().int()) })) })

export const revisionsContract = defineContract({
  params: orderParams,
  querystring: input({ language: z.enum(['it', 'en']).optional() }),
  response: {
    200: output({
      purchaseOrderId: id(),
      number: z.string(),
      revision: z.number().int(),
      status: z.enum(PURCHASE_ORDER_STATUSES),
      draft: output({ revision: z.number().int(), documentNumber: z.string(), changes: diffView, words: z.array(z.string()) }).nullable(),
      revisions: z.array(
        output({
          id: id(),
          revision: z.number().int(),
          documentNumber: z.string(),
          sentAt: instant(),
          sentById: id().nullable(),
          sentByName: z.string().nullable(),
          changeNote: z.string().nullable(),
          documentFileId: id().nullable(),
          changes: diffView,
          words: z.array(z.string()),
          answer: z.enum(REVISION_ANSWERS),
          confirmation: output({ at: z.string(), via: z.string().nullable(), byName: z.string().nullable(), supplierRef: z.string().nullable() }).nullable(),
          lines: z.number().int(),
          /** The cost grain: the prices of the revision and the one before, and what changed in them. */
          prices: money.cost(
            output({
              before: pricesView.nullable(),
              after: pricesView,
              changed: output({
                netAmount: money.cost(output({ before: z.number().int(), after: z.number().int() }).nullable()),
                lines: z.array(
                  output({
                    lineId: id(),
                    seq: z.number().int(),
                    unitPrice: money.cost(output({ before: z.string().nullable(), after: z.string().nullable() }).nullable()),
                    netAmount: money.cost(output({ before: z.number().int().nullable(), after: z.number().int().nullable() })),
                  }),
                ),
              }),
            }).optional(),
          ),
        }),
      ),
    }),
  },
})

export const expectedContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    siteId: id().optional(),
    partyId: id().optional(),
    state: z.enum(DELIVERY_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: {
    200: output({
      today: z.string(),
      /** False when more open lines exist than one read takes: the tiles are then a floor. */
      complete: z.boolean(),
      tiles: output({ LATE: output({ lines: z.number().int(), orders: z.number().int() }), THIS_WEEK: output({ lines: z.number().int(), orders: z.number().int() }), LATER: output({ lines: z.number().int(), orders: z.number().int() }) }),
      lines: z.array(
        output({
          lineId: id(),
          purchaseOrderId: id(),
          number: z.string(),
          status: z.enum(PURCHASE_ORDER_STATUSES),
          revision: z.number().int(),
          companyId: id(),
          siteId: id(),
          partyId: id(),
          supplierName: z.string(),
          seq: z.number().int(),
          itemId: id(),
          item: output({ code: z.string(), name: z.string() }),
          itemColourId: id().nullable(),
          colour: output({ code: z.string(), name: z.string() }).nullable(),
          uom: z.enum(UOMS),
          baseUom: z.enum(UOMS).nullable(),
          needDate: z.string(),
          confirmedDate: z.string().nullable(),
          expectedDate: z.string(),
          dateFrom: z.enum(['CONFIRMED', 'ASKED']),
          orderedBase: z.string(),
          expectedBase: z.string(),
          receivedBase: z.string(),
          outstandingBase: z.string(),
          state: z.enum(DELIVERY_STATES),
          daysLate: z.number().int(),
        }),
      ),
      more: z.boolean(),
    }),
  },
})

const refusedView = output({ code: z.enum(ERROR_CODES), message: z.string(), issues: z.array(output({ path: z.string(), message: z.string() })) })

export const sendManyContract = defineContract({
  body: input({
    orders: z.array(input({ id: id(), version, confirmBy: instant().nullish() })).min(1).max(50),
    message: text(MAX_TEXT.message).nullish(),
  }),
  response: {
    200: output({
      sent: z.number().int(),
      refused: z.number().int(),
      outcomes: z.array(
        output({
          id: id(),
          number: z.string().nullable(),
          outcome: z.enum(['SENT', 'REFUSED']),
          sent: sendContract.response[200].shape.sent.nullable(),
          delivery,
          refused: refusedView.nullable(),
        }),
      ),
    }),
  },
})

export const sendChecksContract = defineContract({
  body: input({ orderIds: z.array(id()).min(1).max(50) }),
  response: {
    200: output({
      ready: z.number().int(),
      cards: z.array(
        output({
          id: id(),
          number: z.string().nullable(),
          partyId: id().nullable(),
          status: z.enum(PURCHASE_ORDER_STATUSES).nullable(),
          version: z.number().int().nullable(),
          ready: z.boolean(),
          checks: z.array(checkView),
          recipient: output({ contactId: id(), name: z.string(), email: z.string().nullable() }).nullable(),
          documentNumber: z.string().nullable(),
          language: z.enum(['it', 'en']).nullable(),
          linkExpiresAt: instant().nullable(),
          subject: z.string().nullable(),
          message: z.string().nullable(),
          confirmBy: instant().nullable(),
          revision: z.number().int().nullable(),
          changes: z.array(z.string()).nullable(),
          refused: refusedView.nullable(),
        }),
      ),
    }),
  },
})

const reminderView = output({
  id: id(),
  revision: z.number().int(),
  kind: z.string(),
  sentAt: instant(),
  automatic: z.boolean(),
  sentById: id().nullable(),
  sentByName: z.string().nullable(),
  to: z.string().nullable(),
  emailId: id().nullable(),
  mailStatus: z.string().nullable(),
  note: z.string().nullable(),
})

export const remindContract = defineContract({
  params: orderParams,
  body: input({ version, message: text(MAX_TEXT.message).nullish() }),
  response: { 200: output({ order: orderView, reminder: output({ id: id(), revision: z.number().int(), sentAt: instant(), to: z.string(), emailId: id(), automatic: z.boolean() }) }) },
})

export const remindersContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      purchaseOrderId: id(),
      number: z.string(),
      status: z.enum(PURCHASE_ORDER_STATUSES),
      revision: z.number().int(),
      /** The company's automatic reminders (the Owner's switch; off until a setting holds it). */
      automatic: z.boolean(),
      confirmBy: instant().nullable(),
      overdue: z.boolean(),
      sentForRevision: z.number().int(),
      nextAutomaticAt: instant().nullable(),
      reminders: z.array(reminderView),
    }),
  },
})

export const dueRemindersContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional(), partyId: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: {
    200: output({
      orders: z.array(
        output({
          id: id(),
          number: z.string(),
          companyId: id(),
          siteId: id(),
          partyId: id(),
          supplierName: z.string(),
          revision: z.number().int(),
          sentAt: instant().nullable(),
          confirmBy: instant(),
          remindersSent: z.number().int(),
          lastReminderAt: instant().nullable(),
          nextAutomaticAt: instant().nullable(),
          automatic: z.boolean(),
          version: z.number().int(),
        }),
      ),
      more: z.boolean(),
    }),
  },
})

export const moveConfirmByContract = defineContract({ params: orderParams, body: input({ version, confirmBy: instant() }), response: { 200: one } })

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
          /** B-W2a-52: cancelled or closed short (null while open). */
          ended: z.enum(['CANCELLED', 'CLOSED_SHORT']).nullable(),
          version: z.number().int(),
        }),
      ),
    }),
  },
})
