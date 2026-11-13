import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Grant, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_FITTINGS_MANAGE } from '@nexus/factory-domain/sales/fittings/permissions'
import type { DeleteOnBody, PhotoBody, PhotosView, PhotoView } from '@nexus/factory-domain/sales/mtm-photos/contracts'
import { deleteDayProblems, PHOTO_PROBLEM_WORDS, photoNameOf, photoUploadProblems, viewOfPhotoName, type MtmPhotoCategory, type PhotoProblem } from '@nexus/factory-domain/sales/mtm-photos/rules'
import { SALES_MTM_RECORD } from '@nexus/factory-domain/sales/mtm/permissions'
import type { ReviewStatus } from '@nexus/factory-domain/sales/mtm/rules'
import { command, type CommandCaller } from '../../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type OfficeContext, type SystemContext } from '../../../../core/context'
import { serverClock } from '../../../../core/time'
import { completeUpload, presignedView, requestUpload, storeCall, systemCallerOf } from '../../../../platform/files/files'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS, normaliseContentType } from '../../../../platform/files/rules'
import { processFiles } from '../../../../platform/files/service'
import { makeStrippedCopy } from '../../../../platform/files/thumbs/strip-copy'
import { garmentRefusal, mayOn, resultOf, sees } from '../../fittings/store'
import { assertMayProfile, chainOf, namesOf, officeOf, profileNotFound, profileOf, PROFILE_RECORD, type ProfileRow, type Reader } from '../store'

/**
 * Made-to-measure office photos (B-W2b-371, XF2:01; SAL-286, SAL-297; design rider.photos "Upload (ImageUpload) · Open in Lightbox ·
 * Delete (reason, logged)"; B-W2b-363's columns): the office's own photos of a rider in a base layer on a profile revision (StoredFile
 * category MTM_PHOTO of the MeasurementProfile revision) and the photos of a fitting (FITTING_PHOTO of the FittingResult), each with
 * its delete date (StoredFile.deleteAfter):
 *
 *   GET  /sales/mtm/profiles/:profileId/photos                          the chain's office and fitting photos (sales.measurements.view)
 *   POST /sales/mtm/profiles/:profileId/photos (+ /:fileId/complete)    a photo of that revision (sales.mtm.record)
 *   POST /sales/fittings/results/:resultId/photos (+ /:fileId/complete) a photo of that fitting (sales.fittings.manage)
 *   POST /sales/mtm/photos/:fileId/open                                 one photo for 60 seconds, its stripped copy (no location data),
 *                                                                       the opening recorded on the profile (sales.measurements.view)
 *   PUT  /sales/mtm/profiles/:profileId/photos/:fileId/delete-after     its delete date moved, with why (sales.mtm.record)
 *   PUT  /sales/fittings/results/:resultId/photos/:fileId/delete-after  the same for a fitting's photo (sales.fittings.manage)
 *
 * Body data, office only: visibility exactly OFFICE, never a floor, a portal or a link; this module's own files (platform/files
 * owned.ts: no generic upload, no generic read: files.read never reaches them). The bytes go through platform/files (types, size,
 * the presigned PUT, the store's check, the virus scan) as the tenant's system caller holding exactly files.upload over the photo's
 * company, after this module's checks. A photo is added only while made-to-measure is started for the garment type's template
 * (GATE-MTM, Owner 11-10: everything stays off per template until it starts; said in words); opening, dating and the purge stay
 * open. Without a date the job (./retention.ts) dates it 90 days after the garment ships. Every database rule (B-W2b-363's
 * StoredFile_w2b6_check) is said in words first; a refusal that still reaches the database answers 409 in words.
 */

const FITTING_RECORD = 'FittingResult'
const PHOTO_SELECT = {
  id: true,
  recordType: true,
  recordId: true,
  category: true,
  status: true,
  originalName: true,
  sizeBytes: true,
  deleteAfter: true,
  retainUntil: true,
  createdAt: true,
  createdById: true,
  version: true,
  companyId: true,
  storeAccountId: true,
  contentType: true,
} as const satisfies Prisma.StoredFileSelect
type PhotoRow = Prisma.StoredFileGetPayload<{ select: typeof PHOTO_SELECT }>

