import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { CERTIFICATES_MANAGE, CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import {
  answerRefusal,
  approvedBaseOf,
  HOLDING_STATUSES,
  holdsLabel,
  labelHoldWords,
  openRefusal,
  readChanges,
  reasonRefusal,
  reviewMachine,
  WAITING_STATUSES,
  kindsOf,
  type DecisionRefusal,
  type ReviewStatus,
  type TypeChange,
} from '@nexus/factory-domain/compliance/type-changes/rules'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { completeUpload, requestUpload, retainFilesInCommand } from '../../../platform/files/files'
import { normaliseContentType } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { CERTIFICATE_SCOPE, certificateCommand, certificatesClock, dateColumn, dayOf, officeOf, pdfRetainUntil, PDF_RETENTION_YEARS, todayOf } from '../certificates/certificates'
import type { ReviewView, StyleChangesView } from './contract'
import { CERTIFICATE_REF, changesBetween, coveringCertificates, type CertificateRefRow } from './detect'

/**
 * The reviews of changes to an approved type (B-W2a-66; PRD-285; Reg. (EU) 2016/425 Annex V 7.2; the table
 * TypeChangeReview, its …_supply_w2a_guards trigger holds the moves and times):
 *
 *   GET  /compliance/type-changes                          the reviews (a certificate's, a style's, a revision's; WAITING or HOLDING)
 *   GET  /compliance/type-changes/:reviewId                one review with what changed and the answer's files
 *   POST /compliance/type-changes/:reviewId/notify         OPEN → NOTIFIED: the notified body was told (typed in; nothing is sent)
 *   POST /compliance/type-changes/:reviewId/not-needed     OPEN → NOT_NEEDED with the reason (the class label prints again)
 *   POST /compliance/type-changes/:reviewId/answer-file    the notified body's answer (a PDF) on the review: announce …
 *   POST …/answer-file/:fileId/complete                    … and confirm (only through these routes: platform/files/owned.ts)
 *   POST /compliance/type-changes/:reviewId/answer         NOTIFIED → APPROVED | REFUSED with the answer's day, reference
 *                                                          and file on record; the files kept 10 years after the certificate
 *   GET  /compliance/type-changes/styles/:styleId          the style compliance tab: per covering certificate what the
 *                                                          revision in view changes (a draft: computed now), its reviews
 *
 * A review belongs to its certificate's company and holder: compliance.certificates.view to read, .manage to decide.
 * `classLabelHoldFor(client, revisionId, certificateId)` is the label gate's question (compliance/labels preview.ts).
 */

type Reader = FactoryClient | CommandTx

/** The office context (the routes are office only: certificates' officeOf refuses any other audience). */
const officeContextOf = (caller: CommandCaller): OfficeContext => officeOf(caller) as OfficeContext
export const LIST_MAX = 500
const PDF = 'application/pdf'

/** A decision refused by its rule: 409 with `refusal/<CODE>`. */
export class DecisionRefusedError extends ConflictError {
  override name = 'DecisionRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: DecisionRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}
const refuse = (refusal: DecisionRefusal | null): void => {
  if (refusal) throw new DecisionRefusedError(refusal)
}

const REVISION_REF = { id: true, revision: true, status: true } as const satisfies Prisma.StyleRevisionSelect

export const REVIEW_SELECT = {
  id: true,
  styleId: true,
  revisionId: true,
  certificateId: true,
  comparedRevisionId: true,
  changes: true,
  status: true,
  notifiedAt: true,
  answeredAt: true,
  answerReference: true,
  decidedAt: true,
  decidedById: true,
  decisionNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  style: { select: { id: true, code: true, name: true, companyId: true } },
  revision: { select: REVISION_REF },
  comparedRevision: { select: REVISION_REF },
  certificate: { select: CERTIFICATE_REF },
} as const satisfies Prisma.TypeChangeReviewSelect
export type ReviewRow = Prisma.TypeChangeReviewGetPayload<{ select: typeof REVIEW_SELECT }>

const certificateScope = (certificate: Pick<CertificateRefRow, 'companyId' | 'holderPartyId'>) => ({ companyId: certificate.companyId, partyId: certificate.holderPartyId })
const certificateRef = (row: CertificateRefRow) => ({ id: row.id, number: row.number, standard: row.standard, status: row.status, notifiedBodyName: row.notifiedBodyName, notifiedBodyNumber: row.notifiedBodyNumber })
const answerFilesWhere = (reviewIds: readonly string[]) => ({ recordType: 'TypeChangeReview', recordId: { in: [...reviewIds] }, status: 'AVAILABLE' as const, contentType: PDF })

/** The reviews as the screens read them (names and answer files read once for all). */
export async function reviewViews(db: Reader, rows: readonly ReviewRow[]): Promise<ReviewView[]> {
  if (rows.length === 0) return []
  const deciders = [...new Set(rows.map((row) => row.decidedById).filter((id): id is string => id !== null))]
  const names = new Map(deciders.length ? (await db.user.findMany({ where: { id: { in: deciders } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]) : [])
  const files = await db.storedFile.findMany({ where: answerFilesWhere(rows.map((row) => row.id)), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, recordId: true, originalName: true, contentType: true, sizeBytes: true, createdAt: true } })
  return rows.map((row) => ({
    id: row.id,
    styleId: row.styleId,
    style: row.style,
    revision: row.revision,
    comparedRevision: row.comparedRevision,
    certificate: certificateRef(row.certificate),
    changes: readChanges(row.changes),
    status: row.status,
    holdsLabel: holdsLabel(row.status),
    notifiedAt: row.notifiedAt ? toUtcIso(row.notifiedAt) : null,
    answeredOn: row.answeredAt ? dayOf(row.answeredAt) : null,
    answerReference: row.answerReference,
    decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
    decidedBy: row.decidedById ? (names.get(row.decidedById) ?? null) : null,
    decisionNote: row.decisionNote,
    files: files.filter((file) => file.recordId === row.id).map((file) => ({ id: file.id, originalName: file.originalName, contentType: file.contentType, sizeBytes: Number(file.sizeBytes), createdAt: toUtcIso(file.createdAt) })),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }))
}

export interface ListQuery {
  readonly certificateId?: string | undefined
  readonly styleId?: string | undefined
  readonly revisionId?: string | undefined
  readonly state?: 'ALL' | 'WAITING' | 'HOLDING' | undefined
}

/** GET /compliance/type-changes: the reviews the person may see (their certificate's company and holder), newest first. */
export async function listReviews(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const state = query.state ?? 'ALL'
  const where: Prisma.TypeChangeReviewWhereInput = {
    certificate: scopeWhere(actorOf(context), CERTIFICATES_VIEW, CERTIFICATE_SCOPE) as Prisma.CertificateWhereInput,
    ...(query.certificateId ? { certificateId: query.certificateId } : {}),
    ...(query.styleId ? { styleId: query.styleId } : {}),
    ...(query.revisionId ? { revisionId: query.revisionId } : {}),
    ...(state === 'WAITING' ? { status: { in: [...WAITING_STATUSES] } } : state === 'HOLDING' ? { status: { in: [...HOLDING_STATUSES] } } : {}),
  }
  return caller.withClient(async (db) => {
    const rows = await db.typeChangeReview.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: LIST_MAX + 1, select: REVIEW_SELECT })
    return { reviews: await reviewViews(db, rows.slice(0, LIST_MAX)), complete: rows.length <= LIST_MAX }
  })
}

/** A review the person may see, or not found. */
async function readReview(db: Reader, actor: Actor, reviewId: string): Promise<ReviewRow> {
  const row = isUuid(reviewId) ? await db.typeChangeReview.findUnique({ where: { id: reviewId }, select: REVIEW_SELECT }) : null
  if (!row || !can(actor, CERTIFICATES_VIEW, certificateScope(row.certificate))) throw new NotFoundError('Review not found.')
  return row
}

/** GET /compliance/type-changes/:reviewId. */
export async function getReview(caller: CommandCaller, reviewId: string): Promise<{ review: ReviewView }> {
  const actor = actorOf(officeOf(caller))
  return caller.withClient(async (db) => ({ review: (await reviewViews(db, [await readReview(db, actor, reviewId)]))[0]! }))
}

/** The review for a decision: seen, managed, at the version the screen read. */
async function decidable(caller: CommandCaller, reviewId: string): Promise<ReviewRow> {
  const actor = actorOf(officeOf(caller))
  const row = await caller.withClient((db) => readReview(db, actor, reviewId))
  if (!can(actor, CERTIFICATES_MANAGE, certificateScope(row.certificate))) throw new ForbiddenError()
  return row
}

/** One decision in ONE command on the review (its version bump locks the row; then the move with its times). */
async function decide(
  caller: CommandCaller,
  reviewId: string,
  version: number,
  to: ReviewStatus,
  input: unknown,
  idempotencyKey: string | undefined,
  work: (tools: CommandTools, row: ReviewRow) => Promise<Prisma.TypeChangeReviewUpdateInput>,
): Promise<{ review: ReviewView }> {
  await decidable(caller, reviewId)
  await certificateCommand(caller, { name: `compliance.typeChanges.${to === 'NOT_NEEDED' ? 'notNeeded' : to === 'NOTIFIED' ? 'notify' : 'answer'}`, idempotencyKey, input, record: { type: 'TypeChangeReview', id: reviewId, expectedVersion: version } }, async (tools) => {
    const locked = await tools.tx.typeChangeReview.findUniqueOrThrow({ where: { id: reviewId }, select: REVIEW_SELECT })
    // The rule's own refusal first (in words, `refusal/<CODE>`), then the machine.
    const data = await work(tools, locked)
    assertTransition(reviewMachine, locked.status, to)
    await tools.tx.typeChangeReview.update({ where: { id: reviewId }, data: { ...data, status: to }, select: { id: true } })
    const after = { status: to, ...Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value instanceof Date ? toUtcIso(value) : value])) }
    tools.audit({ recordType: 'TypeChangeReview', recordId: reviewId, companyId: locked.certificate.companyId, before: { status: locked.status }, after })
    tools.emit({
      type: 'compliance.type_change_decided',
      subject: reviewId,
      companyId: locked.certificate.companyId,
      payload: { reviewId, styleId: locked.styleId, revisionId: locked.revisionId, revision: locked.revision.revision, certificateId: locked.certificateId, status: to, previousStatus: locked.status },
    })
    return after
  })
  return getReview(caller, reviewId)
}

