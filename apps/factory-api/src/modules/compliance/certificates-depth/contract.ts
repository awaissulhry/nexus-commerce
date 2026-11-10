import { z } from 'zod'
import { CERTIFICATE_STATUSES } from '@nexus/factory-domain/compliance/certificates/rules'
import { BODY_ADDRESS_MAX, BODY_EMAIL_MAX, BODY_NAME_MAX, BODY_NOTE_MAX, BODY_PHONE_MAX, BODY_SCOPE_MAX, BODY_SCOPES_MAX, BODY_URL_MAX, CERTIFICATE_KINDS } from '@nexus/factory-domain/compliance/certificates-depth/bodies'
import { ARTICLE_CODE_MAX } from '@nexus/factory-domain/compliance/certificates-depth/bought-in'
import { LEVEL_FAMILIES } from '@nexus/factory-domain/compliance/certificates-depth/levels'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Certificates in depth (B-W2b-255; PRD-282, PRD-286, PRD-287, PRD-290, QHS-106): the notified body directory, a
 * certificate's depth (its five-year check, its body from the directory with the scope check and NANDO, its performance
 * levels, its own-brand base, its bought-in parts' suppliers) and the incoming check of a bought-in part. Calendar days are
 * YYYY-MM-DD; no field carries money or a person's name.
 */

const version = () => z.number().int().min(1)
const status = z.enum(CERTIFICATE_STATUSES)
const kind = z.enum(CERTIFICATE_KINDS)
const span = output({ years: z.number().int(), months: z.number().int(), days: z.number().int() })

export const scopeCheckView = output({
  state: z.enum(['LISTED', 'NOT_LISTED', 'NO_SCOPES']),
  /** The recorded scope that answers it (LISTED). */
  scope: z.string().nullable(),
  kind,
})

