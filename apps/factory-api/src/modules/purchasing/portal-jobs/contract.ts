import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { DATE_DECISIONS, DECLINE_REASONS, JOB_CHIPS, JOB_STATES, MAX_DDT_NUMBER, MAX_ENTRIES, MAX_NAME, MAX_PARCELS, MAX_PIECES, MAX_TEXT, NEXT_STEPS } from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import { KIT_LINE_STATUSES, SUBCONTRACT_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/subcontracting/rules'

/**
 * Subcontractor jobs (B-W2b-176; SCM-154 to SCM-157; design portal.supplier.jobs, links.job, purchasing.subcontracting ›
 * Kit). NOTHING here is money (Owner answer C2: no fee, price, cost or amount on any workshop screen; the partner role's
 * grants hold none, the routes no grain, the link's purpose none). Quantities are decimal strings in the kit line's unit,
 * dates calendar days, times UTC instants. Words come in the reader's language where the workshop reads a state.
 */

const version = () => z.number().int().min(1)
const text = (max: number) => z.string().trim().max(max)
const name = text(MAX_NAME).nullish()
const params = input({ subcontractOrderId: id() })
const live = output({ events: z.array(z.string()) })
const status = z.enum(SUBCONTRACT_ORDER_STATUSES)
const cell = { workOrderSizeId: id().nullable(), colourway: z.string(), size: z.string() }
const ref = output({ id: id(), code: z.string() })
const item = output({ code: z.string(), name: z.string() })

export const jobView = output({
  id: id(),
  number: z.string(),
  status,
  state: z.enum(JOB_STATES),
  stateWords: z.string(),
  chip: z.enum(JOB_CHIPS),
  nextStep: z.enum(NEXT_STEPS),
  nextStepWords: z.string(),
  from: output({ companyName: z.string() }),
  workOrder: output({ number: z.string(), style: item }),
  orderDate: businessDate(),
  expectedBackDate: businessDate().nullable(),
  issuedAt: instant().nullable(),
  note: z.string().nullable(),
  answer: output({
    acceptedAt: instant().nullable(),
    acceptedByName: z.string().nullable(),
    proposedDate: businessDate().nullable(),
    proposedDateReason: z.string().nullable(),
    declinedAt: instant().nullable(),
    declinedByName: z.string().nullable(),
    declineReason: z.string().nullable(),
    dateDecision: output({ decision: z.enum(DATE_DECISIONS), at: instant() }).nullable(),
  }),
  operations: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      code: z.string(),
      name: z.string(),
      pieces: z.number().int(),
      sizes: z.array(output({ ...cell, workOrderSizeId: id(), pieces: z.number().int(), finished: z.number().int() })),
      expectedBackDate: businessDate().nullable(),
      piecesSent: z.number().int(),
      back: output({ good: z.number().int(), defective: z.number().int(), scrapped: z.number().int() }),
      finished: z.number().int(),
      announced: z.number().int(),
      /** Finished at the workshop and not on its way back yet. */
      ready: z.number().int(),
      /** At the workshop and not announced yet: what a send-back may still list. */
      announceable: z.number().int(),
      note: z.string().nullable(),
    }),
  ),
  bundles: z.array(output({ id: id(), code: z.string(), ...cell, quantity: z.number().int(), sentAt: instant() })),
  kit: output({
    sentOn: z.array(businessDate()),
    toConfirm: z.number().int(),
    lines: z.array(
      output({
        id: id(),
        seq: z.number().int(),
        item,
        colour: z.string().nullable(),
        lot: z.string().nullable(),
        hide: z.string().nullable(),
        quantity: z.string(),
        uom: z.enum(UOMS),
        status: z.enum(KIT_LINE_STATUSES),
        sentAt: instant().nullable(),
        ddt: output({ number: z.string(), date: businessDate().nullable() }).nullable(),
        /** What the workshop said it received (null: not checked yet). */
        check: output({ at: instant(), quantity: z.string(), note: z.string().nullable(), short: z.boolean() }).nullable(),
        photos: z.array(output({ id: id(), originalName: z.string(), createdAt: instant() })),
      }),
    ),
  }),
  finishBy: businessDate().nullable(),
  reports: z.array(
    output({
      id: id(),
      at: instant(),
      operationId: id(),
      operationSeq: z.number().int(),
      ...cell,
      bundle: ref.nullable(),
      finished: z.number().int(),
      finishBy: businessDate().nullable(),
      byName: z.string(),
      /** Entered by our office for the workshop. */
      byOffice: z.boolean(),
      note: z.string().nullable(),
    }),
  ),
  returns: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      status: z.enum(['ANNOUNCED', 'RECEIVED', 'CANCELLED']),
      expectedDate: businessDate(),
      parcels: z.number().int(),
      weCollect: z.boolean(),
      ddt: output({ number: z.string(), date: businessDate().nullable() }).nullable(),
      pieces: z.number().int(),
      quantities: z.array(output({ operationId: id(), operationSeq: z.number().int(), ...cell, bundle: ref.nullable(), finished: z.number().int(), scrapped: z.number().int(), reasonCode: z.string().nullable() })),
      materialBack: z.array(output({ kitLineId: id(), seq: z.number().int(), item, quantity: z.string(), uom: z.enum(UOMS).nullable() })),
      byName: z.string(),
      byOffice: z.boolean(),
      note: z.string().nullable(),
      announcedAt: instant(),
      receivedAt: instant().nullable(),
      cancelledAt: instant().nullable(),
      cancelReason: z.string().nullable(),
      version: z.number().int(),
    }),
  ),
  /** Why each act is held, in the reader's words (null: it may be done). */
  acts: output({ accept: z.string().nullable(), decline: z.string().nullable(), kit: z.string().nullable(), progress: z.string().nullable(), sendBack: z.string().nullable() }),
  choices: output({ declineReasons: z.array(output({ code: z.enum(DECLINE_REASONS), words: z.string() })), scrapReasons: z.array(output({ code: z.string(), words: z.string() })) }),
  version: z.number().int(),
})