/** POST …/notify: the notified body was told (OPEN → NOTIFIED). */
export function notifyBody(caller: CommandCaller, reviewId: string, body: { readonly version: number; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  return decide(caller, reviewId, body.version, 'NOTIFIED', { reviewId, ...body }, idempotencyKey, async (tools, row) => {
    refuse(openRefusal(row.status))
    return { notifiedAt: tools.now }
  })
}

/** POST …/not-needed: compliance decides the change does not touch the approved type (OPEN → NOT_NEEDED). */
export function notNeeded(caller: CommandCaller, reviewId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  return decide(caller, reviewId, body.version, 'NOT_NEEDED', { reviewId, ...body }, idempotencyKey, async (tools, row) => {
    refuse(openRefusal(row.status))
    refuse(reasonRefusal(body.reason))
    return { decidedAt: tools.now, decidedById: officeContextOf(caller).actorId, decisionNote: body.reason.trim() }
  })
}

export interface AnswerBody {
  readonly version: number
  readonly decision: 'APPROVED' | 'REFUSED'
  readonly answeredOn: BusinessDate
  readonly reference?: string | null | undefined
  readonly note?: string | null | undefined
}

/** POST …/answer: the notified body's answer (NOTIFIED → APPROVED | REFUSED), its file on record and kept. */
export function recordAnswer(caller: CommandCaller, reviewId: string, body: AnswerBody, idempotencyKey?: string) {
  return decide(caller, reviewId, body.version, body.decision, { reviewId, ...body }, idempotencyKey, async (tools, row) => {
    const files = await tools.tx.storedFile.findMany({ where: answerFilesWhere([reviewId]), select: { id: true } })
    const today = todayOf(certificatesClock())
    refuse(answerRefusal({ status: row.status, hasAnswerFile: files.length > 0, answeredOn: body.answeredOn, notifiedOn: row.notifiedAt ? businessDate(row.notifiedAt) : null, today }))
    const certificate = await tools.tx.certificate.findUniqueOrThrow({ where: { id: row.certificateId }, select: { validTo: true } })
    const validTo = dayOf(certificate.validTo)
    await retainFilesInCommand(tools, files.map((file) => file.id), pdfRetainUntil(validTo), `The notified body's answer to a change of the approved type is kept with the technical documentation, ${PDF_RETENTION_YEARS} years after the certificate's last valid day ${validTo} (Reg. (EU) 2016/425 art. 8(3)).`)
    return { answeredAt: dateColumn(body.answeredOn), answerReference: body.reference?.trim() || null, decidedAt: tools.now, decidedById: officeContextOf(caller).actorId, decisionNote: body.note?.trim() || null }
  })
}

// ---- the answer's file ---------------------------------------------------------------------------------------------------------

export interface AnswerUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

async function uploadable(caller: CommandCaller, reviewId: string): Promise<ReviewRow> {
  const row = await decidable(caller, reviewId)
  if (!can(actorOf(officeOf(caller)), FILES_UPLOAD, { companyId: row.certificate.companyId })) throw new ForbiddenError()
  if (row.status !== 'NOTIFIED') throw new DecisionRefusedError({ code: 'NOT_NOTIFIED', message: `The review is ${row.status}: the notified body's answer is filed once it was told, before the answer is recorded.` })
  return row
}

/** POST …/answer-file: announce the notified body's answer (a PDF) on the review. */
export async function announceAnswer(caller: CommandCaller, reviewId: string, body: AnswerUpload, idempotencyKey?: string) {
  const row = await uploadable(caller, reviewId)
  if (normaliseContentType(body.contentType) !== PDF) throw new ValidationError('The upload is not valid.', [{ path: 'body/contentType', message: "The notified body's answer is filed as a PDF (application/pdf)." }])
  return requestUpload(processFiles(), caller, { companyId: row.certificate.companyId, recordType: 'TypeChangeReview', recordId: reviewId, kind: 'DOCUMENT', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 }, idempotencyKey, { viaModule: true })
}

/** POST …/answer-file/:fileId/complete. */
export async function completeAnswer(caller: CommandCaller, reviewId: string, fileId: string, idempotencyKey?: string) {
  await uploadable(caller, reviewId)
  const known = isUuid(fileId) ? await caller.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType: 'TypeChangeReview', recordId: reviewId }, select: { id: true } })) : null
  if (!known) throw new NotFoundError('File not found.')
  await completeUpload(processFiles(), caller, fileId, idempotencyKey, { viaModule: true })
  return getReview(caller, reviewId)
}

