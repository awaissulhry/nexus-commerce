import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { CASE_CHIPS, CASE_LIMITS, CASE_TYPES, MILESTONE_STEPS, OUTCOMES_WANTED } from '@nexus/factory-domain/sales/portal-returns/rules'
import { RETURN_LIMITS } from '@nexus/factory-domain/sales/returns/rules'
import { complaintView } from '../../quality/complaints/contract'
import { returnView } from '../returns/contract'

/**
 * Returns and complaints from outside (B-W2b-192; SAL-334, SAL-424; CO5:01, CO5:02): the portal's Returns & claims, the
 * claim link, the office's authorise / reject / claim link, the complaint answer published and the 8D shared. Every status,
 * step and outcome comes with its words in Italian and English (`words`); no internal note, triage, cost or office person.
 * The only money is a returnable item's price, marked price (the person's price grain decides).
 */

const words = output({ it: z.string(), en: z.string() })
const day = businessDate()
const at = instant()
const version = z.number().int().min(1)
const caseType = z.enum(CASE_TYPES)
const nextStep = output({ forYou: z.boolean(), code: z.string(), words })
const held = output({ allowed: z.boolean(), held: words.nullable() })
const codeWords = output({ code: z.string(), words })
const file = output({ id: id(), role: z.enum(['PHOTO', 'ANSWER_LETTER', 'EIGHT_D', 'DOCUMENT']), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), addedAt: at })
const document = file.extend({ version: z.number().int().nullable(), current: z.boolean() })
const numbered = output({ id: id(), number: z.string() })
const named = output({ code: z.string(), name: z.string() })
const language = input({ language: z.enum(DOCUMENT_LANGUAGES).optional() })
const returnParams = input({ returnId: id() })
const complaintParams = input({ complaintId: id() })
const fileParams = input({ fileId: id() })
const text = (max: number) => z.string().trim().max(max)

// ---- the cases ---------------------------------------------------------------------------------------------------------

const caseItem = output({
  type: caseType,
  id: id(),
  number: z.string(),
  yourRef: z.string().nullable(),
  opened: at,
  status: z.string(),
  state: z.string(),
  words,
  next: nextStep,
  open: z.boolean(),
  items: z.array(output({ description: z.string(), size: z.string().nullable(), serial: z.string().nullable(), pieces: z.number().int().nullable() })),
  lines: z.number().int(),
  pieces: z.number().int().nullable(),
  lastUpdate: at,
  chips: z.array(z.enum(['OPEN', 'WAITING', 'CLOSED'])),
})

export const casesContract = defineContract({
  querystring: input({ chip: z.enum(CASE_CHIPS).optional(), q: z.string().trim().max(80).optional() }),
  response: {
    200: output({
      chip: z.enum(CASE_CHIPS),
      chips: z.array(output({ chip: z.enum(CASE_CHIPS), count: z.number().int() })),
      items: z.array(caseItem),
      mayRequest: z.boolean(),
      readsComplaints: z.boolean(),
      seesPrices: notMoney(z.boolean()),
      asOf: at,
    }),
  },
})

const returnableItem = output({
  key: z.string(),
  invoiceLineId: id().nullable(),
  salesOrderLineId: id().nullable(),
  size: z.string().nullable(),
  description: z.string(),
  order: output({ id: id(), number: z.string(), lineSeq: z.number().int() }).nullable(),
  invoice: output({ id: id(), number: z.string().nullable(), issueDate: day.nullable() }).nullable(),
  style: named.nullable(),
  colourway: named.nullable(),
  ppe: z.boolean(),
  received: z.number().int(),
  canReturn: z.number().int(),
  deliveredOn: day.nullable(),
  windowWarning: z.string().nullable(),
  unitPrice: money.price(z.number()),
  currency: z.string().optional(),
})
const reason = output({ code: z.string(), words, needsNote: z.boolean() })
const outcome = output({ code: z.enum(OUTCOMES_WANTED), words })

export const returnableContract = defineContract({
  querystring: input({ salesOrderId: id().optional() }),
  response: { 200: output({ items: z.array(returnableItem), reasons: z.array(reason), outcomes: z.array(outcome), mayRequest: z.boolean(), mayUpload: z.boolean() }) },
})

// ---- a return -----------------------------------------------------------------------------------------------------------

const milestone = output({ step: z.enum(MILESTONE_STEPS), state: z.enum(['DONE', 'CURRENT', 'TODO', 'SKIPPED']), at: at.nullable(), words })