const mayAct = output({ approve: z.boolean(), comment: z.boolean(), upload: z.boolean() })
const portalAnswer = output({ job: jobView, mayAct, live, done: z.string().optional() })

// ---- the bodies -----------------------------------------------------------------------------------------------------------

const acceptBody = { proposedDate: businessDate().nullish(), reason: text(MAX_TEXT).nullish(), name }
const declineBody = { reason: z.enum(DECLINE_REASONS), note: text(MAX_TEXT).nullish(), name }
const kitBody = {
  all: z.boolean().optional(),
  lines: z.array(input({ kitLineId: id(), quantity: quantity(), note: text(MAX_TEXT).nullish() })).max(MAX_ENTRIES).optional(),
}
const pieces = () => z.number().int().min(0).max(MAX_PIECES)
const progressBody = {
  entries: z.array(input({ operationId: id(), workOrderSizeId: id().nullish(), bundleId: id().nullish(), finished: pieces() })).min(1).max(MAX_ENTRIES),
  finishBy: businessDate().nullish(),
  note: text(MAX_TEXT).nullish(),
  name,
}
const returnBody = {
  quantities: z
    .array(input({ operationId: id(), bundleId: id().nullish(), workOrderSizeId: id().nullish(), finished: pieces(), scrapped: pieces().optional(), reasonCode: z.string().trim().max(40).nullish() }))
    .min(1)
    .max(MAX_ENTRIES),
  materialBack: z.array(input({ kitLineId: id(), quantity: quantity() })).max(MAX_ENTRIES).optional(),
  parcels: z.number().int().min(1).max(MAX_PARCELS),
  expectedDate: businessDate(),
  weCollect: z.boolean().optional(),
  ddt: input({ number: z.string().trim().min(1).max(MAX_DDT_NUMBER), date: businessDate().nullish() }).nullish(),
  note: text(MAX_TEXT).nullish(),
  name,
}

// ---- the portal -------------------------------------------------------------------------------------------------------------

