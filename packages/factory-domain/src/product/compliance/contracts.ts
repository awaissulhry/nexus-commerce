import { z } from 'zod'
import { GATE_REASON_CODES, PPE_CATEGORIES } from '../../compliance/cert-gate/gate'
import { CERTIFICATE_STATUSES } from '../../compliance/certificates/rules'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { REVISION_STATUSES } from '../styles/revisions'
import { PRODUCT_TYPES, STYLE_STATUSES } from '../styles/rules'
import { BLOCKED_STEPS, CELL_STATUSES, COMPLIANCE_CHECK_STATES, COMPLIANCE_CHECKS, DOCUMENT_KINDS, DOCUMENT_STATES, DOCUMENT_STATUSES } from './rules'

/**
 * The style compliance tab's contracts (B-W1-20; A2 SCR-045 "Style › Compliance"): what apps/factory-api's
 * modules/product/compliance answers and accepts. No money here. The files themselves never pass through the API: an
 * upload is announced, sent to the store with the presigned request in the answer, then confirmed.
 */

const text = (max: number) => z.string().trim().min(1).max(max)

// ---- the view ----------------------------------------------------------------------------------------------------------

const issue = output({ path: z.string(), message: z.string() })

export const classificationView = output({
  isPpe: z.boolean(),
  category: z.enum(PPE_CATEGORIES),
  standard: z.string().nullable(),
  standardCode: z.string().nullable(),
  part: z.string().nullable(),
  edition: z.string().nullable(),
  ppeClass: z.string().nullable(),
  partClass: z.string().nullable(),
  certificateRequired: z.boolean(),
  documentsRequired: z.boolean(),
  legalMaker: z.enum(['BRAND', 'COMPANY']),
  message: z.string(),
})

const cellCertificate = output({
  id: id(),
  number: z.string(),
  standard: z.string(),
  ppeClass: z.string().nullable(),
  notifiedBodyNumber: z.string(),
  validFrom: businessDate(),
  validTo: businessDate(),
  status: z.enum(CERTIFICATE_STATUSES),
})

export const coverageCellView = output({
  colourwayId: id(),
  size: z.string(),
  label: z.string(),
  offered: z.boolean(),
  status: z.enum(CELL_STATUSES),
  certificate: cellCertificate.nullable(),
  coverageId: id().nullable(),
  daysToExpiry: z.number().int().nullable(),
  expiringSoon: z.boolean(),
  message: z.string(),
  reasons: z.array(output({ code: z.enum(GATE_REASON_CODES), message: z.string(), certificateId: id().optional(), point: z.string().optional() })),
})

/** One active coverage of the style with its certificate (the legend and its ValidityBar). */
export const styleCoverageView = output({
  coverageId: id(),
  colourwayIds: z.array(id()),
  sizes: z.array(z.string()),
  allowsMadeToMeasure: z.boolean(),
  certificate: cellCertificate.extend({ notifiedBodyName: z.string(), daysToExpiry: z.number().int() }),
})

export const documentFileView = output({
  id: id(),
  originalName: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  availableAt: instant(),
})

export const complianceDocumentView = output({
  id: id(),
  kind: z.enum(DOCUMENT_KINDS),
  language: z.string(),
  /** The style revision number it is for. */
  revision: z.number().int(),
  status: z.enum(DOCUMENT_STATUSES),
  number: z.string().nullable(),
  issuedAt: instant().nullable(),
  currentFile: documentFileView.nullable(),
  versions: z.number().int(),
  pendingUpload: z.boolean(),
})

export const languageStatusView = output({
  kind: z.enum(DOCUMENT_KINDS),
  language: z.string(),
  state: z.enum(DOCUMENT_STATES),
  revision: z.number().int().nullable(),
  document: complianceDocumentView.nullable(),
  pendingUpload: z.boolean(),
  message: z.string(),
})

export const complianceCheckView = output({
  code: z.enum(COMPLIANCE_CHECKS),
  state: z.enum(COMPLIANCE_CHECK_STATES),
  blocks: z.array(z.enum(BLOCKED_STEPS)),
  message: z.string(),
  problems: z.array(issue),
})

const labelTemplateView = output({ id: id(), code: z.string(), revision: z.number().int(), status: z.string(), languages: z.array(z.string()) })

