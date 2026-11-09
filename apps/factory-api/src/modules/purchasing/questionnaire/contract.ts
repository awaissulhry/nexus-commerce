import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ANSWER_LIMITS } from '@nexus/factory-domain/purchasing/questionnaire/answers'
import { DOCUMENT_CATEGORIES, QUESTIONNAIRE_LIMITS, SITE_STEPS } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import { questionSchema } from '@nexus/factory-domain/purchasing/questionnaire/schema'
import { ANSWER_STATES, LINK_STATES, REVIEW_DECISIONS, REVIEW_LIMITS } from '@nexus/factory-domain/purchasing/questionnaire/rules'

/**
 * The supplier questionnaire (B-W2b-172; SCM-023; design links.onboard, purchasing.suppliers "Links › Supplier
 * questionnaire — Onboarding"). Nothing here is money. Questions carry their words in Italian and English (the page shows
 * the reader's); the API's refusals are English sentences with a stable code and the field's path (the screens speak their
 * own words from those).
 */

const version = () => z.number().int().min(1)
const language = input({ language: z.enum(['it', 'en']).optional() })

export const questionView = questionSchema

export const versionView = output({
  id: id(),
  companyId: id(),
  revision: z.number().int(),
  title: z.string(),
  questions: z.array(questionView),
  published: z.boolean(),
  publishedAt: instant().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})

const site = output({ name: z.string(), country: z.string(), town: z.string().nullish(), steps: z.array(z.enum(SITE_STEPS)) })
const siteInput = input({
  name: z.string().max(ANSWER_LIMITS.siteName),
  country: z.string().max(2),
  town: z.string().max(ANSWER_LIMITS.town).nullish(),
  steps: z.array(z.enum(SITE_STEPS)).max(SITE_STEPS.length),
})
const entry = output({ value: z.unknown().optional(), explain: z.string().nullish() })
const entryInput = input({ value: z.unknown().optional(), explain: z.string().max(ANSWER_LIMITS.explain).nullish() })

// ---- the office: versions -------------------------------------------------------------------------------------------------

const versionParams = input({ questionnaireId: id() })

export const listVersionsContract = defineContract({
  response: { 200: output({ companyId: id(), versions: z.array(versionView), may: output({ manage: z.boolean() }) }) },
})

export const createVersionContract = defineContract({
  body: input({
    /** STARTER: the starter set; LATEST: a copy of the newest version. Or the questions themselves. */
    from: z.enum(['STARTER', 'LATEST']).optional(),
    title: z.string().trim().min(1).max(QUESTIONNAIRE_LIMITS.title).optional(),
    questions: z.array(z.unknown()).max(QUESTIONNAIRE_LIMITS.questions).optional(),
  }),
  response: { 201: output({ version: versionView }) },
})

export const updateVersionContract = defineContract({
  params: versionParams,
  body: input({ title: z.string().trim().min(1).max(QUESTIONNAIRE_LIMITS.title).optional(), questions: z.array(z.unknown()).max(QUESTIONNAIRE_LIMITS.questions).optional(), version: version() }),
  response: { 200: output({ version: versionView }) },
})

export const publishVersionContract = defineContract({
  params: versionParams,
  body: input({ version: version() }),
  response: { 200: output({ version: versionView }) },
})

// ---- the office: a supplier's questionnaire, the link, the review --------------------------------------------------------

const partyParams = input({ partyId: id() })

const documentView = output({
  key: z.string(),
  fileId: id(),
  name: z.string(),
  contentType: z.string(),
  status: z.string(),
  category: z.enum(DOCUMENT_CATEGORIES),
  issuer: z.string().nullable(),
  number: z.string().nullable(),
  issuedOn: businessDate().nullable(),
  expiresOn: businessDate().nullable(),
  /** Tagged with its kind and expiry (the answer was accepted): it counts for the required documents. */
  inForce: z.boolean(),
})

const answerView = output({
  id: id(),
  questionnaireId: id(),
  revision: z.number().int(),
  state: z.enum(ANSWER_STATES),
  via: z.enum(['LINK', 'PORTAL']),
  linkId: id().nullable(),
  submittedAt: instant(),
  signedName: z.string(),
  signedRole: z.string().nullable(),
  answers: z.record(z.string(), entry),
  sites: z.array(site),
  subTierSites: z.array(site),
  documents: z.array(documentView),
  pdf: output({ fileId: id(), name: z.string() }).nullable(),
  review: output({ at: instant(), byName: z.string().nullable(), note: z.string().nullable() }).nullable(),
  task: output({ id: id(), open: z.boolean(), assigneeName: z.string().nullable(), dueDate: businessDate().nullable() }).nullable(),
  version: z.number().int(),
})