export const portalJobsContract = defineContract({
  querystring: input({ chip: z.enum(JOB_CHIPS).optional(), q: z.string().trim().max(100).optional() }),
  response: {
    200: output({
      asOf: instant(),
      chip: z.enum(JOB_CHIPS),
      chips: z.array(output({ chip: z.enum(JOB_CHIPS), count: z.number().int(), words: z.string() })),
      counts: output({ toAccept: z.number().int(), kitToConfirm: z.number().int(), readyToSendBack: z.number().int(), late: z.number().int() }),
      items: z.array(
        output({
          id: id(),
          number: z.string(),
          status,
          state: z.enum(JOB_STATES),
          stateWords: z.string(),
          chip: z.enum(JOB_CHIPS),
          nextStep: z.enum(NEXT_STEPS),
          nextStepWords: z.string(),
          operations: z.array(output({ seq: z.number().int(), code: z.string(), name: z.string() })),
          workOrder: output({ number: z.string(), style: item }),
          pieces: z.number().int(),
          finished: z.number().int(),
          kitDate: businessDate().nullable(),
          dueBack: businessDate().nullable(),
          late: z.boolean(),
          proposedDate: businessDate().nullable(),
          version: z.number().int(),
        }),
      ),
      complete: z.boolean(),
      live,
    }),
  },
})

export const portalJobContract = defineContract({ params, response: { 200: portalAnswer } })
export const portalAcceptContract = defineContract({ params, body: input({ version: version(), ...acceptBody }), response: { 200: portalAnswer } })
export const portalDeclineContract = defineContract({ params, body: input({ version: version(), ...declineBody }), response: { 200: portalAnswer } })
export const portalKitContract = defineContract({ params, body: input({ version: version(), ...kitBody }), response: { 200: portalAnswer } })
export const portalProgressContract = defineContract({ params, body: input({ version: version(), ...progressBody }), response: { 200: portalAnswer } })
export const portalReturnContract = defineContract({ params, body: input({ version: version(), ...returnBody }), response: { 200: portalAnswer } })