const isPhotoCategory = (value: string | null): value is MtmPhotoCategory => value === 'MTM_PHOTO' || value === 'FITTING_PHOTO'

function photoViewOf(row: PhotoRow, names: ReadonlyMap<string, string>, adders: ReadonlyMap<string, string>): PhotoView {
  const by = adders.get(row.id) ?? row.createdById
  return {
    id: row.id,
    category: row.category as MtmPhotoCategory,
    view: viewOfPhotoName(row.originalName),
    status: row.status,
    sizeBytes: row.sizeBytes,
    deleteAfter: row.deleteAfter ? toUtcIso(row.deleteAfter) : null,
    createdAt: toUtcIso(row.createdAt),
    by: by ? { id: by, name: names.get(by) ?? '' } : null,
    version: row.version,
  }
}

/** The tenant's system caller holding exactly these permissions over the photo's company (every company when it has none). */
function photoCaller(request: FastifyRequest, tenantId: string, companyId: string | null, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: companyId ? [companyId] : 'all', sites: 'all', parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** A 409 in words with the code the web says it by (`held/<CODE>`). */
const held = (code: string, words: string): DomainError => new DomainError('conflict', words, [{ path: `held/${code}`, message: words }])

const problemIssues = (problems: readonly PhotoProblem[], at: Record<PhotoProblem, string>): Issue[] => problems.map((problem) => ({ path: at[problem], message: PHOTO_PROBLEM_WORDS[problem] }))
const UPLOAD_PATHS: Record<PhotoProblem, string> = { TYPE: 'body/contentType', SIZE: 'body/sizeBytes', FULL: 'held/FULL', DAY: 'body/deleteOn', PAST: 'body/deleteOn', TOO_LATE: 'body/deleteOn', REASON: 'body/reason', DELETED: 'held/DELETED', SAME: 'body/deleteOn' }

/**
 * B-W2b-363's StoredFile_w2b6_check, when a write still reached it (a race): a 409 in words, never a 500. Every rule it holds is
 * checked here first.
 */
function databaseRefusal(error: unknown): never {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('files:')) {
    throw held('PHOTO_RULE', 'The photo changed meanwhile: its delete date moves but is never cleared, is not before the day it is kept until, and stays as it is once the photo is deleted. Read it again.')
  }
  throw error
}

// ---- where a photo belongs ------------------------------------------------------------------------------------------------

/** A revision the caller reads (else not found), holding `permission` over its customer (else forbidden). */
async function profileFor(caller: CommandCaller, context: OfficeContext, profileId: string, permission?: Permission): Promise<ProfileRow> {
  const profile = await caller.withClient((db) => profileOf(db, profileId))
  if (!profile) throw profileNotFound()
  assertMayProfile(context, profile.partyId, permission)
  return profile
}

/** A fitting result the caller reads (its company and customer; else not found), holding `permission` over them (else forbidden). */
async function resultFor(caller: CommandCaller, context: OfficeContext, resultId: string, permission?: Permission) {
  const result = await caller.withClient((db) => resultOf(db, resultId))
  if (!result || !sees(context, result)) throw new NotFoundError('Fitting result not found.')
  if (permission && !mayOn(context, permission, result)) throw new ForbiddenError()
  const profile = await caller.withClient((db) => profileOf(db, result.measurementProfileId))
  if (!profile) throw profileNotFound()
  return { result, profile }
}

/** GATE-MTM: no photo is added while made-to-measure is off for the garment type's template (409 in B-W2b-360's words). */
async function assertStarted(caller: CommandCaller, garmentType: string): Promise<void> {
  const refusal = await caller.withClient((db) => garmentRefusal(db, garmentType))
  if (refusal) throw held('MTM_NOT_STARTED', refusal)
}

/**
 * Who added each photo: the office person who confirmed it (the `mtmPhotos.added` audit row on its record: the bytes go in as the
 * tenant's system, so the file row names nobody), with their names.
 */
