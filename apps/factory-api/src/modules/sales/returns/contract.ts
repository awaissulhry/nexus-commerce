import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import {
  FREIGHT_PAYERS,
  GOODS_OUTCOMES,
  PARCEL_CONDITIONS,
  RETURN_ACTIONS,
  RETURN_CAUSES,
  RETURN_DISPOSITIONS,
  RETURN_FOLLOW_UPS,
  RETURN_GRADES,
  RETURN_LIMITS,
  RETURN_LIST_VIEWS,
  RETURN_STATUSES,
  STEP_STATES,
  TRACKING_STEPS,
} from '@nexus/factory-domain/sales/returns/rules'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * Customer returns (B-W2a-43; SAL-333, SAL-335, SAL-340, SAL-341, SAL-352, SAL-362, LOG-114, QHS-117; design
 * sales.returns, floor.returnsin). Prices, discounts and credit values are money.price (dropped for a caller without
 * the grain; a body that sends a credit without it is refused). Every write takes an Idempotency-Key and the RMA's
 * `version` (COL-078). Refusals in words: `body/<field>` (400), a quantity above what was sold `body/lines/<i>/quantity`
 * (409), a state that takes no such change (409 invalid_state). No worker's name anywhere.
 */

const version = z.number().int().min(1)
const status = z.enum(RETURN_STATUSES)
const grade = z.enum(RETURN_GRADES)
const cause = z.enum(RETURN_CAUSES)
const disposition = z.enum(RETURN_DISPOSITIONS)
const outcome = z.enum(GOODS_OUTCOMES)
const parcel = z.enum(PARCEL_CONDITIONS)
const freight = z.enum(FREIGHT_PAYERS)
const text = (max: number) => z.string().max(max * 2)
const issue = output({ path: z.string(), message: z.string() })
const returnParams = input({ returnId: id() })
const ref = output({ id: id(), code: z.string(), name: z.string() })
const party = output({ id: id(), code: z.string(), legalName: z.string() })
const orderRef = output({ id: id(), number: z.string() })
const reason = output({ code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() })

const policyView = output({
  windowDays: z.number().int().nullable(),
  goodsDueDays: z.number().int().nullable(),
  freightPaidBy: freight.nullable(),
  restockingFeePct: z.string().nullable(),
  conditions: z.string().nullable(),
})

// ---- the record ---------------------------------------------------------------------------------------------------

export const lineView = output({
  id: id(),
  seq: z.number().int(),
  salesOrderLineId: id().nullable(),
  size: z.string().nullable(),
  invoiceLineId: id().nullable(),
  order: output({ id: id(), number: z.string(), lineSeq: z.number().int() }).nullable(),
  invoice: output({ id: id(), number: z.string().nullable(), issueDate: z.string().nullable(), lineSeq: z.number().int() }).nullable(),
  style: ref.nullable(),
  colourway: ref.nullable(),
  /** A protective garment (its style is PPE). */
  ppe: z.boolean(),
  /** A protective garment returned for a defect or found defective or misused: back on the market only after a safety check. */
  safety: z.boolean(),
  description: z.string(),
  serial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  quantity: z.number().int(),
  reasonCode: z.string(),
  reason: reason.nullable(),
  reasonNote: z.string().nullable(),
  currency: z.string().nullable(),
  /** As invoiced (what a credit starts from). */
  unitPrice: money.price(z.string().nullable()),
  discountPct: money.price(z.string().nullable()),
  receivedQuantity: z.number().int(),
  receivedAt: instant().nullable(),
  receiptId: id().nullable(),
  /** What the received pieces are worth, net, minor units. */
  receivedValue: money.price(z.number().int().nullable()),
  grade: grade.nullable(),
  cause: cause.nullable(),
  conditionNote: z.string().nullable(),
  inspectedAt: instant().nullable(),
  inspectedById: id().nullable(),
  photos: z.number().int(),
  suggestedOutcome: outcome.nullable(),
  /** Why the goods may not go back into stock as new (null: they may). */
  restockHeld: z.string().nullable(),
  disposition: disposition.nullable(),
  goodsOutcome: outcome.nullable(),
  decidedAt: instant().nullable(),
  decidedById: id().nullable(),
  creditAmount: money.price(z.number().int().nullable()),
  followUp: z.enum(RETURN_FOLLOW_UPS).nullable(),
  /** "A credit; goods are held in quarantine at A1-QUA; a credit note to make (Finance)" — no amount. */
  effect: z.string().nullable(),
  effectWithAmount: money.price(z.string().nullable()),
  stock: z.array(output({ moveId: id(), locationId: id().nullable(), locationCode: z.string().nullable(), quantity: z.string() })),
  replacementLineId: id().nullable(),
  version: z.number().int(),
})