const fileAnswer = output({ id: id(), originalName: z.string(), sizeBytes: z.number().int(), status: z.string() })
export const portalPhotoContract = defineContract({
  params,
  body: input({ kitLineId: id(), originalName: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  response: { 201: output({ file: fileAnswer, upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) }) },
})
export const portalPhotoCompleteContract = defineContract({ params: input({ subcontractOrderId: id(), fileId: id() }), response: { 200: output({ file: fileAnswer }) } })

// ---- the office --------------------------------------------------------------------------------------------------------------

const prefill = output({
  returnNoticeId: id(),
  lines: z.array(output({ operationId: id(), bundleId: id().nullable(), good: z.number().int(), defective: z.number().int(), scrapped: z.number().int(), reason: z.string().nullable() })),
  supplierDdt: output({ number: z.string(), date: businessDate().nullable() }).nullable(),
  returns: z.array(output({ kitLineId: id(), itemId: id(), itemColourId: id().nullable(), lotId: id().nullable(), hideId: id().nullable(), quantity: z.string(), uom: z.enum(UOMS) })),
  note: z.string().nullable(),
})

export const workshopAnswer = output({
  job: jobView,
  links: z.array(output({ id: id(), email: z.string().nullable(), state: z.string(), expiresAt: instant(), usedAt: instant().nullable(), createdAt: instant() })),
  /** The receive back each ANNOUNCED send-back prefills (the office picks the places for the material). */
  prefills: z.array(prefill),
  reach: output({ contacts: z.array(output({ id: id(), name: z.string(), email: z.string(), language: z.string().nullable() })), portalOn: z.boolean(), portalPeople: z.number().int() }),
  office: output({ manage: z.boolean(), receive: z.boolean(), decideDate: z.string().nullable(), sendLink: z.string().nullable() }),
})

const orderParams = input({ subcontractOrderId: id() })
export const workshopContract = defineContract({ params: orderParams, response: { 200: workshopAnswer } })
export const officeAcceptContract = defineContract({ params: orderParams, body: input({ version: version(), ...acceptBody }), response: { 200: workshopAnswer } })
export const officeDeclineContract = defineContract({ params: orderParams, body: input({ version: version(), ...declineBody }), response: { 200: workshopAnswer } })
export const officeKitContract = defineContract({ params: orderParams, body: input({ version: version(), ...kitBody }), response: { 200: workshopAnswer } })
export const officeProgressContract = defineContract({ params: orderParams, body: input({ version: version(), ...progressBody }), response: { 200: workshopAnswer } })
export const officeReturnContract = defineContract({ params: orderParams, body: input({ version: version(), ...returnBody }), response: { 200: workshopAnswer } })
export const officeDateContract = defineContract({ params: orderParams, body: input({ version: version(), decision: z.enum(DATE_DECISIONS) }), response: { 200: workshopAnswer } })
export const officeCancelReturnContract = defineContract({
  params: input({ subcontractOrderId: id(), returnNoticeId: id() }),
  body: input({ version: version(), reason: z.string().trim().min(1).max(MAX_TEXT) }),
  response: { 200: workshopAnswer },
})
export const jobLinkContract = defineContract({
  params: orderParams,
  body: input({ contactId: id().optional(), email: z.string().trim().max(254).optional(), send: z.boolean(), language: z.enum(['it', 'en']).optional(), expiresInDays: z.number().int().min(1).max(30).optional() }),
  response: {
    201: workshopAnswer.extend({
      /** The link's address, ONCE, when it was not mailed (to pass it on); never stored or logged. */
      url: z.string().nullable(),
      delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable(),
    }),
  },
})

// ---- the link -------------------------------------------------------------------------------------------------------------------

const language = input({ language: z.enum(['it', 'en']).optional() })
const linkPage = output({
  job: output({
    id: id(),
    number: z.string(),
    state: z.enum(JOB_STATES),
    stateWords: z.string(),
    from: output({ companyName: z.string() }),
    workOrder: output({ number: z.string(), style: item }),
    orderDate: businessDate(),
    expectedBackDate: businessDate().nullable(),
    note: z.string().nullable(),
    answer: jobView.shape.answer,
    operations: z.array(output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string(), pieces: z.number().int(), sizes: z.array(output({ ...cell, workOrderSizeId: id(), pieces: z.number().int() })), expectedBackDate: businessDate().nullable(), note: z.string().nullable() })),
    kit: output({ sentOn: z.array(businessDate()), lines: z.array(output({ seq: z.number().int(), item, colour: z.string().nullable(), quantity: z.string(), uom: z.enum(UOMS), status: z.enum(KIT_LINE_STATUSES), ddt: output({ number: z.string(), date: businessDate().nullable() }).nullable() })) }),
    acts: output({ accept: z.string().nullable(), decline: z.string().nullable(), moveDate: z.string().nullable() }),
    choices: output({ declineReasons: z.array(output({ code: z.enum(DECLINE_REASONS), words: z.string() })) }),
    version: z.number().int(),
  }),
  link: output({ expiresAt: instant(), usesLeft: z.number().int(), live: z.boolean() }),
  portalOn: z.boolean(),
  locale: z.enum(['it', 'en']),
  done: z.string().optional(),
})
const typedName = z.string().trim().max(MAX_NAME).nullish()
export const linkJobContract = defineContract({ querystring: language, response: { 200: linkPage } })
export const linkAcceptContract = defineContract({ querystring: language, body: input({ version: version(), typedName }), response: { 200: linkPage } })
export const linkMoveDateContract = defineContract({ querystring: language, body: input({ version: version(), typedName, proposedDate: businessDate(), reason: z.string().trim().min(1).max(MAX_TEXT) }), response: { 200: linkPage } })
export const linkDeclineContract = defineContract({ querystring: language, body: input({ version: version(), typedName, reason: z.enum(DECLINE_REASONS), note: text(MAX_TEXT).nullish() }), response: { 200: linkPage } })