export const styleComplianceView = output({
  style: output({
    id: id(),
    code: z.string(),
    name: z.string(),
    status: z.enum(STYLE_STATUSES),
    companyId: id().nullable(),
    productType: z.enum(PRODUCT_TYPES),
    brandPartyId: id().nullable(),
    mtmAllowed: z.boolean(),
  }),
  /** The business date the certificate gate was asked for (today unless asked). */
  date: businessDate(),
  classification: classificationView,
  /** The revision the tab shows: the asked one, else the released one, else the newest draft. */
  revision: output({
    id: id(),
    revision: z.number().int(),
    status: z.enum(REVISION_STATUSES),
    releasedAt: instant().nullable(),
    /** It is the style's released revision (the one new work orders use). */
    isReleased: z.boolean(),
    labelTemplate: labelTemplateView.nullable(),
  }).nullable(),
  releasedRevision: output({ id: id(), revision: z.number().int() }).nullable(),
  revisions: z.array(output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) })),
  coverage: output({
    required: z.boolean(),
    colourways: z.array(output({ id: id(), code: z.string(), name: z.string(), status: z.string() })),
    sizes: z.array(z.string()),
    cells: z.array(coverageCellView),
    counts: output({
      cells: z.number().int(),
      offered: z.number().int(),
      covered: z.number().int(),
      expiringSoon: z.number().int(),
      notCovered: z.number().int(),
      expired: z.number().int(),
      suspended: z.number().int(),
    }),
    certificates: z.array(styleCoverageView),
  }),
  documents: output({
    required: z.boolean(),
    /** The languages the revision's garment label prints (the documents' expected languages until W2b's market rules). */
    expectedLanguages: z.array(z.string()),
    declarations: z.array(languageStatusView),
    leaflets: z.array(languageStatusView),
    /** The maker a new DoC row names (Annex IX 2): the label's, else the brand's, else the company's; null when unknown. */
    maker: output({ makerPartyId: id().nullable(), makerName: z.string(), makerAddress: z.string() }).nullable(),
  }),
  /** Every check in a fixed order; `blockers` are the BLOCKED ones. */
  checks: z.array(complianceCheckView),
  blockers: z.array(complianceCheckView),
})
export type StyleComplianceView = z.infer<typeof styleComplianceView>

/** A document with every file version, newest first. */
export const documentFileVersionView = output({
  id: id(),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED']),
  quarantineReason: z.string().nullable(),
  availableAt: instant().nullable(),
  retainUntil: instant().nullable(),
  createdAt: instant(),
  /** The version in force: the newest confirmed file of an issued document. */
  current: z.boolean(),
})

export const complianceDocumentDetail = complianceDocumentView.extend({
  styleId: id(),
  companyId: id().nullable(),
  makerPartyId: id().nullable(),
  makerName: z.string(),
  makerAddress: z.string(),
  standards: z.array(z.string()),
  createdAt: instant(),
  files: z.array(documentFileVersionView),
})
export type ComplianceDocumentDetail = z.infer<typeof complianceDocumentDetail>

// ---- requests ---------------------------------------------------------------------------------------------------------

export const styleComplianceQuery = input({
  /** A revision of the style; default the released one (else the newest draft). */
  revisionId: id().optional(),
  /** The day the certificate gate is asked for; default today (Europe/Rome). */
  date: businessDate().optional(),
})

export const listDocumentsQuery = input({
  kind: z.enum(DOCUMENT_KINDS).optional(),
  language: z.string().trim().toLowerCase().length(2).optional(),
  revisionId: id().optional(),
})

/** Announce the upload of a signed DoC or a leaflet for one revision and language (a new version when one is on file). */
export const uploadDocumentBody = input({
  revisionId: id(),
  kind: z.enum(DOCUMENT_KINDS),
  /** ISO 639-1. */
  language: z.string().trim().toLowerCase().length(2, { message: 'Expected an ISO 639-1 language code (it, en, de…).' }),
  /** The reference printed on it (the DoC number), when it has one; fixed once the document is issued. */
  number: text(60).nullish(),
  originalName: z.string().min(1).max(500),
  /** application/pdf. */
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  /** SHA-256 of the content, 64 lower-case hex digits: the store refuses a body that does not match. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, { message: 'Expected the SHA-256 of the content, 64 lower-case hex digits.' }),
})
export type UploadDocumentBody = z.output<typeof uploadDocumentBody>
