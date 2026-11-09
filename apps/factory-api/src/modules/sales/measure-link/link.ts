import type { FastifyInstance, FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, matchesLinkHash, mintLinkToken, parseLinkToken } from '@nexus/factory-domain/links/token'
import { measureMail } from '@nexus/factory-domain/sales/measure-link/mail'
import { formProblems, PHOTO_MAX_BYTES, PHOTO_TYPES, PHOTO_VIEWS, profileValuesOf, type MeasureForm, type PhotoView } from '@nexus/factory-domain/sales/measure-link/rules'
import { idempotencyKeyFrom, type CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type RequestContext, type SystemContext } from '../../../core/context'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { completeUpload, presignedView, requestUpload, storeCall, systemCallerOf } from '../../../platform/files/files'
import { assertOutsideUploadsOpen } from '../../../platform/files/multipart/outside'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS, normaliseContentType } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { makeStrippedCopy } from '../../../platform/files/thumbs/strip-copy'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { dropLinkDraft } from '../../../platform/links/drafts'
import { deliverLinkMail } from '../../../platform/links/mail'
import { LinkRefusedError } from '../../../platform/links/pay'
import { linkCommand, useLink } from '../../../platform/links/use'
import { systemContext } from '../../../platform/outbox/system'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { makeMeasureLinkInCommand } from './office'
import { latestOf, linkTermsOf, measureNotice, noticeReadOf, NOTICE_READ_ACTION, pointsOf, PROFILE_COLUMNS, PROFILE_RECORD, revisionIdFor, viewOfName, zoned, type Reader } from './store'

/**
 * Send measurements by link (B-W2b-171; SAL-096, SAL-286; design links.measure, its screen SCR-195): a MEASUREMENTS link
 * (B-W2b-154/163) names one rider's measurement profile and opens nothing else.
 *
 *   GET  /link/measure                          the sender, the rider and garment, the public notice in force and whether it
 *                                               was ticked on this link, photos required or optional, the points of measure
 *                                               by body zone (the template's), the link's terms. Reads use nothing.
 *   POST /link/measure/notice {noticeId}        "I have read how my measurements are used" for the notice in force: its
 *                                               time is kept (audit), the revision names it (GDPR art. 13: before any field)
 *   POST /link/measure/photos (+ /:fileId/complete)  front, side or back, after the notice: announced, PUT to the store, then
 *                                               confirmed; the file is the revision's to come (store revisionIdFor), shared
 *                                               with the link only, kept with us (never on the device); JPEG or PNG only
 *   GET  /link/measure/photos/:fileId/preview   one of this link's photos for 60 seconds, without location data (a resumed
 *                                               draft shows its photos again)
 *   POST /link/measure {form, noticeId}         the send: checked first (a refusal uses nothing), then ONE command of the
 *                                               link's own session: the use (SUBMITTED, counted; typed name optional), the
 *                                               new revision (max + 1, superseding the latest) inserted by the link session
 *                                               itself, the draft dropped, measurements.submitted. A repeat with the same
 *                                               Idempotency-Key replays it. The photos not chosen are deleted after.
 *
 * The draft is B-W2b-163's GET|PUT /link/draft (sealed, with us). The link session reads its own party's profiles; the
 * template, the notice, the audit trail and the files are read as the tenant's system, for the link's company and party.
 */

function measureLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'MEASUREMENTS' || link.record.type !== PROFILE_RECORD) throw linkUnavailable()
  return link
}

const systemOf = (request: FastifyRequest, link: { readonly tenantId: string }): CommandCaller => systemCallerOf(request)(link.tenantId)
const localeOf = (value: string | null | undefined): 'it' | 'en' => (value === 'en' ? 'en' : 'it')

/** The tenant's system caller holding files.upload and files.manage over the link's company and party only. */
function photoUploader(request: FastifyRequest, link: LinkSession): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [link.companyId], sites: 'all', parties: [link.partyId] }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId: link.tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