const returnRecord = output({
  type: z.literal('RETURN'),
  id: id(),
  number: z.string(),
  yourRef: z.string().nullable(),
  status: z.string(),
  state: z.string(),
  words,
  next: nextStep,
  version: z.number().int(),
  request: output({
    opened: at,
    via: z.enum(['PORTAL', 'LINK', 'OFFICE']),
    outcomeWanted: output({ code: z.enum(OUTCOMES_WANTED), words }).nullable(),
    note: z.string().nullable(),
    photos: z.array(file),
    lines: z.array(
      output({ id: id(), seq: z.number().int(), description: z.string(), size: z.string().nullable(), serial: z.string().nullable(), pieces: z.number().int(), reason: codeWords, reasonNote: z.string().nullable(), photos: z.array(file) }),
    ),
  }),
  progress: output({
    milestones: z.array(milestone),
    decision: words.nullable(),
    goodsDueBy: day.nullable(),
    sendTo: z.string().nullable(),
    instructions: z.boolean(),
    parcels: z.array(output({ receivedAt: at, parcels: z.number().int(), carrier: z.string().nullable(), trackingNumber: z.string().nullable() })),
    inspection: z.array(output({ seq: z.number().int(), received: z.number().int(), grade: codeWords.nullable(), outcome: codeWords.nullable() })),
    /** Credit notes that credit the return (issued), for roles with the price grain; their PDF opens through the customer documents. */
    creditNotes: z.array(output({ id: id(), number: z.string().nullable(), issueDate: day.nullable(), pdfFileId: id().nullable() })),
    replacementOrder: numbered.nullable(),
  }),
  actions: output({ cancel: held, addPhotos: held }),
})

const sent = output({ number: z.string(), answerBy: day.nullable(), words })

const requestLine = input({
  invoiceLineId: id().nullish(),
  salesOrderLineId: id().nullish(),
  size: z.string().trim().max(20).nullish(),
  quantity: z.number().int().min(1).max(99_999),
  reasonCode: z.string().trim().min(1).max(40),
  reasonNote: text(CASE_LIMITS.reasonNote).nullish(),
  serial: text(CASE_LIMITS.serial).nullish(),
})
const requestBody = {
  lines: z.array(requestLine).min(1).max(CASE_LIMITS.lines),
  outcomeWanted: z.enum(OUTCOMES_WANTED).nullish(),
  customerRef: text(CASE_LIMITS.customerRef).nullish(),
  note: text(CASE_LIMITS.note).nullish(),
}

export const requestReturnContract = defineContract({ body: input(requestBody), response: { 201: output({ return: returnRecord, sent }) } })
export const returnContract = defineContract({ params: returnParams, response: { 200: output({ return: returnRecord }) } })
export const instructionsContract = defineContract({ params: returnParams, querystring: language, response: {} })
export const cancelReturnContract = defineContract({ params: returnParams, body: input({ version, reason: text(RETURN_LIMITS.statusReason - 40).nullish() }), response: { 200: output({ return: returnRecord }) } })

const photoBody = { originalName: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }
const fileAnswer = output({ id: id(), originalName: z.string(), sizeBytes: z.number().int(), status: z.string() })
const uploadAnswer = output({ file: fileAnswer, upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: at }) })

export const returnPhotoContract = defineContract({ params: returnParams, body: input({ ...photoBody, lineId: id().nullish() }), response: { 201: uploadAnswer } })
export const returnPhotoDoneContract = defineContract({ params: input({ returnId: id(), fileId: id() }), response: { 200: output({ file: fileAnswer }) } })

const openAnswer = output({
  file: output({ id: id(), name: z.string(), contentType: z.string() }),
  download: output({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: at }),
})
export const openFileContract = defineContract({ params: fileParams, body: input({ mode: z.enum(['download', 'preview']).default('download') }), response: { 200: openAnswer } })

// ---- a complaint --------------------------------------------------------------------------------------------------------

const complaintRecord = output({
  type: z.literal('COMPLAINT'),
  id: id(),
  number: z.string(),
  yourRef: z.string().nullable(),
  status: z.string(),
  state: z.string(),
  words,
  next: nextStep,
  version: z.number().int(),
  request: output({
    opened: at,
    via: z.string(),
    description: z.string(),
    item: output({ style: named.nullable(), size: z.string().nullable(), serial: z.string().nullable(), batchNumber: z.string().nullable() }),
    order: output({ id: id(), number: z.string(), yourRef: z.string().nullable() }).nullable(),
    shipment: numbered.nullable(),
    photos: z.array(file),
  }),
  progress: output({ answerBy: day.nullable(), answeredAt: at.nullable() }),
  /** The Quality role's (portal.complaints.view) and the claim link's that opened it: null for the others. */
  investigation: output({
    capa: output({ number: z.string(), type: z.enum(['CAPA', 'EIGHT_D']), stepReached: words.nullable() }).nullable(),
    steps: z.array(output({ stage: z.string(), state: z.enum(['DONE', 'CURRENT', 'TODO']), on: day.nullable(), words })).nullable(),
    answeredAt: at.nullable(),
    answeredVia: z.enum(['EMAIL', 'PORTAL']).nullable(),
    documents: z.array(document),
  }).nullable(),
  actions: output({ addPhotos: held }),
})

const complaintBody = {
  description: z.string().trim().min(1).max(CASE_LIMITS.description),
  salesOrderLineId: id().nullish(),
  size: z.string().trim().max(20).nullish(),
  serial: text(60).nullish(),
  batchNumber: text(60).nullish(),
  customerRef: text(80).nullish(),
}