async function addersOf(db: Reader, recordIds: readonly string[], fileIds: readonly string[]): Promise<{ adders: Map<string, string>; names: Map<string, string> }> {
  const rows = recordIds.length === 0 ? [] : await db.auditLog.findMany({ where: { action: 'mtmPhotos.added', recordId: { in: [...recordIds] } }, select: { actorId: true, after: true } })
  const wanted = new Set(fileIds)
  const adders = new Map<string, string>()
  for (const row of rows) {
    const fileId = (row.after as { fileId?: unknown } | null)?.fileId
    if (typeof fileId === 'string' && wanted.has(fileId)) adders.set(fileId, row.actorId)
  }
  return { adders, names: await namesOf(db, [...adders.values()]) }
}

async function heldOf(db: Reader, recordType: string, recordId: string, category: MtmPhotoCategory): Promise<number> {
  return db.storedFile.count({ where: { recordType, recordId, category, status: { not: 'DELETED' } } })
}

// ---- the read -------------------------------------------------------------------------------------------------------------

/** GET /sales/mtm/profiles/:profileId/photos */
export async function listPhotos(request: FastifyRequest, profileId: string): Promise<PhotosView> {
  const context = officeOf(request)
  const profile = await profileFor(request, context, profileId)
  return request.withClient(async (db) => {
    const chain = await chainOf(db, profile)
    const ids = chain.map((row) => row.id)
    const refusal = await garmentRefusal(db, profile.garmentType)
    const office = await db.storedFile.findMany({ where: { recordType: PROFILE_RECORD, recordId: { in: ids }, category: 'MTM_PHOTO', status: { not: 'DELETED' } }, select: PHOTO_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const results = (await db.fittingResult.findMany({ where: { measurementProfileId: { in: ids } }, select: { id: true, companyId: true, partyId: true, fittedAt: true, verdict: true, measurementProfileId: true }, orderBy: [{ fittedAt: 'desc' }, { id: 'desc' }] })).filter((row) => sees(context, row))
    const fitting = results.length === 0 ? [] : await db.storedFile.findMany({ where: { recordType: FITTING_RECORD, recordId: { in: results.map((row) => row.id) }, category: 'FITTING_PHOTO', status: { not: 'DELETED' } }, select: PHOTO_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const { adders, names } = await addersOf(db, [...ids, ...results.map((row) => row.id)], [...office, ...fitting].map((row) => row.id))
    const revisionOf = new Map(chain.map((row) => [row.id, row]))
    const actor = actorOf(context)
    const party = { partyId: profile.partyId }
    return {
      profileId: profile.id,
      partyId: profile.partyId,
      riderName: profile.riderName,
      garmentType: profile.garmentType,
      started: refusal === null,
      revisions: [...chain]
        .reverse()
        .map((row) => ({ row, photos: office.filter((file) => file.recordId === row.id) }))
        .filter((entry) => entry.photos.length > 0)
        .map(({ row, photos }) => ({ id: row.id, revision: row.revision, review: row.reviewStatus as ReviewStatus, notice: { ref: row.privacyNoticeRef, at: toUtcIso(row.privacyNoticeAt) }, photos: photos.map((file) => photoViewOf(file, names, adders)) })),
      fittings: results
        .map((row) => ({ row, photos: fitting.filter((file) => file.recordId === row.id) }))
        .filter((entry) => entry.photos.length > 0)
        .map(({ row, photos }) => ({ resultId: row.id, fittedAt: toUtcIso(row.fittedAt), verdict: row.verdict, revision: revisionOf.get(row.measurementProfileId)?.revision ?? 0, photos: photos.map((file) => photoViewOf(file, names, adders)) })),
      may: {
        upload: refusal === null && can(actor, SALES_MTM_RECORD, party),
        uploadFitting: refusal === null && can(actor, SALES_FITTINGS_MANAGE, party),
        date: can(actor, SALES_MTM_RECORD, party),
        dateFitting: can(actor, SALES_FITTINGS_MANAGE, party),
      },
    }
  })
}

// ---- an upload -------------------------------------------------------------------------------------------------------------

interface PhotoTarget {
  readonly category: MtmPhotoCategory
  readonly recordType: string
  readonly recordId: string
  readonly companyId: string | null
  readonly profile: ProfileRow
  readonly resultId: string | null
}

async function announce(request: FastifyRequest, context: OfficeContext, target: PhotoTarget, body: PhotoBody, idempotencyKey?: string) {
  await assertStarted(request, target.profile.garmentType)
  const contentType = normaliseContentType(body.contentType)
  const uploader = photoCaller(request, context.tenantId, target.companyId, [FILES_UPLOAD])
  const count = await uploader.withClient((db) => heldOf(db, target.recordType, target.recordId, target.category))
  const today = businessDate(serverClock.now())
  const problems: PhotoProblem[] = [...photoUploadProblems({ contentType, sizeBytes: body.sizeBytes, held: count }), ...(body.deleteOn ? deleteDayProblems({ day: body.deleteOn, today, reason: null, current: null, deleted: false }) : [])]
  if (problems.includes('FULL')) throw held('FULL', PHOTO_PROBLEM_WORDS.FULL)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? PHOTO_PROBLEM_WORDS[problems[0]!] : 'The photo cannot be added as it stands.', problemIssues(problems, UPLOAD_PATHS))
  const answer = await requestUpload(
    processFiles(),
    uploader,
    {
      companyId: target.companyId,
      recordType: target.recordType,
      recordId: target.recordId,
      kind: 'PHOTO',
      category: target.category,
      originalName: photoNameOf(target.category, body.view, contentType, target.category === 'MTM_PHOTO' ? target.profile.revision : null),
      contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: ['OFFICE'],
    },
    idempotencyKey,
    { viaModule: true },
  )
  if (body.deleteOn) {
    const day = businessDayStart(body.deleteOn)
    await command(request, { name: 'mtmPhotos.dated', idempotencyKey: idempotencyKey ? `${idempotencyKey}:date` : undefined, input: { fileId: answer.file.id, deleteOn: body.deleteOn } }, async ({ tx, audit, emit }) => {
      const { count } = await tx.storedFile.updateMany({ where: { id: answer.file.id, deleteAfter: null }, data: { deleteAfter: day } })
      if (count === 1) {
        audit({ recordType: 'StoredFile', recordId: answer.file.id, companyId: target.companyId, before: { deleteAfter: null }, after: { deleteAfter: toUtcIso(day) }, reason: 'Given with the photo.' })
        emit({ type: 'measurement_photo.dated', subject: answer.file.id, companyId: target.companyId, payload: { profileId: target.profile.id, partyId: target.profile.partyId, fileId: answer.file.id, category: target.category, deleteAfter: toUtcIso(day) } })
      }
      return null
    }).catch(databaseRefusal)
  }
  return { file: { id: answer.file.id, status: answer.file.status, sizeBytes: answer.file.sizeBytes }, upload: answer.upload }
}

async function complete(request: FastifyRequest, context: OfficeContext, target: PhotoTarget, fileId: string, idempotencyKey?: string) {
  const uploader = photoCaller(request, context.tenantId, target.companyId, [FILES_UPLOAD])
  const row = isUuid(fileId) ? await uploader.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType: target.recordType, recordId: target.recordId, category: target.category }, select: { id: true, status: true } })) : null
  if (!row) throw new NotFoundError('Photo not found.')
  const wasAvailable = row.status === 'AVAILABLE'
  const view = await completeUpload(processFiles(), uploader, fileId, idempotencyKey, { viaModule: true })
  if (view.status === 'AVAILABLE' && !wasAvailable) {
    await command(request, { name: 'mtmPhotos.added', idempotencyKey: idempotencyKey ? `${idempotencyKey}:added` : undefined, input: { fileId } }, async ({ audit, emit }) => {
      audit({ action: 'mtmPhotos.added', recordType: target.category === 'MTM_PHOTO' ? PROFILE_RECORD : FITTING_RECORD, recordId: target.recordId, companyId: target.companyId, after: { fileId, category: target.category } })
      emit({ type: 'measurement_photo.added', subject: fileId, companyId: target.companyId, payload: { profileId: target.profile.id, partyId: target.profile.partyId, fileId, category: target.category, resultId: target.resultId } })
      return null
    })
  }
  return { photo: await photoNow(request, target.recordId, fileId) }
}

