import { z } from 'zod'
import { CERTIFICATE_STATUSES } from '@nexus/factory-domain/compliance/certificates/rules'
import { WINDOW_PHASES } from '@nexus/factory-domain/compliance/renewals/rules'
import { CHANGE_KINDS, REVIEW_STATUSES } from '@nexus/factory-domain/compliance/type-changes/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'

/**
 * Every call of a certificate's Renewals tab (SCR-051 `?tab=renewals`, B-W2a-66) and of the changes to an approved type
 * (the register's "Changes waiting" view, the style compliance tab), each answer checked against a local copy of the
 * API's contracts (apps/factory-api modules/compliance/renewals and type-changes). Unknown fields are ignored. No money.
 * Every write sends the version it was made on and an idempotency key.
 */

const enc = encodeURIComponent
const key = () => ({ idempotencyKey: newIdempotencyKey() })
const status = z.enum(CERTIFICATE_STATUSES)

const certificateRef = z.object({ id: z.string(), number: z.string(), standard: z.string(), status, validFrom: z.string(), validTo: z.string() })
export type CertificateRef = z.infer<typeof certificateRef>

const stageSchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  daysBefore: z.number().int(),
  workingDays: z.boolean(),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  recipientRole: z.object({ id: z.string(), name: z.string() }).nullable(),
  fireOn: z.string(),
  timer: z.object({ id: z.string(), status: z.enum(['PENDING', 'FIRED', 'CANCELLED']), fireAt: z.string(), firedAt: z.string().nullable(), cancelReason: z.string().nullable() }).nullable(),
  alert: z.object({ id: z.string(), state: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']), raisedAt: z.string(), resolvedAt: z.string().nullable(), occurrence: z.number().int(), told: z.number().int() }).nullable(),
})
export type Stage = z.infer<typeof stageSchema>

export const renewalsSchema = z.object({
  today: z.string(),
  certificate: z.object({
    id: z.string(),
    number: z.string(),
    status,
    standard: z.string(),
    ppeClass: z.string().nullable(),
    companyId: z.string().nullable(),
    holderPartyId: z.string().nullable(),
    notifiedBodyName: z.string(),
    notifiedBodyNumber: z.string(),
    validFrom: z.string(),
    validTo: z.string(),
    daysToExpiry: z.number().int(),
    version: z.number().int(),
  }),
  window: z.object({ opens: z.string(), closes: z.string(), phase: z.enum(WINDOW_PHASES) }),
  stages: z.array(stageSchema),
  renewal: z
    .object({
      startedAt: z.string(),
      startedBy: z.string().nullable(),
      taskId: z.string().nullable(),
      task: z
        .object({
          id: z.string(),
          title: z.string(),
          status: z.enum(['OPEN', 'DONE', 'CANCELLED']),
          dueDate: z.string().nullable(),
          assignee: z.string().nullable(),
          checklist: z.array(z.object({ text: z.string(), done: z.boolean(), doneAt: z.string().nullable(), doneBy: z.string().nullable() })),
        })
        .nullable(),
      appliedOn: z.string().nullable(),
      reference: z.string().nullable(),
      note: z.string().nullable(),
      inWindow: z.boolean().nullable(),
    })
    .nullable(),
  successor: certificateRef.nullable(),
  renews: certificateRef.nullable(),
  candidates: z.array(certificateRef),
  carriedOver: z.array(z.object({ styleId: z.string(), code: z.string(), name: z.string(), covered: z.boolean() })).nullable(),
  nextStep: z.enum(['START', 'APPLY', 'LINK', 'RENEWED', 'NONE']),
  log: z.array(z.object({ at: z.string(), action: z.enum(['STARTED', 'APPLIED', 'RENEWED']), by: z.string().nullable(), detail: z.string().nullable() })),
})
export type Renewals = z.infer<typeof renewalsSchema>

const oneRenewals = z.object({ renewals: renewalsSchema })
const renewalsPath = (certificateId: string) => `/compliance/certificates/${enc(certificateId)}/renewals`

export function getRenewals(api: ApiClient, certificateId: string, signal?: AbortSignal): Promise<Renewals> {
  return api.get(renewalsPath(certificateId), { schema: oneRenewals, signal }).then((answer) => answer.renewals)
}

/** Start renewal: the task with the usual steps on the certificate (its words in `language`), for `assigneeId` (null: nobody yet). */
export function startRenewal(api: ApiClient, certificate: { id: string; version: number }, input: { assigneeId: string | null | undefined; language: 'it' | 'en' }): Promise<Renewals> {
  const body = { version: certificate.version, language: input.language, ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }) }
  return api.post(`${renewalsPath(certificate.id)}/start`, { body, schema: oneRenewals, ...key() }).then((answer) => answer.renewals)
}