export const bodyView = output({
  id: id(),
  number: z.string(),
  name: z.string(),
  address: z.string(),
  country: z.string(),
  nandoUrl: z.string().nullable(),
  scopes: z.array(z.string()),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  /** For protective clothing (the design's warning when the body is not listed for it). */
  clothing: scopeCheckView,
  /** Certificates the caller may see that name it (from the directory, or typed with its number). */
  certificates: z.number().int(),
  /** Certificates that link it from the directory: its number is fixed while any does. */
  linked: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type BodyView = z.infer<typeof bodyView>

export const certificateSummary = output({
  id: id(),
  number: z.string(),
  standard: z.string(),
  kind,
  ppeClass: z.string().nullable(),
  status,
  validFrom: businessDate(),
  validTo: businessDate(),
  companyId: id().nullable(),
  holderPartyId: id().nullable(),
  notifiedBodyNumber: z.string(),
})
export type CertificateSummary = z.infer<typeof certificateSummary>

// ---- the directory ----------------------------------------------------------------------------------------------------

export const listBodiesContract = defineContract({
  querystring: input({ status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional(), q: z.string().trim().max(100).optional() }),
  response: { 200: output({ bodies: z.array(bodyView), mayManage: z.boolean(), asOf: instant() }) },
})

const bodyParams = input({ bodyId: id() })
export const getBodyContract = defineContract({
  params: bodyParams,
  response: { 200: output({ body: bodyView, certificates: z.array(certificateSummary), mayManage: z.boolean() }) },
})

const nullableText = (max: number) => z.string().trim().max(max).nullish()
const bodyFields = {
  number: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).max(BODY_NAME_MAX),
  address: z.string().trim().min(1).max(BODY_ADDRESS_MAX),
  country: z.string().trim().min(2).max(2),
  nandoUrl: nullableText(BODY_URL_MAX),
  scopes: z.array(z.string().trim().max(BODY_SCOPE_MAX)).max(BODY_SCOPES_MAX),
  contactEmail: nullableText(BODY_EMAIL_MAX),
  contactPhone: nullableText(BODY_PHONE_MAX),
  note: nullableText(BODY_NOTE_MAX),
}

export const createBodyContract = defineContract({
  body: input({ ...bodyFields, scopes: bodyFields.scopes.optional() }),
  response: { 201: output({ body: bodyView }) },
})

export const editBodyContract = defineContract({
  params: bodyParams,
  body: input({
    version: version(),
    number: bodyFields.number.optional(),
    name: bodyFields.name.optional(),
    address: bodyFields.address.optional(),
    country: bodyFields.country.optional(),
    nandoUrl: bodyFields.nandoUrl,
    scopes: bodyFields.scopes.optional(),
    contactEmail: bodyFields.contactEmail,
    contactPhone: bodyFields.contactPhone,
    note: bodyFields.note,
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  }),
  response: { 200: output({ body: bodyView }) },
})

// ---- a certificate in depth -------------------------------------------------------------------------------------------

const levelProperty = output({ key: z.string(), values: z.array(z.string()), required: z.boolean(), zone: z.boolean() })
const problem = output({ path: z.string(), message: z.string() })

export const depthView = output({
  certificate: certificateSummary.extend({
    version: z.number().int(),
    notifiedBodyName: z.string(),
    /** Out of DRAFT: its body, levels and base are filled in once (from none) and never change after. */
    registered: z.boolean(),
  }),
  /** PRD-282: the five-year rule on its dates (Annex V 6.1). */
  validity: output({ state: z.enum(['OK', 'TOO_LONG', 'ORDER', 'INCOMPLETE']), span: span.nullable(), latest: businessDate().nullable(), over: span.nullable(), maxYears: z.number().int() }),
  /** PRD-286: the notified body. */
  body: output({
    /** As W1 typed it from the certificate. */
    typed: output({ name: z.string(), number: z.string() }),
    /** The directory's body it names (null: none picked yet). */
    directory: bodyView.nullable(),
    /** Active directory bodies with the typed number (what a registered certificate may still pick). */
    matching: z.array(bodyView),
    /** The directory body's scope check for this certificate's kind (null without a directory body). */
    scope: scopeCheckView.nullable(),
    /** Other certificates from the same body (linked, or typed with its number) the caller may see. */
    others: z.array(certificateSummary),
  }),
  /** PRD-290 (and EN 1621 zones): the performance levels. */
  levels: output({
    family: z.enum(LEVEL_FAMILIES).nullable(),
    properties: z.array(levelProperty),
    values: z.record(z.string(), z.string()).nullable(),
    /** EN 13594: the marking beside the pictogram ("2KP"). */
    marking: z.string().nullable(),
    /** The stored levels read against the vocabulary (empty: they hold). */
    problems: z.array(problem),
  }),
  /** PRD-287: own-brand (private label). */
  ownBrand: output({
    /** The holder is a party with the BRAND role (an own-brand certificate may rest on a base). */
    brandHeld: z.boolean(),
    base: certificateSummary.nullable(),
    /** Whether the base holds today. */
    standing: output({ state: z.enum(['HOLDS', 'NOT_REGISTERED', 'SUSPENDED', 'WITHDRAWN', 'EXPIRED', 'NOT_YET']), number: z.string(), validFrom: businessDate(), validTo: businessDate() }).nullable(),
    /** Days its last valid day passes the base's (from the base's end the gate refuses). */
    outlivesBaseDays: z.number().int(),
    sameStandard: z.boolean().nullable(),
    /** The brand certificates resting on this one (when it is the factory's). */
    restingOnThis: z.array(certificateSummary),
    /** What this brand-held certificate may rest on: the factory's certificates in force, the same standard first. */
    candidates: z.array(certificateSummary),
  }),
  /** QHS-106: the bought-in parts it covers, with their supplier and the supplier's article code. */
  boughtIn: z.array(
    output({
      coverageId: id(),
      version: z.number().int(),
      item: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
      supplier: output({ id: id(), name: z.string() }).nullable(),
      supplierArticleCode: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
  mayManage: z.boolean(),
  today: businessDate(),
})
export type DepthView = z.infer<typeof depthView>

const certificateParams = input({ certificateId: id() })
const depthAnswer = { 200: output({ depth: depthView }) }

export const getDepthContract = defineContract({ params: certificateParams, response: depthAnswer })

export const setBodyContract = defineContract({
  params: certificateParams,
  body: input({ version: version(), notifiedBodyId: id().nullable() }),
  response: depthAnswer,
})

export const setLevelsContract = defineContract({
  params: certificateParams,
  body: input({ version: version(), levels: z.record(z.string().trim().min(1).max(40), z.string().trim().max(20)).nullable() }),
  response: depthAnswer,
})

export const setBaseContract = defineContract({
  params: certificateParams,
  body: input({ version: version(), baseCertificateId: id().nullable() }),
  response: depthAnswer,
})

export const setSupplierContract = defineContract({
  params: input({ certificateId: id(), coverageId: id() }),
  /** The coverage's version as read. */
  body: input({ version: version(), supplierPartyId: id(), supplierArticleCode: z.string().trim().max(ARTICLE_CODE_MAX).nullish() }),
  response: depthAnswer,
})

// ---- the incoming check of a bought-in part ---------------------------------------------------------------------------

export const boughtInContract = defineContract({
  querystring: input({ itemId: id(), supplierPartyId: id().optional(), on: businessDate().optional() }),
  response: {
    200: output({
      item: output({ id: id(), code: z.string(), name: z.string() }),
      on: businessDate(),
      state: z.enum(['COVERED', 'COVERED_ANY_SUPPLIER', 'OTHER_SUPPLIER', 'NOT_VALID', 'NO_CERTIFICATE']),
      certificate: certificateSummary.nullable(),
      coverageId: id().nullable(),
      supplierArticleCode: z.string().nullable(),
      why: z.enum(['NOT_REGISTERED', 'SUSPENDED', 'WITHDRAWN', 'EXPIRED', 'NOT_YET']).nullable(),
      /** OTHER_SUPPLIER: the suppliers the part's certificates name. */
      otherSuppliers: z.array(output({ id: id(), name: z.string() })),
      /** The answer in words (English; a screen says its own per state). */
      message: z.string(),
    }),
  },
})