/** The photo as it is now, with who added it. */
async function photoNow(caller: CommandCaller, recordId: string, fileId: string): Promise<PhotoView> {
  return caller.withClient(async (db) => {
    const fresh = await db.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: PHOTO_SELECT })
    const { adders, names } = await addersOf(db, [recordId], [fileId])
    return photoViewOf(fresh, names, adders)
  })
}

async function profileTarget(request: FastifyRequest, context: OfficeContext, profileId: string): Promise<PhotoTarget> {
  const profile = await profileFor(request, context, profileId, SALES_MTM_RECORD)
  return { category: 'MTM_PHOTO', recordType: PROFILE_RECORD, recordId: profile.id, companyId: context.companyId ?? null, profile, resultId: null }
}

async function resultTarget(request: FastifyRequest, context: OfficeContext, resultId: string): Promise<PhotoTarget> {
  const { result, profile } = await resultFor(request, context, resultId, SALES_FITTINGS_MANAGE)
  return { category: 'FITTING_PHOTO', recordType: FITTING_RECORD, recordId: result.id, companyId: result.companyId, profile, resultId: result.id }
}

/** POST /sales/mtm/profiles/:profileId/photos */
export async function announceProfilePhoto(request: FastifyRequest, profileId: string, body: PhotoBody, idempotencyKey?: string) {
  const context = officeOf(request)
  return announce(request, context, await profileTarget(request, context, profileId), body, idempotencyKey)
}