/** The day the application for review went to the notified body (typed in; nothing is sent). */
export function recordApplication(api: ApiClient, certificate: { id: string; version: number }, input: { appliedOn: string; reference: string | null; note: string | null }): Promise<Renewals> {
  return api.post(`${renewalsPath(certificate.id)}/applied`, { body: { version: certificate.version, ...input }, schema: oneRenewals, ...key() }).then((answer) => answer.renewals)
}

/** The new, registered certificate linked as the renewal (set once). */
export function linkSuccessor(api: ApiClient, certificate: { id: string; version: number }, successorId: string): Promise<Renewals> {
  return api.post(`${renewalsPath(certificate.id)}/successor`, { body: { version: certificate.version, successorId }, schema: oneRenewals, ...key() }).then((answer) => answer.renewals)
}

// ---- changes to an approved type ---------------------------------------------------------------------------------------------

export const reviewStatus = z.enum(REVIEW_STATUSES)
export type ReviewStatus = z.infer<typeof reviewStatus>
export const changeSchema = z.object({ kind: z.enum(CHANGE_KINDS), what: z.string(), before: z.string(), after: z.string(), bomLineId: z.string().nullable() })
export type TypeChange = z.infer<typeof changeSchema>
const revisionRef = z.object({ id: z.string(), revision: z.number().int(), status: z.string() })

export const reviewSchema = z.object({
  id: z.string(),
  styleId: z.string(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable() }),
  revision: revisionRef,
  comparedRevision: revisionRef.nullable(),
  certificate: z.object({ id: z.string(), number: z.string(), standard: z.string(), status, notifiedBodyName: z.string(), notifiedBodyNumber: z.string() }),
  changes: z.array(changeSchema),
  status: reviewStatus,
  holdsLabel: z.boolean(),
  notifiedAt: z.string().nullable(),
  answeredOn: z.string().nullable(),
  answerReference: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  files: z.array(z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), createdAt: z.string() })),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Review = z.infer<typeof reviewSchema>

const reviewList = z.object({ reviews: z.array(reviewSchema), complete: z.boolean() })
const oneReview = z.object({ review: reviewSchema })
const reviewPath = (reviewId: string) => `/compliance/type-changes/${enc(reviewId)}`

/** `GET /compliance/type-changes`: a certificate's reviews, or every one still WAITING (the register's view), newest first. */
export function listReviews(api: ApiClient, query: { certificateId?: string; state?: 'ALL' | 'WAITING' | 'HOLDING' }, signal?: AbortSignal): Promise<{ reviews: Review[]; complete: boolean }> {
  return api.get('/compliance/type-changes', { query: { certificateId: query.certificateId, state: query.state }, schema: reviewList, signal })
}

export function notifyBody(api: ApiClient, review: Pick<Review, 'id' | 'version'>, note: string | null): Promise<Review> {
  return api.post(`${reviewPath(review.id)}/notify`, { body: { version: review.version, note }, schema: oneReview, ...key() }).then((answer) => answer.review)
}

export function decideNotNeeded(api: ApiClient, review: Pick<Review, 'id' | 'version'>, reason: string): Promise<Review> {
  return api.post(`${reviewPath(review.id)}/not-needed`, { body: { version: review.version, reason }, schema: oneReview, ...key() }).then((answer) => answer.review)
}

export interface AnswerInput {
  decision: 'APPROVED' | 'REFUSED'
  answeredOn: string
  reference: string | null
  note: string | null
}

export function recordAnswer(api: ApiClient, review: Pick<Review, 'id' | 'version'>, input: AnswerInput): Promise<Review> {
  return api.post(`${reviewPath(review.id)}/answer`, { body: { version: review.version, ...input }, schema: oneReview, ...key() }).then((answer) => answer.review)
}

const announced = z.object({ file: z.object({ id: z.string() }).passthrough(), upload: presignedSchema })

/** The notified body's answer (a PDF) on the review: announce with its SHA-256, send the bytes to the store, confirm. */
export async function uploadAnswer(api: ApiClient, reviewId: string, file: { name: string; contentType: string; size: number; bytes: ArrayBuffer }): Promise<Review> {
  const sha256 = await sha256Hex(file.bytes)
  const answer = await api.post(`${reviewPath(reviewId)}/answer-file`, { body: { originalName: file.name, contentType: file.contentType, sizeBytes: file.size, sha256 }, schema: announced, ...key() })
  await putToStore(answer.upload as Presigned, file.bytes)
  return api.post(`${reviewPath(reviewId)}/answer-file/${enc(answer.file.id)}/complete`, { schema: oneReview, ...key() }).then((done) => done.review)
}