export const returnView = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  company: ref.nullable(),
  siteId: id(),
  site: ref.nullable(),
  partyId: id(),
  party: party.nullable(),
  contactId: id().nullable(),
  customerRef: z.string().nullable(),
  salesOrder: orderRef.nullable(),
  status,
  statusWords: z.string(),
  requestedAt: instant(),
  authorisedAt: instant().nullable(),
  authorisedById: id().nullable(),
  goodsDueBy: z.string().nullable(),
  late: z.boolean(),
  receivedAt: instant().nullable(),
  inspectedAt: instant().nullable(),
  closedAt: instant().nullable(),
  statusReason: z.string().nullable(),
  ownerId: id().nullable(),
  internalNote: z.string().nullable(),
  replacementOrder: output({ id: id(), number: z.string(), status: z.string() }).nullable(),
  currency: z.string().nullable(),
  creditTotal: money.price(z.number().int()),
  lines: z.array(lineView),
  receipts: z.array(
    output({
      id: id(),
      receivedAt: instant(),
      parcels: z.number().int(),
      parcelCondition: parcel,
      carrierName: z.string().nullable(),
      trackingNumber: z.string().nullable(),
      customerDdtNumber: z.string().nullable(),
      customerDdtDate: z.string().nullable(),
      note: z.string().nullable(),
      photos: z.number().int(),
      lineIds: z.array(id()),
      createdById: id().nullable(),
    }),
  ),
  /** The return DDTs of goods sent back unchanged (shipping's DDTs for other reasons). */
  ddts: output({ live: z.array(output({ id: id(), number: z.string(), lineIds: z.array(id()) })), cancelled: z.array(output({ id: id(), number: z.string(), lineIds: z.array(id()) })) }),
  /** SAL-362: each step with its date. */
  tracking: z.array(output({ step: z.enum(TRACKING_STEPS), state: z.enum(STEP_STATES), at: z.string().nullable(), words: z.string() })),
  actions: z.array(output({ action: z.enum(RETURN_ACTIONS), allowed: z.boolean(), held: z.string().nullable() })),
  policy: policyView.extend({ freightPaidByNow: z.enum(['CUSTOMER', 'COMPANY']).nullable() }),
  stockOutcomes: z.array(outcome),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

const recordAnswer = output({ return: returnView })
const registerEntry = output({ lineId: id(), seq: z.number().int(), entryId: id().nullable(), reference: z.string().nullable(), opened: z.boolean(), words: z.string() })

// ---- the list -----------------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({
    view: z.enum(RETURN_LIST_VIEWS).optional(),
    status: z.string().max(120).optional(),
    partyId: id().optional(),
    salesOrderId: id().optional(),
    siteId: id().optional(),
    owner: z.string().max(40).optional(),
    q: z.string().max(80).optional(),
  }),
  response: {
    200: output({
      returns: z.array(
        output({
          id: id(),
          number: z.string(),
          companyId: id(),
          siteId: id(),
          site: output({ id: id(), code: z.string() }).nullable(),
          partyId: id(),
          party: party.nullable(),
          customerRef: z.string().nullable(),
          salesOrder: orderRef.nullable(),
          invoiceNumbers: z.array(z.string()),
          units: z.number().int(),
          receivedUnits: z.number().int(),
          reasonCodes: z.array(z.string()),
          reason: output({ code: z.string(), labelIt: z.string(), labelEn: z.string() }).nullable(),
          status,
          statusWords: z.string(),
          dispositions: z.array(disposition),
          receivedAt: instant().nullable(),
          goodsDueBy: z.string().nullable(),
          late: z.boolean(),
          currency: z.string().nullable(),
          creditTotal: money.price(z.number().int()),
          replacementOrder: orderRef.nullable(),
          ownerId: id().nullable(),
          requestedAt: instant(),
          updatedAt: instant(),
        }),
      ),
      truncated: z.boolean(),
    }),
  },
})