/** The facts of the link's page, read as the tenant's system for the link's party. */
async function pageFacts(db: Reader, link: LinkSession) {
  const profile = await db.measurementProfile.findUnique({ where: { id: link.record.id }, select: PROFILE_COLUMNS })
  if (!profile || profile.partyId !== link.partyId) return null
  const [company, party, template, notice, terms] = await Promise.all([
    db.company.findUnique({ where: { id: link.companyId }, select: { id: true, legalName: true, tradeName: true } }),
    db.party.findUnique({ where: { id: link.partyId }, select: { language: true } }),
    pointsOf(db, profile.garmentType),
    measureNotice(db, link.companyId),
    linkTermsOf(db, link.id),
  ])
  const noticeAt = notice ? await noticeReadOf(db, link.id, notice.id) : null
  return { profile, company, party, template, notice, noticeAt, terms }
}

const wordsOf = (name: string, i18n: Record<string, string>) => ({ it: i18n.it ?? name, en: i18n.en ?? name })

/** GET /link/measure?language= */
export async function measurePage(app: FastifyInstance, request: FastifyRequest, language?: 'it' | 'en') {
  const link = measureLinkOf(request)
  const now = appClock(app).now()
  const facts = await systemOf(request, link).withClient((db) => pageFacts(db, link))
  if (!facts) throw linkUnavailable()
  return {
    sender: { companyId: link.companyId, companyName: facts.company?.tradeName ?? facts.company?.legalName ?? '' },
    rider: { name: facts.profile.riderName },
    garment: { code: facts.template.code, name: wordsOf(facts.template.name, facts.template.nameI18n) },
    order: facts.terms.orderNumber ? { number: facts.terms.orderNumber } : null,
    notice: facts.notice ? { id: facts.notice.id, label: facts.notice.label, publishedAt: facts.notice.publishedAt ? toUtcIso(facts.notice.publishedAt) : null } : null,
    noticeRead: facts.notice && facts.noticeAt ? { noticeId: facts.notice.id, at: toUtcIso(facts.noticeAt) } : null,
    photos: facts.terms.photos,
    points: facts.template.points.map((point) => zoned({ code: point.code, name: wordsOf(point.name, point.nameI18n), seq: point.seq, required: point.required, minCm: point.minCm, maxCm: point.maxCm, howTo: point.howTo })),
    link: { expiresAt: toUtcIso(link.expiresAt), usesLeft: Math.max(0, link.maxUses - link.uses), live: link.expiresAt.getTime() > now.getTime() },
    locale: language ?? localeOf(facts.party?.language),
  }
}

export const NOTICE_FIRST = 'Read how your measurements are used and tick it first: no measurement or photo before that.'
export const NOTICE_CHANGED = 'The privacy notice changed since you read it: read the new one and tick it again.'
export const NO_NOTICE_YET = 'The sender has not published its privacy notice yet: ask them, the form opens once it is.'

/** POST /link/measure/notice: the tick of the notice in force, kept with its time (no use, no evidence row). */
export async function readNotice(request: FastifyRequest, body: { readonly noticeId: string }) {
  const link = measureLinkOf(request)
  const system = systemOf(request, link)
  const notice = await system.withClient((db) => measureNotice(db, link.companyId))
  if (!notice) throw new LinkRefusedError('NO_NOTICE', NO_NOTICE_YET)
  if (notice.id !== body.noticeId) throw new LinkRefusedError('NOTICE_CHANGED', NOTICE_CHANGED)
  const already = await system.withClient((db) => noticeReadOf(db, link.id, notice.id))
  if (already) return { noticeRead: { noticeId: notice.id, at: toUtcIso(already) } }
  const { result } = await linkCommand(request, { name: 'measureLink.notice', idempotencyKey: idempotencyKeyFrom(request), input: { noticeId: notice.id } }, async ({ audit, now }) => {
    audit({ action: NOTICE_READ_ACTION, recordType: 'OneOffLink', recordId: link.id, companyId: link.companyId, after: { noticeId: notice.id, label: notice.label, at: toUtcIso(now) } })
    return { at: toUtcIso(now) }
  })
  // The time kept is the audit row's (noticeReadOf); a replay answers the first tick.
  const at = (await system.withClient((db) => noticeReadOf(db, link.id, notice.id))) ?? new Date(result.at)
  return { noticeRead: { noticeId: notice.id, at: toUtcIso(at) } }
}