export const reportComplaintContract = defineContract({ body: input({ ...complaintBody, shipmentId: id().nullish(), returnId: id().nullish() }), response: { 201: output({ complaint: complaintRecord, sent }) } })
export const complaintContract = defineContract({ params: complaintParams, response: { 200: output({ complaint: complaintRecord }) } })
export const complaintsContract = defineContract({
  response: {
    200: output({
      items: z.array(output({ id: id(), number: z.string(), yourRef: z.string().nullable(), subject: z.string(), opened: at, status: z.string(), words, stepReached: words.nullable(), answerDueOn: day.nullable(), answeredAt: at.nullable() })),
      asOf: at,
    }),
  },
})
export const complaintPhotoContract = defineContract({ params: complaintParams, body: input(photoBody), response: { 201: uploadAnswer } })
export const complaintPhotoDoneContract = defineContract({ params: input({ complaintId: id(), fileId: id() }), response: { 200: output({ file: fileAnswer }) } })

// ---- the claim link -----------------------------------------------------------------------------------------------------

const linkLanguage = input({ language: z.enum(['it', 'en']).optional() })
const linkPage = output({
  sender: output({ companyName: z.string() }),
  record: output({ type: z.string(), id: id(), label: z.string() }),
  types: z.array(caseType),
  items: z.array(returnableItem),
  reasons: z.array(reason),
  outcomes: z.array(outcome),
  cases: z.array(caseItem),
  complaints: z.array(complaintRecord),
  link: output({ expiresAt: at, usesLeft: z.number().int(), live: z.boolean() }),
  locale: z.enum(['it', 'en']),
})

export const linkClaimContract = defineContract({ querystring: linkLanguage, response: { 200: linkPage } })
export const submitClaimContract = defineContract({
  querystring: linkLanguage,
  body: input({
    type: caseType,
    typedName: z.string().trim().max(120).nullish(),
    lines: requestBody.lines.optional(),
    outcomeWanted: requestBody.outcomeWanted,
    customerRef: requestBody.customerRef,
    note: requestBody.note,
    description: complaintBody.description.optional(),
    salesOrderLineId: complaintBody.salesOrderLineId,
    size: complaintBody.size,
    serial: complaintBody.serial,
    batchNumber: complaintBody.batchNumber,
  }),
  response: { 201: linkPage.extend({ sent: sent.extend({ type: caseType, id: id() }) }) },
})
export const linkCaseContract = defineContract({ params: input({ caseType, caseId: id() }), response: { 200: output({ return: returnRecord.optional(), complaint: complaintRecord.optional() }) } })
export const linkPhotoContract = defineContract({ body: input({ ...photoBody, caseType, caseId: id(), lineId: id().nullish() }), response: { 201: uploadAnswer } })
export const linkPhotoDoneContract = defineContract({ params: fileParams, response: { 200: output({ file: fileAnswer }) } })
export const linkOpenFileContract = defineContract({ params: fileParams, body: input({ mode: z.enum(['download', 'preview']).default('download') }), response: { 200: openAnswer } })
export const linkInstructionsContract = defineContract({ params: returnParams, querystring: language, response: {} })
export const trackingClaimContract = defineContract({ response: { 201: output({ link: output({ id: id(), expiresAt: at }), url: z.string().nullable() }) } })

// ---- the office -----------------------------------------------------------------------------------------------------------

export const authoriseContract = defineContract({
  params: returnParams,
  body: input({ version, goodsDueBy: day.nullish() }),
  response: { 200: output({ return: returnView, registerEntries: z.array(output({ lineId: id(), seq: z.number().int(), entryId: id().nullable(), reference: z.string().nullable(), opened: z.boolean(), words: z.string() })) }) },
})
export const rejectContract = defineContract({ params: returnParams, body: input({ version, reason: z.string().trim().min(1).max(RETURN_LIMITS.statusReason) }), response: { 200: output({ return: returnView }) } })
export const claimLinkContract = defineContract({
  body: input({
    recordType: z.enum(['Shipment', 'SalesOrder']),
    recordId: id(),
    contactId: id().optional(),
    email: z.string().trim().max(254).optional(),
    send: z.boolean(),
    language: z.enum(['it', 'en']).optional(),
    expiresInDays: z.number().int().min(1).max(90).optional(),
  }),
  response: {
    201: output({
      link: output({ id: id(), purpose: z.literal('CLAIM'), recordType: z.string(), recordId: id(), expiresAt: at, email: z.string().nullable() }),
      /** The link's address, ONCE, when it was not mailed (to pass it on); never stored or logged. */
      url: z.string().nullable(),
      delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable(),
    }),
  },
})
export const publishAnswerContract = defineContract({
  params: complaintParams,
  body: input({ version }),
  response: { 200: output({ complaint: complaintView, document: output({ id: id(), version: z.number().int(), fileId: id() }) }) },
})
export const shareEightDContract = defineContract({
  params: complaintParams,
  body: input({ capaId: id().optional() }),
  response: { 200: output({ complaint: complaintView, shared: output({ fileId: id(), sourceFileId: id(), capaNumber: z.string(), version: z.number().int(), made: z.boolean() }) }) },
})