export const countsContract = defineContract({
  response: { 200: output({ counts: output({ waiting: z.number().int(), late: z.number().int(), toInspect: z.number().int(), toDecide: z.number().int(), replacement: z.number().int(), open: z.number().int() }), asOf: instant() }) },
})

export const getContract = defineContract({ params: returnParams, response: { 200: recordAnswer } })

// ---- the policy ---------------------------------------------------------------------------------------------------

const policyRow = policyView.extend({ id: id(), companyId: id().nullable(), version: z.number().int(), updatedAt: instant() })

export const getPolicyContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ policy: output({ tenant: policyRow.nullable(), company: policyRow.nullable(), inForce: policyView, followsTenant: z.boolean(), canManage: z.boolean() }) }) },
})

export const savePolicyContract = defineContract({
  body: input({
    companyId: id().optional(),
    version: version.optional(),
    windowDays: z.number().int().min(1).max(RETURN_LIMITS.days).nullable(),
    goodsDueDays: z.number().int().min(1).max(RETURN_LIMITS.days).nullable(),
    freightPaidBy: freight.nullable(),
    restockingFeePct: z.string().max(12).nullable(),
    conditions: text(RETURN_LIMITS.conditions).nullable(),
  }),
  response: { 200: output({ policy: policyRow }) },
})

// ---- what may come back -------------------------------------------------------------------------------------------

export const returnableContract = defineContract({
  querystring: input({ companyId: id(), partyId: id(), salesOrderId: id().optional(), invoiceId: id().optional() }),
  response: {
    200: output({
      lines: z.array(
        output({
          kind: z.enum(['INVOICED', 'SHIPPED']),
          invoiceLineId: id().nullable(),
          salesOrderLineId: id().nullable(),
          size: z.string().nullable(),
          description: z.string(),
          order: output({ id: id(), number: z.string(), lineSeq: z.number().int() }).nullable(),
          invoice: output({ id: id(), number: z.string().nullable(), issueDate: z.string().nullable(), lineSeq: z.number().int() }).nullable(),
          style: ref.nullable(),
          colourway: ref.nullable(),
          ppe: z.boolean(),
          sold: z.number().int(),
          taken: z.number().int(),
          shippedLeft: z.number().int().nullable(),
          left: z.number().int(),
          currency: z.string(),
          unitPrice: money.price(z.string().nullable()),
          discountPct: money.price(z.string().nullable()),
          pieceValue: money.price(z.number().int().nullable()),
          deliveredOn: z.string().nullable(),
          batchNumbers: z.array(z.string()),
          siteId: id().nullable(),
          warning: z.string().nullable(),
        }),
      ),
      policy: policyView,
    }),
  },
})

// ---- make and change ----------------------------------------------------------------------------------------------

const newLine = input({
  invoiceLineId: id().nullish(),
  salesOrderLineId: id().nullish(),
  size: z.string().trim().max(10).nullish(),
  quantity: z.number().int().min(1).max(100_000),
  reasonCode: z.string().min(1).max(40),
  reasonNote: text(RETURN_LIMITS.reasonNote).nullish(),
  serial: text(RETURN_LIMITS.serial).nullish(),
  batchNumber: text(RETURN_LIMITS.batchNumber).nullish(),
  description: text(RETURN_LIMITS.description).nullish(),
})

const createBody = input({
  companyId: id(),
  partyId: id(),
  siteId: id().nullish(),
  contactId: id().nullish(),
  customerRef: text(RETURN_LIMITS.customerRef).nullish(),
  salesOrderId: id().nullish(),
  ownerId: id().nullish(),
  internalNote: text(RETURN_LIMITS.internalNote).nullish(),
  goodsDueBy: businessDate().nullish(),
  lines: z.array(newLine).max(RETURN_LIMITS.lines),
})