/** POST /sales/mtm/profiles/:profileId/photos/:fileId/complete */
export async function completeProfilePhoto(request: FastifyRequest, profileId: string, fileId: string, idempotencyKey?: string) {
  const context = officeOf(request)
  return complete(request, context, await profileTarget(request, context, profileId), fileId, idempotencyKey)
}

/** POST /sales/fittings/results/:resultId/photos */
export async function announceFittingPhoto(request: FastifyRequest, resultId: string, body: PhotoBody, idempotencyKey?: string) {
  const context = officeOf(request)
  return announce(request, context, await resultTarget(request, context, resultId), body, idempotencyKey)
}

/** POST /sales/fittings/results/:resultId/photos/:fileId/complete */
export async function completeFittingPhoto(request: FastifyRequest, resultId: string, fileId: string, idempotencyKey?: string) {
  const context = officeOf(request)
  return complete(request, context, await resultTarget(request, context, resultId), fileId, idempotencyKey)
}

// ---- opening one ---------------------------------------------------------------------------------------------------------

/** POST /sales/mtm/photos/:fileId/open: the stripped copy for 60 seconds, the opening recorded on the profile. */
export async function openMtmPhoto(request: FastifyRequest, fileId: string, idempotencyKey?: string) {
  const context = officeOf(request)
  const row = isUuid(fileId) ? await request.withClient((db) => db.storedFile.findUnique({ where: { id: fileId }, select: PHOTO_SELECT })) : null
  if (!row || !isPhotoCategory(row.category) || row.status !== 'AVAILABLE') throw new NotFoundError('Photo not found (deleted, or not a made-to-measure photo).')
  const profile = row.category === 'MTM_PHOTO' ? await profileFor(request, context, row.recordId) : (await resultFor(request, context, row.recordId)).profile
  const view = viewOfPhotoName(row.originalName)
  await command(request, { name: 'mtmPhotos.opened', idempotencyKey, input: { fileId } }, async ({ audit }) => {
    audit({ action: 'mtmPhotos.opened', recordType: PROFILE_RECORD, recordId: profile.id, companyId: row.companyId, after: { fileId, category: row.category, view, by: context.actorId } })
    return null
  })
  const files = processFiles()
  const system = systemCallerOf(request)(context.tenantId)
  const made = await makeStrippedCopy(files, system, fileId)
  if (!made.key) throw new ConflictError('This photo is being prepared to be shown; try again in a minute.')
  const download = await storeCall(() =>
    files.storage.presignDownload(system, row.storeAccountId, { key: made.key!, contentType: row.contentType, disposition: attachmentDisposition(row.originalName), expiresInSeconds: DOWNLOAD_URL_SECONDS, now: files.clock.now() }),
  )
  return { file: { id: fileId, view }, download: presignedView(download) }
}

// ---- the delete date -------------------------------------------------------------------------------------------------------

async function dateOn(request: FastifyRequest, target: PhotoTarget, fileId: string, body: DeleteOnBody, idempotencyKey?: string) {
  const row = isUuid(fileId) ? await request.withClient((db) => db.storedFile.findFirst({ where: { id: fileId, recordType: target.recordType, recordId: target.recordId, category: target.category }, select: PHOTO_SELECT })) : null
  if (!row) throw new NotFoundError('Photo not found.')
  const today = businessDate(serverClock.now())
  const current = row.deleteAfter ? businessDate(row.deleteAfter) : null
  const problems = deleteDayProblems({ day: body.deleteOn, today, reason: body.reason, current, deleted: row.status === 'DELETED' })
  if (problems.includes('DELETED')) throw held('DELETED', PHOTO_PROBLEM_WORDS.DELETED)
  if (row.version !== body.version) throw held('STALE', 'This photo changed meanwhile: read it again.')
  const day = businessDayStart(body.deleteOn)
  // The same day: nothing to write (a repeated click is not a second change).
  if (problems.length === 1 && problems[0] === 'SAME') return { photo: await photoNow(request, target.recordId, fileId) }
  if (problems.length > 0) throw new ValidationError(PHOTO_PROBLEM_WORDS[problems[0]!], problemIssues(problems, UPLOAD_PATHS))
  if (row.retainUntil && row.retainUntil.getTime() > day.getTime()) {
    throw held('RETAINED', `This photo is kept at least until ${businessDate(row.retainUntil)}: it is not deleted before.`)
  }
  await command(
    request,
    { name: 'mtmPhotos.dated', idempotencyKey, input: { fileId, deleteOn: body.deleteOn, reason: body.reason }, record: { type: 'StoredFile', id: fileId, expectedVersion: body.version } },
    async ({ tx, audit, emit }) => {
      await tx.storedFile.update({ where: { id: fileId }, data: { deleteAfter: day }, select: { id: true } })
      audit({ recordType: 'StoredFile', recordId: fileId, companyId: row.companyId, before: { deleteAfter: row.deleteAfter ? toUtcIso(row.deleteAfter) : null }, after: { deleteAfter: toUtcIso(day) }, reason: body.reason })
      emit({ type: 'measurement_photo.dated', subject: fileId, companyId: row.companyId, payload: { profileId: target.profile.id, partyId: target.profile.partyId, fileId, category: target.category, deleteAfter: toUtcIso(day) } })
      return { id: fileId }
    },
  ).catch(databaseRefusal)
  return { photo: await photoNow(request, target.recordId, fileId) }
}

/** PUT /sales/mtm/profiles/:profileId/photos/:fileId/delete-after */
export async function dateProfilePhoto(request: FastifyRequest, profileId: string, fileId: string, body: DeleteOnBody, idempotencyKey?: string) {
  const context = officeOf(request)
  const profile = await profileFor(request, context, profileId, SALES_MTM_RECORD)
  return dateOn(request, { category: 'MTM_PHOTO', recordType: PROFILE_RECORD, recordId: profile.id, companyId: null, profile, resultId: null }, fileId, body, idempotencyKey)
}

/** PUT /sales/fittings/results/:resultId/photos/:fileId/delete-after */
export async function dateFittingPhoto(request: FastifyRequest, resultId: string, fileId: string, body: DeleteOnBody, idempotencyKey?: string) {
  const context = officeOf(request)
  return dateOn(request, await resultTarget(request, context, resultId), fileId, body, idempotencyKey)
}
