import { z } from 'zod'
import { GATE_REASON_CODES } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { CERTIFICATE_STATUSES } from '@nexus/factory-domain/compliance/certificates/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The certificate register's contracts (QHS-103, QHS-051, PRD-288). Dates of validity are calendar days (YYYY-MM-DD);
 * `daysToExpiry` is counted from today's business date in Europe/Rome (0 on the last valid day, negative after it).
 * No field carries money.
 */

const status = z.enum(CERTIFICATE_STATUSES)
const version = () => z.number().int().min(1)
const reason = () => z.string().trim().min(1).max(500)
const MAX_DAYS = 5 * 366

export const coverageView = output({
  id: id(),
  certificateId: id(),
  styleId: id().nullable(),
  itemId: id().nullable(),
  /** The covered style or item, as the register lists it. */
  style: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  item: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  /** Empty: every colourway of the style. */
  colourwayIds: z.array(id()),
  /** Empty: the style's whole size range. */
  sizes: z.array(z.string()),
  allowsMadeToMeasure: z.boolean(),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type CoverageView = z.infer<typeof coverageView>

export const certificateView = output({
  id: id(),
  companyId: id().nullable(),
  holderPartyId: id().nullable(),
  standard: z.string(),
  ppeClass: z.string().nullable(),
  number: z.string(),
  notifiedBodyName: z.string(),
  notifiedBodyNumber: z.string(),
  modelReference: z.string().nullable(),
  validFrom: businessDate(),
  validTo: businessDate(),
  status,
  statusReason: z.string().nullable(),
  statusChangedAt: instant().nullable(),
  note: z.string().nullable(),
  /** Days from today to the last valid day: 0 on that day, negative once past it. */
  daysToExpiry: z.number().int(),
  /** The statuses it may move to next (before their conditions), for the screen's actions. */
  nextStatuses: z.array(status),
  /** Its active coverages. */
  coverageCount: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type CertificateView = z.infer<typeof certificateView>

export const certificateDetail = certificateView.extend({
  /** Every coverage, active ones first. */
  coverage: z.array(coverageView),
  /** The notified body's PDF is on the record (a CERTIFICATE file, application/pdf, available): it can be registered. */
  hasPdf: z.boolean(),
})
export type CertificateDetail = z.infer<typeof certificateDetail>

const one = { 200: output({ certificate: certificateDetail }) }
const params = input({ certificateId: id() })

export const listCertificatesContract = defineContract({
  querystring: input({
    status: status.optional(),
    /** VALID certificates whose last valid day is within this many days from today (0: today). */
    expiringWithinDays: z.coerce.number().int().min(0).max(MAX_DAYS).optional(),
    /** Certificates with an active coverage of this style, or of this item. */
    styleId: id().optional(),
    itemId: id().optional(),
  }),
  response: { 200: output({ certificates: z.array(certificateView), today: businessDate() }) },
})

export const getCertificateContract = defineContract({ params, response: one })

const fields = {
  /** The company that holds it; none when a brand holds it (holderPartyId). */
  companyId: id().nullish(),
  /** The brand (party) that holds it: with a brand label the brand is the legal maker (PLAN §2.8). */
  holderPartyId: id().nullish(),
  standard: z.string().trim().min(1).max(60),
  ppeClass: z.string().trim().max(10).nullish(),
  number: z.string().trim().min(1).max(80),
  notifiedBodyName: z.string().trim().min(1).max(200),
  notifiedBodyNumber: z.string().trim().min(1).max(10),
  modelReference: z.string().trim().max(120).nullish(),
  validFrom: businessDate(),
  validTo: businessDate(),
  note: z.string().trim().max(2000).nullish(),
}

export const createCertificateContract = defineContract({
  body: input(fields),
  response: { 201: output({ certificate: certificateDetail }) },
})

export const updateCertificateContract = defineContract({
  params,
  body: input({
    version: version(),
    companyId: fields.companyId,
    holderPartyId: fields.holderPartyId,
    standard: fields.standard.optional(),
    ppeClass: fields.ppeClass,
    number: fields.number.optional(),
    notifiedBodyName: fields.notifiedBodyName.optional(),
    notifiedBodyNumber: fields.notifiedBodyNumber.optional(),
    modelReference: fields.modelReference,
    validFrom: fields.validFrom.optional(),
    validTo: fields.validTo.optional(),
    note: fields.note,
  }),
  response: one,
})

export const issueCertificateContract = defineContract({ params, body: input({ version: version() }), response: one })
export const suspendCertificateContract = defineContract({ params, body: input({ version: version(), reason: reason() }), response: one })
export const withdrawCertificateContract = defineContract({ params, body: input({ version: version(), reason: reason() }), response: one })
export const reinstateCertificateContract = defineContract({ params, body: input({ version: version(), reason: reason().nullish() }), response: one })

export const addCoverageContract = defineContract({
  params,
  body: input({
    /** The certificate's version as read (edit-conflict guard); without it the stored one is used. */
    version: version().optional(),
    styleId: id().optional(),
    itemId: id().optional(),
    colourwayIds: z.array(id()).max(200).default([]),
    sizes: z.array(z.string().trim().min(1).max(20)).max(100).default([]),
    allowsMadeToMeasure: z.boolean().default(false),
    note: z.string().trim().max(500).nullish(),
  }),
  response: { 201: output({ coverage: coverageView, certificate: certificateDetail }) },
})

export const archiveCoverageContract = defineContract({
  params: input({ certificateId: id(), coverageId: id() }),
  body: input({ version: version(), reason: reason().nullish() }),
  response: { 200: output({ coverage: coverageView }) },
})

const gateCertificate = output({
  id: id(),
  number: z.string(),
  standard: z.string(),
  ppeClass: z.string().nullable(),
  notifiedBodyName: z.string(),
  notifiedBodyNumber: z.string(),
  validFrom: businessDate(),
  validTo: businessDate(),
})

export const gateContract = defineContract({
  body: input({
    styleId: id(),
    colourwayId: id(),
    /** A garment in a standard size … */
    size: z.string().trim().min(1).max(20).optional(),
    /** … or a made-to-measure unit for this rider's measurement profile. */
    measurementProfileId: id().optional(),
    /** The business date asked about; default today (Europe/Rome). */
    date: businessDate().optional(),
  }),
  response: {
    200: output({
      allowed: z.boolean(),
      outcome: z.enum(['covered', 'not_required', 'refused']),
      route: z.enum(['SIZE', 'MADE_TO_MEASURE']),
      date: businessDate(),
      styleId: id(),
      colourwayId: id(),
      size: z.string().nullable(),
      measurementProfileId: id().nullable(),
      /** The covering certificate (outcome covered). */
      certificate: gateCertificate.nullable(),
      coverageId: id().nullable(),
      /** Why no certificate is needed (outcome not_required). */
      message: z.string().nullable(),
      /** Every reason found (outcome refused). */
      reasons: z.array(output({ code: z.enum(GATE_REASON_CODES), message: z.string(), certificateId: id().optional(), point: z.string().optional() })),
    }),
  },
})

/** The notified body's PDF (pdf.ts): announced, sent to the store with the presigned request, then confirmed. */
export const announcePdfContract = defineContract({
  params,
  body: input({
    originalName: z.string().min(1).max(500),
    /** application/pdf. */
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    /** SHA-256 of the content, 64 lower-case hex digits. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/, { message: 'Expected the SHA-256 of the content, 64 lower-case hex digits.' }),
  }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})
export const completePdfContract = defineContract({
  params: input({ certificateId: id(), fileId: id() }),
  response: { 200: output({ certificate: certificateDetail, file: fileView }) },
})