export const previewContract = defineContract({
  body: createBody,
  response: {
    200: output({
      ok: z.boolean(),
      problems: z.array(issue),
      warnings: z.array(issue),
      goodsDueBy: z.string().nullable(),
      siteId: id().nullable(),
      salesOrderId: id().nullable(),
      lines: z.array(output({ invoiceLineId: id().nullable(), salesOrderLineId: id().nullable(), size: z.string().nullable(), quantity: z.number().int(), left: z.number().int(), description: z.string(), batchNumber: z.string().nullable(), ppe: z.boolean() })),
    }),
  },
})

export const createContract = defineContract({
  body: createBody,
  response: { 201: output({ return: returnView, warnings: z.array(issue), registerEntries: z.array(registerEntry) }) },
})

export const headerContract = defineContract({
  params: returnParams,
  body: input({
    version,
    customerRef: text(RETURN_LIMITS.customerRef).nullish(),
    contactId: id().nullish(),
    ownerId: id().nullish(),
    internalNote: text(RETURN_LIMITS.internalNote).nullish(),
    goodsDueBy: businessDate().nullish(),
  }),
  response: { 200: recordAnswer },
})

export const addLinesContract = defineContract({
  params: returnParams,
  body: input({ version, lines: z.array(newLine).min(1).max(RETURN_LIMITS.lines) }),
  response: { 201: output({ return: returnView, lineIds: z.array(id()) }) },
})

const lineParams = input({ returnId: id(), lineId: id() })

export const changeLineContract = defineContract({
  params: lineParams,
  body: input({
    version,
    quantity: z.number().int().min(1).max(100_000).optional(),
    reasonCode: z.string().min(1).max(40).optional(),
    reasonNote: text(RETURN_LIMITS.reasonNote).nullish(),
    serial: text(RETURN_LIMITS.serial).nullish(),
    batchNumber: text(RETURN_LIMITS.batchNumber).nullish(),
    description: text(RETURN_LIMITS.description).optional(),
  }),
  response: { 200: recordAnswer },
})

export const removeLineContract = defineContract({
  params: lineParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: recordAnswer },
})

const reasonBody = input({ version, reason: text(RETURN_LIMITS.statusReason) })
export const cancelContract = defineContract({ params: returnParams, body: reasonBody, response: { 200: recordAnswer } })
export const closeContract = defineContract({ params: returnParams, body: reasonBody, response: { 200: output({ return: returnView, warnings: z.array(issue) }) } })

// ---- the dock -----------------------------------------------------------------------------------------------------

const place = output({ id: id(), code: z.string(), name: z.string() })

export const dockView = output({
  id: id(),
  number: z.string(),
  siteId: id(),
  site: ref.nullable(),
  customerRef: z.string().nullable(),
  status,
  goodsDueBy: z.string().nullable(),
  receivedAt: instant().nullable(),
  lines: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      description: z.string(),
      style: output({ code: z.string(), name: z.string() }).nullable(),
      colourway: output({ code: z.string(), name: z.string() }).nullable(),
      size: z.string().nullable(),
      serial: z.string().nullable(),
      batchNumber: z.string().nullable(),
      ppe: z.boolean(),
      safety: z.boolean(),
      reasonCode: z.string(),
      reason: output({ labelIt: z.string(), labelEn: z.string() }).nullable(),
      reasonNote: z.string().nullable(),
      quantity: z.number().int(),
      receivedQuantity: z.number().int(),
      expected: z.number().int(),
      grade: grade.nullable(),
      cause: cause.nullable(),
      conditionNote: z.string().nullable(),
      photos: z.number().int(),
      suggestedOutcome: outcome.nullable(),
      restockHeld: z.string().nullable(),
      disposition: disposition.nullable(),
      goodsOutcome: outcome.nullable(),
      place: z.string().nullable(),
      version: z.number().int(),
    }),
  ),
  receipts: z.array(output({ id: id(), receivedAt: instant(), parcels: z.number().int(), parcelCondition: parcel, customerDdtNumber: z.string().nullable(), photos: z.number().int() })),
  places: output({ inspection: place.nullable(), quarantine: place.nullable(), finishedGoods: place.nullable() }),
  version: z.number().int(),
})

