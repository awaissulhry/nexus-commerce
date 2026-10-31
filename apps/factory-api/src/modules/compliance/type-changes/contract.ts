import { z } from 'zod'
import { CERTIFICATE_STATUSES } from '@nexus/factory-domain/compliance/certificates/rules'
import { CHANGE_KINDS, NOTE_MAX, REFERENCE_MAX, REVIEW_STATUSES } from '@nexus/factory-domain/compliance/type-changes/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The changes to an approved type (B-W2a-66; PRD-285; Reg. (EU) 2016/425 Annex V 7.2). Days YYYY-MM-DD, instants UTC ISO.
 * No money; the person named is the office user who decided.
 */

const status = z.enum(REVIEW_STATUSES)
const version = () => z.number().int().min(1)

export const changeView = output({ kind: z.enum(CHANGE_KINDS), what: z.string(), before: z.string(), after: z.string(), bomLineId: id().nullable() })

const revisionRef = output({ id: id(), revision: z.number().int(), status: z.string() })
const certificateRef = output({ id: id(), number: z.string(), standard: z.string(), status: z.enum(CERTIFICATE_STATUSES), notifiedBodyName: z.string(), notifiedBodyNumber: z.string() })

export const reviewView = output({
  id: id(),
  styleId: id(),
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable() }),
  revision: revisionRef,
  comparedRevision: revisionRef.nullable(),
  certificate: certificateRef,
  changes: z.array(changeView),
  status,
  /** The revision's class label is held by this review (OPEN, NOTIFIED, REFUSED). */
  holdsLabel: z.boolean(),
  notifiedAt: instant().nullable(),
  answeredOn: businessDate().nullable(),
  answerReference: z.string().nullable(),
  decidedAt: instant().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  /** The notified body's answer files (available ones). */
  files: z.array(output({ id: id(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), createdAt: instant() })),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type ReviewView = z.infer<typeof reviewView>

export const listReviewsContract = defineContract({
  querystring: input({
    certificateId: id().optional(),
    styleId: id().optional(),
    revisionId: id().optional(),
    /** WAITING: OPEN or NOTIFIED; HOLDING: the ones that hold a class label. */
    state: z.enum(['ALL', 'WAITING', 'HOLDING']).default('ALL'),
  }),
  response: { 200: output({ reviews: z.array(reviewView), complete: z.boolean() }) },
})

const one = { 200: output({ review: reviewView }) }
const params = input({ reviewId: id() })

export const getReviewContract = defineContract({ params, response: one })

export const notifyContract = defineContract({ params, body: input({ version: version(), note: z.string().trim().max(NOTE_MAX).nullish() }), response: one })

export const notNeededContract = defineContract({ params, body: input({ version: version(), reason: z.string().trim().min(1).max(NOTE_MAX) }), response: one })

export const answerContract = defineContract({
  params,
  body: input({
    version: version(),
    decision: z.enum(['APPROVED', 'REFUSED']),
    /** The day of the notified body's answer. */
    answeredOn: businessDate(),
    /** Its reference (the addition's number). */
    reference: z.string().trim().max(REFERENCE_MAX).nullish(),
    note: z.string().trim().max(NOTE_MAX).nullish(),
  }),
  response: one,
})

export const announceAnswerContract = defineContract({
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

export const completeAnswerContract = defineContract({ params: input({ reviewId: id(), fileId: id() }), response: one })

/** The style compliance tab's "Changes that may need the notified body" (the revision in view, every covering certificate). */
export const styleChangesView = output({
  styleId: id(),
  revision: revisionRef.nullable(),
  certificates: z.array(
    output({
      certificate: certificateRef,
      /** The approved type it is compared with (null: the style's first release, nothing to compare). */
      comparedRevision: revisionRef.nullable(),
      /** What differs now (a draft: computed live; a released revision: its review's). */
      changes: z.array(changeView),
      /** The stored reviews of this revision and certificate. */
      reviews: z.array(reviewView),
      /** The class label of this revision is held for this certificate. */
      labelHeld: z.boolean(),
    }),
  ),
})
export type StyleChangesView = z.infer<typeof styleChangesView>

export const styleChangesContract = defineContract({
  params: input({ styleId: id() }),
  querystring: input({ revisionId: id().optional() }),
  response: { 200: output({ changes: styleChangesView }) },
})