// ---- the style compliance tab ----------------------------------------------------------------------------------------------------

/** GET /compliance/type-changes/styles/:styleId: what the revision in view changes, per covering certificate. */
export async function styleChanges(caller: CommandCaller, styleId: string, revisionId?: string): Promise<{ changes: StyleChangesView }> {
  const actor = actorOf(officeOf(caller))
  return caller.withClient(async (db) => {
    const style = isUuid(styleId) ? await db.style.findUnique({ where: { id: styleId }, select: { id: true, companyId: true } }) : null
    if (!style || !can(actor, CERTIFICATES_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
    const revisions = await db.styleRevision.findMany({ where: { styleId }, orderBy: { revision: 'desc' }, select: REVISION_REF })
    const inView = revisionId ? revisions.find((entry) => entry.id === revisionId) : (revisions.find((entry) => entry.status === 'DRAFT') ?? revisions.find((entry) => entry.status === 'RELEASED') ?? revisions[0])
    if (revisionId && !inView) throw new ValidationError('Not a revision of the style.', [{ path: 'querystring/revisionId', message: 'Pick a revision of this style.' }])
    if (!inView) return { changes: { styleId, revision: null, certificates: [] } }
    const released = revisions.find((entry) => entry.status === 'RELEASED' && entry.id !== inView.id) ?? null
    const certificates = (await coveringCertificates(db, styleId)).filter((certificate) => can(actor, CERTIFICATES_VIEW, certificateScope(certificate)))
    const out: StyleChangesView['certificates'] = []
    for (const certificate of certificates) {
      const rows = await db.typeChangeReview.findMany({ where: { revisionId: inView.id, certificateId: certificate.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: REVIEW_SELECT })
      const reviews = await reviewViews(db, rows)
      let compared: string | null = rows[0]?.comparedRevisionId ?? null
      let changes: TypeChange[] = rows[0] ? readChanges(rows[0].changes) : []
      if (inView.status === 'DRAFT') {
        // A draft: compared now with the type it would be compared with at its release.
        const previousReviews = released ? await db.typeChangeReview.findMany({ where: { revisionId: released.id, certificateId: certificate.id }, select: { status: true, comparedRevisionId: true } }) : []
        const base = approvedBaseOf(released?.id ?? null, previousReviews)
        if (base !== null) {
          compared = base
          changes = await changesBetween(db, base, inView.id)
        }
      }
      out.push({
        certificate: certificateRef(certificate),
        comparedRevision: compared ? (revisions.find((entry) => entry.id === compared) ?? null) : null,
        changes,
        reviews,
        labelHeld: rows.some((row) => holdsLabel(row.status)),
      })
    }
    return { changes: { styleId, revision: inView, certificates: out } }
  })
}

// ---- the label gate --------------------------------------------------------------------------------------------------------------

/**
 * The label gate's question (compliance/labels preview.ts, B-W1-44's garment label): the sentence that holds the class
 * label of a revision for the certificate that covers the garment, or null when no review holds it. No permission:
 * the caller's own gate decides who asks; the floor reads TypeChangeReview for this.
 */
export async function classLabelHoldFor(client: Reader, revisionId: string | null, certificateId: string): Promise<string | null> {
  if (revisionId === null) return null
  const rows = await client.typeChangeReview.findMany({
    where: { revisionId, certificateId, status: { in: [...HOLDING_STATUSES] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, status: true, changes: true, revision: { select: { revision: true } }, certificate: { select: { number: true } } },
  })
  return labelHoldWords(rows.map((row) => ({ id: row.id, status: row.status, revision: row.revision.revision, certificateNumber: row.certificate.number, kinds: kindsOf(readChanges(row.changes)) })))
}