const linkView = output({
  id: id(),
  state: z.enum(LINK_STATES),
  email: z.string().nullable(),
  note: z.string().nullable(),
  sentAt: instant(),
  sentByName: z.string().nullable(),
  expiresAt: instant(),
  answerId: id().nullable(),
})

export const supplierQuestionnaireContract = defineContract({
  params: partyParams,
  response: {
    200: output({
      party: output({ id: id(), code: z.string(), name: z.string(), language: z.string() }),
      companyId: id(),
      current: versionView.nullable(),
      draft: output({ id: id(), revision: z.number().int() }).nullable(),
      versions: z.array(versionView),
      links: z.array(linkView),
      answers: z.array(answerView),
      contacts: z.array(output({ id: id(), name: z.string(), email: z.string(), language: z.string().nullable() })),
      may: output({ send: z.boolean(), review: z.boolean(), manage: z.boolean() }),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})

export const sendLinkContract = defineContract({
  params: partyParams,
  body: input({
    contactId: id().optional(),
    email: z.string().trim().max(254).optional(),
    send: z.boolean(),
    language: z.enum(['it', 'en']).optional(),
    expiresInDays: z.number().int().min(1).max(60).optional(),
    note: z.string().trim().max(REVIEW_LIMITS.mailNote).optional(),
  }),
  response: {
    201: output({
      link: output({ id: id(), expiresAt: instant(), email: z.string().nullable(), withdrawn: z.number().int() }),
      /** The address to pass on, once (only without `send`). */
      url: z.string().nullable(),
      delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable(),
    }),
  },
})

export const reviewContract = defineContract({
  params: input({ responseId: id() }),
  body: input({
    decision: z.enum(REVIEW_DECISIONS),
    note: z.string().max(REVIEW_LIMITS.note).nullish(),
    questions: z.string().max(REVIEW_LIMITS.questions).nullish(),
    version: version(),
  }),
  response: { 200: output({ id: id(), state: z.enum(ANSWER_STATES), documents: z.number().int(), messageId: id().nullable() }) },
})

// ---- the link (SUPPLIER_ONBOARD) --------------------------------------------------------------------------------------------

const uploadedView = output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string() })

export const linkPage = output({
  sender: output({ companyName: z.string() }),
  reviewer: output({ name: z.string() }).nullable(),
  note: z.string().nullable(),
  supplier: output({ code: z.string(), legalName: z.string(), vatNumber: z.string().nullable(), address: z.string().nullable(), website: z.string().nullable() }),
  questionnaire: output({ id: id(), revision: z.number().int(), title: z.string(), questions: z.array(questionView), hasCode: z.boolean() }),
  uploaded: z.array(uploadedView),
  link: output({ expiresAt: instant(), usesLeft: z.number().int() }),
  locale: z.enum(['it', 'en']),
})

export const linkPageContract = defineContract({ querystring: language, response: { 200: linkPage } })

export const linkSubmitContract = defineContract({
  querystring: language,
  body: input({
    questionnaireId: id(),
    answers: z.record(z.string().max(100), entryInput),
    sites: z.array(siteInput).max(ANSWER_LIMITS.sites),
    subTierSites: z.array(siteInput).max(ANSWER_LIMITS.sites),
    signedName: z.string().max(ANSWER_LIMITS.signer),
    signedRole: z.string().max(ANSWER_LIMITS.role),
    truthful: z.boolean(),
  }),
  response: {
    200: output({
      sent: output({ id: id(), revision: z.number().int(), submittedAt: instant(), documents: z.number().int() }),
      reviewer: output({ name: z.string() }).nullable(),
      sender: output({ companyName: z.string() }),
    }),
  },
})

export const vatCheckContract = defineContract({
  body: input({ vatNumber: z.string().trim().min(1).max(40), legalName: z.string().trim().max(200).optional() }),
  response: {
    200: output({
      /** VALID / INVALID: VIES's answer; ERROR: VIES did not answer; NOT_CHECKED: an Italian or non-EU number (its shape only); FORMAT: its shape is wrong. */
      result: z.enum(['VALID', 'INVALID', 'ERROR', 'NOT_CHECKED', 'FORMAT']),
      /** Compared with the legal name given: does VIES's name match it? null when VIES gave none. */
      nameMatches: z.boolean().nullable(),
      vatNumber: z.string(),
    }),
  },
})

export const linkUploadContract = defineContract({
  body: input({ questionKey: z.string().max(100), originalName: z.string().trim().min(1).max(200), contentType: z.string().max(100), sizeBytes: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  response: {
    201: output({
      file: uploadedView,
      upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})

export const linkUploadDoneContract = defineContract({ params: input({ fileId: id() }), response: { 200: output({ file: uploadedView }) } })

export const linkCodeContract = defineContract({ querystring: language, response: {} })