export const findDockContract = defineContract({ querystring: input({ code: z.string().min(1).max(60) }), response: { 200: output({ return: dockView }) } })
export const getDockContract = defineContract({ params: returnParams, response: { 200: output({ return: dockView }) } })

export const receiveContract = defineContract({
  params: returnParams,
  body: input({
    version,
    parcels: z.number().int().min(1).max(RETURN_LIMITS.parcels),
    parcelCondition: parcel,
    carrierName: text(RETURN_LIMITS.carrierName).nullish(),
    trackingNumber: text(RETURN_LIMITS.trackingNumber).nullish(),
    customerDdtNumber: text(RETURN_LIMITS.ddtNumber).nullish(),
    customerDdtDate: businessDate().nullish(),
    note: text(RETURN_LIMITS.receiptNote).nullish(),
    lines: z.array(input({ lineId: id(), quantity: z.number().int().min(1).max(100_000) })).max(RETURN_LIMITS.lines),
  }),
  response: { 201: output({ return: dockView, receiptId: id() }) },
})

export const gradeContract = defineContract({
  params: returnParams,
  body: input({ version, lines: z.array(input({ lineId: id(), grade, cause: cause.nullish(), conditionNote: text(RETURN_LIMITS.conditionNote).nullish() })).min(1).max(RETURN_LIMITS.lines) }),
  response: { 200: output({ return: dockView }) },
})

// ---- the decision -------------------------------------------------------------------------------------------------

const decisionLine = input({
  lineId: id(),
  disposition,
  goodsOutcome: outcome.nullish(),
  /** Minor units: the credit value (price grain). */
  creditAmount: money.price(z.number().int().min(0).nullish()),
  toLocationId: id().nullish(),
})

export const previewDecisionsContract = defineContract({
  params: returnParams,
  body: input({ version: version.optional(), lines: z.array(decisionLine).min(1).max(RETURN_LIMITS.lines) }),
  response: {
    200: output({
      ok: z.boolean(),
      problems: z.array(issue),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          disposition,
          goodsOutcome: outcome,
          creditAmount: money.price(z.number().int()),
          receivedValue: money.price(z.number().int().nullable()),
          currency: z.string().nullable(),
          place: output({ id: id(), code: z.string() }).nullable(),
          followUp: z.enum(RETURN_FOLLOW_UPS).nullable(),
          effect: z.string(),
          effectWithAmount: money.price(z.string()),
          options: z.array(output({ disposition, outcomes: z.array(output({ outcome, held: z.string().nullable() })), defaultCredit: money.price(z.number().int()) })),
          problems: z.array(issue),
        }),
      ),
    }),
  },
})

export const decideContract = defineContract({
  params: returnParams,
  body: input({ version, lines: z.array(decisionLine).min(1).max(RETURN_LIMITS.lines) }),
  response: { 200: output({ return: returnView, moves: z.array(output({ lineId: id(), moveId: id(), locationId: id().nullable() })), registerEntries: z.array(registerEntry) }) },
})

export const replacementContract = defineContract({
  params: returnParams,
  body: input({ version, promiseDate: businessDate().nullish(), customerRef: text(RETURN_LIMITS.customerRef).nullish(), internalNote: text(RETURN_LIMITS.internalNote).nullish() }),
  response: { 201: output({ return: returnView, order: orderRef }) },
})

// ---- photos -------------------------------------------------------------------------------------------------------

const photoBody = input({
  originalName: z.string().min(1).max(500),
  /** A picture: the PHOTO kind's types (JPEG, PNG, WebP, HEIC). */
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  sha256: z.string(),
})
const uploadAnswer = { 201: output({ file: fileView, upload: presignedView }) }

export const announceReceiptPhotoContract = defineContract({ params: input({ returnId: id(), receiptId: id() }), body: photoBody, response: uploadAnswer })
export const completeReceiptPhotoContract = defineContract({ params: input({ returnId: id(), receiptId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })
export const announceLinePhotoContract = defineContract({ params: lineParams, body: photoBody, response: uploadAnswer })
export const completeLinePhotoContract = defineContract({ params: input({ returnId: id(), lineId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })
