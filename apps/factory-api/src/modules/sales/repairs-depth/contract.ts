import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { REPAIR_KINDS, REPAIR_STAGES, REPAIR_STEPS, STEP_STATES } from '@nexus/factory-domain/sales/repairs/rules'
import { ANSWER_VIAS, CUSTOMER_NEXT, DEPTH_LIMITS, ESTIMATE_ACTIONS, ESTIMATE_ANSWERS, ESTIMATE_LINE_KINDS, ESTIMATE_STATUSES, REQUEST_CHANNELS } from '@nexus/factory-domain/sales/repairs-depth/rules'

/**
 * Repairs and alterations in depth (B-W2b-342; SAL-384, SAL-385, SAL-387, SAL-391, SAL-393; RR1:01, RR1:02). Every write
 * takes an Idempotency-Key and the version of what it changes (COL-078); refusals in words: `body/<field>` (400), a state
 * that takes no such change (409 invalid_state), a stale version (409 conflict). Money is marked by grain: prices
 * `money.price`, our costs `money.cost` (the serializer drops them for a caller without the grain; a write that sends one
 * without it is refused). No worker's name: office people by id with their names in `people`.
 */

const at = instant()
const version = z.number().int().min(1)
const kind = z.enum(REPAIR_KINDS)
const stage = z.enum(REPAIR_STAGES)
const repairParams = input({ repairId: id() })
const estimateParams = input({ estimateId: id() })
const lineParams = input({ estimateId: id(), lineId: id() })
const fileParams = input({ fileId: id() })
const ref = output({ code: z.string(), name: z.string() })
const person = output({ id: id(), name: z.string() })
const text = (max: number) => z.string().trim().max(max)

const photoBody = { originalName: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }
const fileAnswer = output({ id: id(), originalName: z.string(), sizeBytes: z.number().int(), status: z.string() })
const uploadAnswer = output({ file: fileAnswer, upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: at }) })
const openAnswer = output({
  file: output({ id: id(), name: z.string(), contentType: z.string() }),
  download: output({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: at }),
})
const openBody = input({ mode: z.enum(['download', 'preview']).default('preview') })

// ---- the office: the estimate ---------------------------------------------------------------------------------------

const officeLine = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(ESTIMATE_LINE_KINDS),
  item: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  description: z.string(),
  quantity: z.string(),
  minutes: z.number().int().nullable(),
  unitPrice: money.price(z.string()),
  amount: money.price(z.number().int()),
  unitCost: money.cost(z.string().nullable()),
  costAmount: money.cost(z.number().int().nullable()),
  version: z.number().int(),
})

const summary = output({
  amount: money.price(z.number().int()),
  partsAmount: money.price(z.number().int()),
  labourAmount: money.price(z.number().int()),
  costAmount: money.cost(z.number().int().nullable()),
  labourMinutes: z.number().int(),
  lines: z.number().int(),
})

const estimateView = output({
  id: id(),
  revision: z.number().int(),
  status: z.enum(ESTIMATE_STATUSES),
  currency: z.string(),
  validUntil: businessDate().nullable(),
  customerNote: z.string().nullable(),
  internalNote: z.string().nullable(),
  sentAt: at.nullable(),
  sentById: id().nullable(),
  answeredAt: at.nullable(),
  answeredVia: z.enum(ANSWER_VIAS).nullable(),
  answeredByName: z.string().nullable(),
  recordedById: id().nullable(),
  declineReason: z.string().nullable(),
  withdrawnAt: at.nullable(),
  withdrawnById: id().nullable(),
  version: z.number().int(),
  createdAt: at,
  createdById: id().nullable(),
  lines: z.array(officeLine),
  summary,
  actions: z.array(output({ action: z.enum(ESTIMATE_ACTIONS), allowed: z.boolean(), held: z.string().nullable() })),
})

export const estimatesAnswer = output({
  repair: output({ id: id(), number: z.string(), stage, version: z.number().int(), partyId: id() }),
  /** Every revision, newest first. */
  estimates: z.array(estimateView),
  /** The live one (DRAFT or SENT), if any. */
  liveId: id().nullable(),
  /** "New estimate": allowed, or held with why; `replaces` = the sent one a new revision withdraws. */
  newEstimate: output({ allowed: z.boolean(), held: z.string().nullable(), replaces: id().nullable() }),
  /** The stage moves the estimate holds ("approved by the customer before work starts"), in words, or null. */
  workHeld: output({ approve: z.string().nullable(), startRepair: z.string().nullable() }),
  seesPrices: notMoney(z.boolean()),
  seesCosts: notMoney(z.boolean()),
  people: z.array(person),
})

export const estimatesContract = defineContract({ params: repairParams, response: { 200: estimatesAnswer } })

export const newEstimateContract = defineContract({
  params: repairParams,
  body: input({
    replaces: id().nullish(),
    copyLines: z.boolean().optional(),
    currency: z.string().length(3).optional(),
    validUntil: businessDate().nullish(),
    customerNote: text(DEPTH_LIMITS.customerNote).nullish(),
    internalNote: text(DEPTH_LIMITS.internalNote).nullish(),
  }),
  response: { 201: estimatesAnswer },
})

export const termsContract = defineContract({
  params: estimateParams,
  body: input({
    version,
    currency: z.string().length(3).optional(),
    validUntil: businessDate().nullish(),
    customerNote: text(DEPTH_LIMITS.customerNote).nullish(),
    internalNote: text(DEPTH_LIMITS.internalNote).nullish(),
  }),
  response: { 200: estimatesAnswer },
})

const lineFields = {
  kind: z.enum(ESTIMATE_LINE_KINDS).optional(),
  itemId: id().nullish(),
  description: text(DEPTH_LIMITS.description + 50).optional(),
  quantity: quantity().optional(),
  minutes: z.number().int().nullish(),
  unitPrice: money.price(unitPrice()),
  unitCost: money.cost(unitPrice().nullable()),
}

export const addLineContract = defineContract({ params: estimateParams, body: input({ version, ...lineFields }), response: { 201: estimatesAnswer } })
export const changeLineContract = defineContract({ params: lineParams, body: input({ version, ...lineFields }), response: { 200: estimatesAnswer } })
export const removeLineContract = defineContract({ params: lineParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: estimatesAnswer } })
export const sendContract = defineContract({ params: estimateParams, body: input({ version }), response: { 200: estimatesAnswer } })
export const answerContract = defineContract({
  params: estimateParams,
  body: input({
    version,
    answer: z.enum(ESTIMATE_ANSWERS),
    how: text(DEPTH_LIMITS.how),
    at: at.optional(),
    answeredByName: text(DEPTH_LIMITS.answeredByName).nullish(),
    declineReason: text(DEPTH_LIMITS.declineReason).nullish(),
  }),
  response: { 200: estimatesAnswer },
})
export const withdrawContract = defineContract({ params: estimateParams, body: input({ version, reason: text(DEPTH_LIMITS.how).nullish() }), response: { 200: estimatesAnswer } })

// ---- the office: the intake, photos, the history ------------------------------------------------------------------

export const intakeAnswer = output({
  intake: output({
    repair: output({ id: id(), number: z.string(), kind, stage, channel: z.enum(REQUEST_CHANNELS), partyId: id(), version: z.number().int() }),
    problem: z.string(),
    workWanted: z.string().nullable(),
    garment: output({
      serial: z.string().nullable(),
      /** The serial when it is one of ours (the garment's history). */
      garmentSerial: z.string().nullable(),
      ours: output({ style: ref.nullable(), size: z.string(), madeOn: businessDate(), workOrderNumber: z.string(), batchNumber: z.string().nullable(), forThisCustomer: z.boolean() }).nullable(),
      otherRepairs: z.number().int(),
    }),
    photos: z.array(output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string(), at, fromCustomer: z.boolean() })),
    photosNeeded: z.number().int(),
    photosHeld: z.string().nullable(),
    /** The safety rule (SAL-393): a protective garment, also altered, goes back only after a passed check. */
    cover: output({
      required: z.boolean(),
      styleKnown: z.boolean(),
      outcome: z.enum(['covered', 'not_required', 'refused']).nullable(),
      certificate: output({ id: id(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable() }).nullable(),
      reasons: z.array(z.string()),
      words: z.string(),
    }),
  }),
})

export const intakeContract = defineContract({ params: repairParams, response: { 200: intakeAnswer } })
export const officePhotoContract = defineContract({ params: repairParams, body: input(photoBody), response: { 201: uploadAnswer } })
export const officePhotoDoneContract = defineContract({ params: input({ repairId: id(), fileId: id() }), response: { 200: output({ file: fileAnswer }) } })

export const historyContract = defineContract({
  querystring: input({ serial: z.string().max(DEPTH_LIMITS.query) }),
  response: {
    200: output({
      serial: z.string(),
      garment: output({
        serial: z.string(),
        style: output({ code: z.string(), name: z.string(), ppeCategory: z.string() }).nullable(),
        colourway: ref.nullable(),
        size: z.string(),
        madeOn: businessDate(),
        workOrderNumber: z.string(),
        batchNumber: z.string().nullable(),
        madeFor: output({ id: id(), code: z.string(), legalName: z.string() }).nullable(),
      }).nullable(),
      repairs: z.array(
        output({
          id: id(),
          number: z.string(),
          kind,
          stage,
          status: z.string(),
          channel: z.enum(REQUEST_CHANNELS),
          party: output({ id: id(), code: z.string(), legalName: z.string() }).nullable(),
          problem: z.string(),
          workWanted: z.string().nullable(),
          receivedAt: at.nullable(),
          repairedAt: at.nullable(),
          shippedAt: at.nullable(),
          safetyResult: z.string().nullable(),
          createdAt: at,
          estimate: output({ revision: z.number().int(), status: z.enum(ESTIMATE_STATUSES), currency: z.string(), amount: money.price(z.number().int()) }).nullable(),
        }),
      ),
      /** Repairs of the garment the caller's role does not reach. */
      hidden: z.number().int(),
      returns: z.array(output({ lineId: id(), seq: z.number().int(), returnId: id(), number: z.string(), status: z.string(), reasonCode: z.string().nullable(), disposition: z.string().nullable(), receivedAt: at.nullable(), requestedAt: at.nullable() })),
      complaints: z.array(output({ id: id(), number: z.string(), status: z.string(), category: z.string().nullable(), receivedAt: at })),
      seesPrices: notMoney(z.boolean()),
    }),
  },
})

// ---- the customer: the portal and the claim link --------------------------------------------------------------------

const next = output({ code: z.enum(CUSTOMER_NEXT), forYou: z.boolean() })
const customerGarment = output({ style: ref.nullable(), colourway: ref.nullable(), size: z.string().nullable(), serial: z.string().nullable() })

const customerListItem = output({
  id: id(),
  number: z.string(),
  kind,
  stage,
  channel: z.enum(REQUEST_CHANNELS),
  opened: at,
  open: z.boolean(),
  next,
  garment: customerGarment,
  estimate: output({ revision: z.number().int(), status: z.enum(ESTIMATE_STATUSES) }).nullable(),
})

const customerRepair = output({
  id: id(),
  number: z.string(),
  kind,
  stage,
  channel: z.enum(REQUEST_CHANNELS),
  opened: at,
  version: z.number().int(),
  open: z.boolean(),
  problem: z.string(),
  workWanted: z.string().nullable(),
  garment: customerGarment,
  steps: z.array(output({ stage: z.enum(REPAIR_STEPS), state: z.enum(STEP_STATES), at: at.nullable() })),
  next,
  receivedAt: at.nullable(),
  repairedAt: at.nullable(),
  shippedAt: at.nullable(),
  cancelledAt: at.nullable(),
  sendTo: output({ name: z.string(), address: z.string().nullable() }).nullable(),
  photos: z.array(output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string(), at })),
  estimate: output({
    id: id(),
    revision: z.number().int(),
    status: z.enum(ESTIMATE_STATUSES),
    currency: z.string(),
    validUntil: businessDate().nullable(),
    customerNote: z.string().nullable(),
    sentAt: at.nullable(),
    answeredAt: at.nullable(),
    answeredVia: z.enum(ANSWER_VIAS).nullable(),
    declineReason: z.string().nullable(),
    version: z.number().int(),
    lines: z.array(output({ seq: z.number().int(), kind: z.enum(ESTIMATE_LINE_KINDS), description: z.string(), quantity: z.string(), minutes: z.number().int().nullable(), unitPrice: money.price(z.string()), amount: money.price(z.number().int()) })),
    amount: money.price(z.number().int()),
    partsAmount: money.price(z.number().int()),
    labourAmount: money.price(z.number().int()),
    labourMinutes: z.number().int(),
  }).nullable(),
  /** Held codes (null: allowed): addPhotos PREVIEW | NO_REQUEST | NO_UPLOAD | STAGE | FULL; answer NOT_ASKED | PREVIEW | NO_REQUEST | NO_PRICES | EXPIRED. */
  actions: output({ addPhotos: z.string().nullable(), answer: z.string().nullable() }),
})

const requestBody = {
  kind,
  salesOrderLineId: id().nullish(),
  size: text(DEPTH_LIMITS.size).nullish(),
  serial: text(DEPTH_LIMITS.serial).nullish(),
  problem: text(DEPTH_LIMITS.problem).nullish(),
  workWanted: text(DEPTH_LIMITS.workWanted).nullish(),
}

const sent = output({ type: z.literal('REPAIR'), id: id(), number: z.string(), answerBy: businessDate().nullable() })
const portalRecord = output({ repair: customerRepair, mayRequest: z.boolean(), mayUpload: z.boolean(), seesPrices: notMoney(z.boolean()) })

export const portalListContract = defineContract({ response: { 200: output({ items: z.array(customerListItem), mayRequest: z.boolean(), seesPrices: notMoney(z.boolean()), asOf: at }) } })
export const portalRequestContract = defineContract({ body: input(requestBody), response: { 201: portalRecord.extend({ sent }) } })
export const portalRepairContract = defineContract({ params: repairParams, response: { 200: portalRecord } })
export const portalPhotoContract = defineContract({ params: repairParams, body: input(photoBody), response: { 201: uploadAnswer } })
export const portalPhotoDoneContract = defineContract({ params: input({ repairId: id(), fileId: id() }), response: { 200: output({ file: fileAnswer }) } })
export const portalOpenFileContract = defineContract({ params: fileParams, body: openBody, response: { 200: openAnswer } })
export const portalAnswerContract = defineContract({
  params: repairParams,
  body: input({ estimateId: id(), version, answer: z.enum(ESTIMATE_ANSWERS), declineReason: text(DEPTH_LIMITS.declineReason).nullish() }),
  response: { 200: portalRecord },
})

const linkPage = output({ offered: z.boolean(), kinds: z.array(kind), repairs: z.array(customerListItem), photos: output({ max: z.number().int(), damage: z.number().int() }) })
export const linkPageContract = defineContract({ response: { 200: linkPage } })
export const linkSubmitContract = defineContract({
  body: input({ ...requestBody, typedName: text(120).nullish() }),
  response: { 201: linkPage.extend({ link: output({ expiresAt: at, usesLeft: z.number().int(), live: z.boolean() }), sent }) },
})
export const linkRecordContract = defineContract({ params: repairParams, response: { 200: output({ repair: customerRepair }) } })
export const linkPhotoContract = defineContract({ body: input({ ...photoBody, repairId: id() }), response: { 201: uploadAnswer } })
export const linkPhotoDoneContract = defineContract({ params: fileParams, response: { 200: output({ file: fileAnswer }) } })
export const linkOpenFileContract = defineContract({ params: fileParams, body: openBody, response: { 200: openAnswer } })