/** The notice was ticked on this link for the version in force; else a 409 in words (fields and photos stay held). */
async function assertNoticeRead(request: FastifyRequest, link: LinkSession, noticeId?: string): Promise<{ id: string; label: string; at: Date }> {
  const found = await systemOf(request, link).withClient(async (db) => {
    const notice = await measureNotice(db, link.companyId)
    return notice ? { notice, at: await noticeReadOf(db, link.id, notice.id) } : null
  })
  if (!found) throw new LinkRefusedError('NO_NOTICE', NO_NOTICE_YET)
  if (noticeId !== undefined && noticeId !== found.notice.id) throw new LinkRefusedError('NOTICE_CHANGED', NOTICE_CHANGED)
  if (!found.at) throw new LinkRefusedError('NOTICE_FIRST', NOTICE_FIRST)
  return { id: found.notice.id, label: found.notice.label, at: found.at }
}

// ---- photos ---------------------------------------------------------------------------------------------------------------

/** At most this many photos uploaded through one link (retakes included); the ones not sent are deleted. */
export const LINK_PHOTOS_MAX = 12

export interface PhotoBody {
  readonly view: PhotoView
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

const fileAnswer = (file: { id: string; originalName: string; sizeBytes: number; status: string }) => ({ id: file.id, view: viewOfName(file.originalName) ?? 'FRONT', sizeBytes: file.sizeBytes, status: file.status })

/** POST /link/measure/photos. */
export async function announceMeasurePhoto(files: FilesRuntime, request: FastifyRequest, body: PhotoBody, idempotencyKey?: string) {
  const link = measureLinkOf(request)
  // B-W2b-160 (FV1:02): an upload from outside waits for the virus scanner in a live environment (GATE-SPEND).
  assertOutsideUploadsOpen()
  await assertNoticeRead(request, link)
  const contentType = normaliseContentType(body.contentType)
  const problems = [
    ...((PHOTO_TYPES as readonly string[]).includes(contentType) ? [] : [{ path: 'body/contentType', message: 'A photo as JPEG or PNG (a HEIC keeps your location: choose "Most compatible" or take it from this page).' }]),
    ...(body.sizeBytes <= PHOTO_MAX_BYTES ? [] : [{ path: 'body/sizeBytes', message: 'At most 15 MB.' }]),
  ]
  if (problems.length > 0) throw new ValidationError('The photo cannot be sent as it stands.', problems)
  const uploader = photoUploader(request, link)
  const revisionId = revisionIdFor(link.id)
  const held = await uploader.withClient((client) => client.storedFile.count({ where: { recordType: PROFILE_RECORD, recordId: revisionId, partyId: link.partyId, category: 'BODY_PHOTO' } }))
  if (held >= LINK_PHOTOS_MAX) throw new LinkRefusedError('PHOTOS_FULL', `This link took ${LINK_PHOTOS_MAX} photos already: send the form with the ones you have, or ask the sender for a new link.`)
  const extension = contentType === 'image/png' ? 'png' : 'jpg'
  const answer = await requestUpload(
    files,
    uploader,
    {
      companyId: link.companyId,
      recordType: PROFILE_RECORD,
      recordId: revisionId,
      kind: 'PHOTO',
      category: 'BODY_PHOTO',
      // The view names the file; never the rider's own file name (personal data in a name is not needed).
      originalName: `measurements-${body.view.toLowerCase()}.${extension}`,
      contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: ['OFFICE', 'LINK'],
      partyId: link.partyId,
    },
    idempotencyKey,
    { viaModule: true },
  )
  return { file: fileAnswer(answer.file), upload: answer.upload }
}

/** One of this link's photos (its revision to come), read as the uploader; null when it is not. */
async function linkPhoto(request: FastifyRequest, link: LinkSession, fileId: string) {
  if (!isUuid(fileId)) return null
  const row = await photoUploader(request, link).withClient((client) =>
    client.storedFile.findFirst({ where: { id: fileId, recordType: PROFILE_RECORD, recordId: revisionIdFor(link.id), partyId: link.partyId, category: 'BODY_PHOTO' }, select: { id: true, originalName: true, sizeBytes: true, status: true, storeAccountId: true, contentType: true } }),
  )
  return row
}

/** POST /link/measure/photos/:fileId/complete. */
export async function completeMeasurePhoto(files: FilesRuntime, request: FastifyRequest, fileId: string, idempotencyKey?: string) {
  const link = measureLinkOf(request)
  const row = await linkPhoto(request, link, fileId)
  if (!row) throw new NotFoundError('File not found.')
  const view = await completeUpload(files, photoUploader(request, link), fileId, idempotencyKey, { viaModule: true })
  return { file: fileAnswer(view) }
}

/** GET /link/measure/photos/:fileId/preview: the stripped copy for 60 seconds (no location data). */
export async function previewMeasurePhoto(files: FilesRuntime, request: FastifyRequest, fileId: string) {
  const link = measureLinkOf(request)
  const row = await linkPhoto(request, link, fileId)
  if (!row || row.status !== 'AVAILABLE') throw new NotFoundError('File not found.')
  const system = systemOf(request, link)
  const made = await makeStrippedCopy(files, system, fileId)
  if (!made.key) throw new ConflictError('This photo is being prepared to be shown; try again in a minute.')
  const preview = await storeCall(() =>
    files.storage.presignDownload(system, row.storeAccountId, { key: made.key!, contentType: row.contentType, disposition: attachmentDisposition(row.originalName), expiresInSeconds: DOWNLOAD_URL_SECONDS, now: files.clock.now() }),
  )
  return { file: fileAnswer(row), preview: presignedView(preview) }
}

// ---- the send -------------------------------------------------------------------------------------------------------------

export type SendBody = MeasureForm & { readonly noticeId: string; readonly typedName?: string | null | undefined }

/** POST /link/measure: the new revision of the profile, sent by the link's own session. */
export async function sendMeasurements(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, body: SendBody) {
  const link = measureLinkOf(request)
  const system = systemOf(request, link)
  const notice = await assertNoticeRead(request, link, body.noticeId)
  const revisionId = revisionIdFor(link.id)
  const facts = await system.withClient(async (db) => {
    const page = await pageFacts(db, link)
    if (!page) return null
    const chosen = PHOTO_VIEWS.flatMap((view) => (body.photos[view] ? [body.photos[view]!] : []))
    const photos = chosen.length > 0 ? await db.storedFile.findMany({ where: { id: { in: chosen } }, select: { id: true, recordType: true, recordId: true, partyId: true, kind: true, category: true, status: true } }) : []
    return { ...page, photos }
  })
  if (!facts) throw linkUnavailable()
  // Checked before the link is used: a form that cannot go uses nothing.
  const problems = formProblems(body, facts.template.points, facts.terms.photos)
  for (const view of PHOTO_VIEWS) {
    const id = body.photos[view]
    if (!id) continue
    const file = facts.photos.find((row) => row.id === id)
    if (!file || file.recordType !== PROFILE_RECORD || file.recordId !== revisionId || file.partyId !== link.partyId || file.kind !== 'PHOTO' || file.category !== 'BODY_PHOTO') problems.push({ path: `body/photos/${view}`, code: 'PHOTO_REQUIRED', message: 'Not a photo you took with this link.' })
    else if (file.status !== 'AVAILABLE') problems.push({ path: `body/photos/${view}`, code: 'PHOTO_REQUIRED', message: 'This photo has not arrived yet (or could not be checked): take it again.' })
  }
  if (problems.length > 0) throw new ValidationError('The measurements cannot be sent like this.', problems.map(({ path, message }) => ({ path, message })))
  const values = profileValuesOf(body, facts.template.points)

  const { result } = await linkCommand(request, { name: 'measureLink.send', idempotencyKey: idempotencyKeyFrom(request), input: { linkId: link.id, ...body } }, async (tools) => {
    const used = await useLink(tools, request, { action: 'submit', typedName: body.typedName ?? null })
    // The link session reads its own party's revisions: the new one is the latest + 1 (the unique key holds a race).
    const latest = await latestOf(tools.tx, facts.profile)
    if (!latest) throw linkUnavailable()
    const typed = used.typedName?.trim()
    await tools.tx.measurementProfile.createMany({
      data: [
        {
          id: revisionId,
          partyId: link.partyId,
          contactId: latest.contactId,
          riderName: latest.riderName,
          garmentType: latest.garmentType,
          revision: latest.revision + 1,
          supersedesId: latest.id,
          measurements: values.measurements,
          fitNotes: values.fitNotes,
          takenAt: tools.now,
          takenBy: typed ? `${typed} (by link)` : `${latest.riderName} (by link)`,
          privacyNoticeRef: notice.label,
          privacyNoticeAt: notice.at,
          submittedViaLinkId: link.id,
          submittedAt: tools.now,
          noticeVersionId: notice.id,
          photoFrontFileId: body.photos.FRONT ?? null,
          photoSideFileId: body.photos.SIDE ?? null,
          photoBackFileId: body.photos.BACK ?? null,
          createdAt: tools.now,
        },
      ],
    })
    await dropLinkDraft(tools, link.id)
    const photos = PHOTO_VIEWS.filter((view) => body.photos[view]).length
    tools.audit({ recordType: PROFILE_RECORD, recordId: revisionId, companyId: link.companyId, after: { revision: latest.revision + 1, supersedesId: latest.id, linkId: link.id, evidenceId: used.evidenceId, noticeId: notice.id, points: Object.keys(values.measurements).length, photos } })
    tools.emit({ type: 'measurements.submitted', subject: revisionId, companyId: link.companyId, payload: { profileId: revisionId, supersedesId: latest.id, linkId: link.id, partyId: link.partyId, revision: latest.revision + 1, photos } })
    return { profileId: revisionId, revision: latest.revision + 1, at: toUtcIso(tools.now), photos, usesLeft: used.usesLeft }
  })
  // The retakes not chosen are not kept (best effort; the hourly job deletes any left).
  await deleteUnsentPhotos(files, app, system, link, revisionId).catch(() => undefined)
  return { sent: { profileId: result.profileId, revision: result.revision, at: result.at, photos: result.photos }, link: { usesLeft: result.usesLeft } }
}

/** The link's photos the revision does not name: DELETED, their objects removed. */
async function deleteUnsentPhotos(files: FilesRuntime, app: FastifyInstance, system: CommandCaller, link: LinkSession, revisionId: string) {
  const left = await system.withClient(async (db) => {
    const profile = await db.measurementProfile.findUnique({ where: { id: revisionId }, select: { photoFrontFileId: true, photoSideFileId: true, photoBackFileId: true } })
    if (!profile) return []
    const kept = [profile.photoFrontFileId, profile.photoSideFileId, profile.photoBackFileId].filter((id): id is string => id !== null)
    return db.storedFile.findMany({ where: { recordType: PROFILE_RECORD, recordId: revisionId, category: 'BODY_PHOTO', status: { not: 'DELETED' }, legalHold: false, id: { notIn: kept } }, select: { id: true, status: true, storeAccountId: true, storageKey: true, thumbnailKey: true, retainUntil: true, legalHold: true } })
  })
  if (left.length === 0) return
  await commandOn(app, system, { name: 'measureLink.dropRetakes', input: { revisionId, files: left.map((file) => file.id) } }, async (tools) => {
    for (const file of left) {
      await tools.tx.storedFile.update({ where: { id: file.id }, data: { status: 'DELETED', deletedAt: tools.now } })
      tools.audit({ action: 'files.delete', recordType: 'StoredFile', recordId: file.id, companyId: link.companyId, before: { status: file.status }, after: { status: 'DELETED' }, reason: 'A photo taken again: the measurements were sent with another.' })
    }
    return null
  })
  for (const file of left) {
    for (const key of [file.storageKey, file.thumbnailKey].filter((value): value is string => value !== null)) {
      await files.storage.remove(system, file.storeAccountId, { key, legalHold: false, retainUntil: file.retainUntil }, files.clock.now()).catch(() => undefined)
    }
  }
}

// ---- "Ask for a new link" -------------------------------------------------------------------------------------------------

function asContext(request: FastifyRequest, context: RequestContext): FastifyRequest {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

const RENEW_COALESCE_MS = 10 * 60_000

/**
 * The renewer of a dead measurement link (B-W2b-163's registerLinkRenewer, after POST /link/renew answered): an EXPIRED link
 * (never a withdrawn one, never one whose measurements were sent), sent to an address that is still an active contact's of the
 * customer, with no live measurement link of the same rider to it and none renewed in the last 10 minutes → a new link with
 * the same photo rule and order, mailed to the same address (FAKE locally). The outcome code is only logged.
 */
export async function renewMeasureLink(email: EmailRuntime, request: FastifyRequest, header: unknown): Promise<string> {
  const token = parseLinkToken(typeof header === 'string' ? header.trim() : undefined)
  if (!token) return 'NOT_A_TOKEN'
  const requestId = String(request.id)
  const platform = asContext(request, { audience: 'platform', actorId: SYSTEM_ACTOR_ID, grants: [], requestId })
  const tenant = await platform.withClient((client) => client.tenant.findUnique({ where: { id: token.tenantId }, select: { status: true } }))
  if (tenant?.status !== 'ACTIVE') return 'UNKNOWN'
  const system = asContext(request, systemContext(token.tenantId, requestId))
  const clock = officeAuthOf(request.server).clock
  const now = clock.now()
  const found = await system.withClient(async (client) => {
    const link = await client.oneOffLink.findUnique({ where: { id: token.linkId }, select: { id: true, partyId: true, companyId: true, purpose: true, recordType: true, recordId: true, tokenHash: true, email: true, contactId: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true } })
    if (!link || link.partyId !== token.partyId || !matchesLinkHash(token, link.tokenHash) || link.purpose !== 'MEASUREMENTS') return null
    const profile = await client.measurementProfile.findUnique({ where: { id: link.recordId }, select: PROFILE_COLUMNS })
    const latest = profile ? await latestOf(client, profile) : null
    const onFile = link.email ? await client.partyContact.count({ where: { partyId: link.partyId, status: 'ACTIVE', email: { equals: link.email, mode: 'insensitive' } } }) : 0
    const chainIds = latest ? (await client.measurementProfile.findMany({ where: { partyId: latest.partyId, riderName: latest.riderName, garmentType: latest.garmentType }, select: { id: true } })).map((row) => row.id) : []
    const others = link.email ? await client.oneOffLink.findMany({ where: { purpose: 'MEASUREMENTS', recordId: { in: chainIds }, email: link.email, id: { not: link.id } }, select: { revokedAt: true, uses: true, maxUses: true, expiresAt: true, createdAt: true } }) : []
    const company = await client.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } })
    const party = await client.party.findUnique({ where: { id: link.partyId }, select: { language: true } })
    const terms = await linkTermsOf(client, link.id)
    const template = latest ? await pointsOf(client, latest.garmentType) : null
    return { link, latest, onFile, others, company, party, terms, template }
  })
  if (!found) return 'UNKNOWN'
  const { link, latest } = found
  const state = linkState(link, now)
  if (state === 'REVOKED') return 'WITHDRAWN'
  if (state === 'LIVE') return 'STILL_LIVE'
  if (state === 'USED_UP') return 'SENT_ALREADY'
  if (!latest || !found.template) return 'NOTHING_TO_SHARE'
  if (!link.email) return 'NO_ADDRESS'
  if (found.onFile === 0) return 'ADDRESS_NOT_ON_FILE'
  if (found.others.some((other) => linkState(other, now) === 'LIVE')) return 'NEWER_LINK'
  if (found.others.some((other) => other.createdAt.getTime() > now.getTime() - RENEW_COALESCE_MS)) return 'ASKED_RECENTLY'
  const locale = localeOf(found.party?.language)
  const companyName = found.company?.tradeName ?? found.company?.legalName ?? ''
  const garment = found.template.nameI18n[locale] ?? found.template.name
  const linkId = newId()
  const fresh = mintLinkToken({ tenantId: token.tenantId, partyId: link.partyId, linkId })
  const mailOf = (expiresAt: Date, url: string) => measureMail(locale, { companyName, riderName: latest.riderName, garment, expiresAt, photos: found.terms.photos === 'REQUIRED' }, url)
  const { result } = await commandOn(request.server, system, { name: 'measureLink.renew', input: { linkId: link.id } }, (tools) =>
    makeMeasureLinkInCommand(tools, {
      profile: { id: latest.id, partyId: latest.partyId },
      companyId: link.companyId,
      linkId,
      tokenHash: linkTokenHash(fresh.value),
      to: link.email,
      contactId: link.contactId,
      send: true,
      photos: found.terms.photos,
      orderNumber: found.terms.orderNumber,
      salesOrderLineId: found.terms.salesOrderLineId,
      via: 'RENEWAL',
      createdById: SYSTEM_ACTOR_ID,
      renewalOfId: link.id,
      subject: (expiresAt) => mailOf(expiresAt, '').subject,
      locale,
      sender: null,
    }),
  )
  if (!result.outboundId) return 'NO_ADDRESS'
  const url = officeAuthOf(request.server).link('/l', fresh.value)
  await deliverLinkMail(email, system, result.outboundId, mailOf(new Date(result.expiresAt), url).body, null, clock)
  return 'SENT'
}
