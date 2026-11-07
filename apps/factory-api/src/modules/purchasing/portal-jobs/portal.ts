import type { FastifyInstance, FastifyRequest } from 'fastify'
import { FILES_MANAGE, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Grant } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import {
  acceptedWords,
  declinedWords,
  kitCheckedWords,
  progressWords,
  returnWords,
  type AcceptInput,
  type DeclineInput,
  type KitCheckInput,
  type ProgressInput,
  type ReturnInput,
} from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import { PORTAL_JOBS_VIEW } from '@nexus/factory-domain/purchasing/portal-jobs/permissions'
import { idempotencyKeyFrom, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, requireContext, SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import { assertOutsideUploadsOpen } from '../../../platform/files/multipart/outside'
import { normaliseContentType } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { acceptInCommand, announceInCommand, checkKitInCommand, declineInCommand, reportInCommand, rowsInCommand, type Who } from './acts'
import { heldJob, listPortalJobs, localeOf, mayActOf, portalJob, readJobContext, readJobRows, systemOf, type JobContext, type JobOrderRow, type JobRows } from './read'

/**
 * The workshop's jobs in the portal (B-W2b-176; SCM-154 to SCM-157; design portal.supplier.jobs). Reading needs the page
 * (portal.jobs.view, the routes'); each act also needs the capability its verb takes (B-W2b-162): accept, decline and confirm
 * the kit `portal.approve`; report progress and announce a send-back `portal.comment`; a photo of damage `portal.upload`. An
 * office preview reads and never acts. Each act is ONE command in the session's own scope (./acts.ts) naming the job with the
 * version the page showed; the answer is the job again with the end state's words in the person's language.
 */

type Capability = 'approve' | 'comment' | 'upload'
const CAPABILITY_WORDS: Readonly<Record<Capability, string>> = {
  approve: 'Your access lets you read our jobs, not answer them: ask your admin for the right to approve.',
  comment: 'Your access lets you read our jobs, not report on them: ask your admin for the right to comment.',
  upload: 'Your access lets you read our jobs, not send files: ask your admin for the right to upload.',
}

interface Prepared {
  readonly session: PortalSession
  readonly order: JobOrderRow
  readonly context: JobContext
  readonly who: Who
}

/** The job the person holds, what they may do, and the system scope's facts (before the command). */
async function prepare(request: FastifyRequest, orderId: string, capability: Capability): Promise<Prepared> {
  const session = portalSessionOf(request)
  const order = await request.withClient((client) => heldJob(client, session, orderId))
  if (session.preview) throw new ForbiddenError('A preview reads the portal; it never acts for the workshop.')
  if (!mayActOf(request, session, order)[capability]) throw new ForbiddenError(CAPABILITY_WORDS[capability])
  const rows = await request.withClient((client) => readJobRows(client, order))
  const context = await systemOf(request, session.tenantId).withClient((client) => readJobContext(client, rows, session.partyId))
  return { session, order, context, who: { via: 'PORTAL', personId: session.userId, name: session.person.displayName } }
}

async function act<Result>(
  app: FastifyInstance,
  request: FastifyRequest,
  prepared: Prepared,
  spec: { readonly name: `${string}.${string}`; readonly version: number; readonly input: unknown },
  work: (tools: CommandTools, rows: JobRows) => Promise<Result>,
): Promise<Result> {
  const { result } = await commandOn<Result>(
    app,
    request,
    { name: spec.name, idempotencyKey: idempotencyKeyFrom(request), input: { orderId: prepared.order.id, ...(spec.input as object) }, record: { type: 'SubcontractOrder', id: prepared.order.id, expectedVersion: spec.version } },
    async (tools) => work(tools, await rowsInCommand(tools, prepared.order.id)),
  )
  return result
}

const endState = async (request: FastifyRequest, orderId: string, done: string) => ({ ...(await portalJob(request, orderId)), done })

export { listPortalJobs, portalJob }

/** POST /portal/jobs/:id/accept: as asked, or proposing another due-back date (with why). */
export async function acceptInPortal(app: FastifyInstance, request: FastifyRequest, orderId: string, body: AcceptInput & { readonly version: number }) {
  const prepared = await prepare(request, orderId, 'approve')
  const plan = await act(app, request, prepared, { name: 'purchasing.portalJobAccept', version: body.version, input: body }, (tools, rows) => acceptInCommand(tools, rows, prepared.context, body, prepared.who))
  const kitDay = prepared.context.bundles.length > 0 ? businessDate(prepared.context.bundles.at(-1)!.sentAt) : null
  return endState(request, prepared.order.id, acceptedWords(plan, kitDay, localeOf(prepared.session.person.locale)))
}

/** POST /portal/jobs/:id/decline: with a reason. */
export async function declineInPortal(app: FastifyInstance, request: FastifyRequest, orderId: string, body: DeclineInput & { readonly version: number }) {
  const prepared = await prepare(request, orderId, 'approve')
  await act(app, request, prepared, { name: 'purchasing.portalJobDecline', version: body.version, input: body }, (tools, rows) => declineInCommand(tools, rows, prepared.context, body, prepared.who))
  return endState(request, prepared.order.id, declinedWords(localeOf(prepared.session.person.locale)))
}

/** POST /portal/jobs/:id/kit: all received as listed, or line by line (a shortfall with words). */
export async function checkKitInPortal(app: FastifyInstance, request: FastifyRequest, orderId: string, body: KitCheckInput & { readonly version: number }) {
  const prepared = await prepare(request, orderId, 'approve')
  const plan = await act(app, request, prepared, { name: 'purchasing.portalJobKit', version: body.version, input: body }, (tools, rows) => checkKitInCommand(tools, rows, prepared.context, body, prepared.who))
  return endState(request, prepared.order.id, kitCheckedWords(plan.lines, localeOf(prepared.session.person.locale)))
}

/** POST /portal/jobs/:id/progress: finished pieces per operation and size or bundle, and the day it finishes by. */
export async function reportInPortal(app: FastifyInstance, request: FastifyRequest, orderId: string, body: ProgressInput & { readonly version: number }) {
  const prepared = await prepare(request, orderId, 'comment')
  const plan = await act(app, request, prepared, { name: 'purchasing.portalJobProgress', version: body.version, input: body }, (tools, rows) => reportInCommand(tools, rows, prepared.context, body, prepared.who))
  return endState(request, prepared.order.id, progressWords(plan.finished, localeOf(prepared.session.person.locale)))
}

/** POST /portal/jobs/:id/returns: what comes back, with its DDT. */
export async function announceInPortal(app: FastifyInstance, request: FastifyRequest, orderId: string, body: ReturnInput & { readonly version: number }) {
  const prepared = await prepare(request, orderId, 'comment')
  const plan = await act(app, request, prepared, { name: 'purchasing.portalJobReturn', version: body.version, input: body }, (tools, rows) => announceInCommand(tools, rows, prepared.context, body, prepared.who))
  return endState(request, prepared.order.id, returnWords(plan.pieces, plan.expectedDate, localeOf(prepared.session.person.locale)))
}

// ---- a photo of a missing or damaged kit item -----------------------------------------------------------------------------

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic']
const PHOTO_MAX_BYTES = 15 * 1_048_576
/** How many photos one kit line takes from the workshop. */
export const MAX_KIT_PHOTOS = 5

export interface PhotoUpload {
  readonly kitLineId: string
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/**
 * The tenant's system caller with files.upload and files.manage over this job's company and the workshop's party only: the
 * partner role may not write files, so the files module is called this way AFTER the person, the job and the kit line were
 * checked here (as W1's supplier confirmation PDF). Never a file of another job, company or party.
 */
function workshopUploader(request: FastifyRequest, tenantId: string, companyId: string, partyId: string): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [FILES_UPLOAD, FILES_MANAGE], companies: [companyId], sites: 'all', parties: [partyId] }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}

async function photoLine(request: FastifyRequest, orderId: string, kitLineId: string) {
  const session = portalSessionOf(request)
  const order = await request.withClient((client) => heldJob(client, session, orderId))
  if (session.preview) throw new ForbiddenError('A preview reads the portal; it never acts for the workshop.')
  if (!mayActOf(request, session, order).upload) throw new ForbiddenError(CAPABILITY_WORDS.upload)
  const line = isUuid(kitLineId) ? await request.withClient((client) => client.subcontractKitLine.findFirst({ where: { id: kitLineId, subcontractOrderId: order.id }, select: { id: true, seq: true, status: true } })) : null
  if (!line) throw new ValidationError('Not a line of this kit.', [{ path: 'body/kitLineId', message: 'Not a line of this kit.' }])
  if (line.status !== 'SENT') throw new InvalidStateError(`Kit line ${line.seq} has not left us yet.`)
  return { session, order, line }
}

const fileOf = (file: { id: string; originalName: string; sizeBytes: number; status: string }) => ({ id: file.id, originalName: file.originalName, sizeBytes: file.sizeBytes, status: file.status })

/** POST /portal/jobs/:id/kit/photos: announce a photo of a kit line (PHOTO, the job's company, shared with the party). */
export async function announcePhoto(request: FastifyRequest, orderId: string, body: PhotoUpload) {
  // B-W2b-160 (FV1:02): an upload from outside waits for the virus scanner in a live environment (GATE-SPEND).
  assertOutsideUploadsOpen()
  const { session, order, line } = await photoLine(request, orderId, body.kitLineId)
  const problems = [
    ...(PHOTO_TYPES.includes(normaliseContentType(body.contentType)) ? [] : [{ path: 'body/contentType', message: 'A photo: JPEG, PNG, WebP or HEIC.' }]),
    ...(body.sizeBytes <= PHOTO_MAX_BYTES ? [] : [{ path: 'body/sizeBytes', message: 'At most 15 MB.' }]),
  ]
  if (problems.length > 0) throw new ValidationError('The photo cannot be sent as it stands.', problems)
  const held = await systemOf(request, session.tenantId).withClient((client) => client.storedFile.count({ where: { recordType: 'SubcontractKitLine', recordId: line.id, partyId: order.partyId, status: { not: 'DELETED' } } }))
  if (held >= MAX_KIT_PHOTOS) throw new InvalidStateError(`Kit line ${line.seq} holds ${MAX_KIT_PHOTOS} of your photos already: write to us in the messages.`)
  const answer = await requestUpload(
    processFiles(),
    workshopUploader(request, session.tenantId, order.companyId, order.partyId),
    { companyId: order.companyId, recordType: 'SubcontractKitLine', recordId: line.id, kind: 'PHOTO', originalName: body.originalName, contentType: normaliseContentType(body.contentType), sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE', 'PARTNER'], partyId: order.partyId },
    idempotencyKeyFrom(request),
  )
  return { file: fileOf(answer.file), upload: answer.upload }
}

/** POST /portal/jobs/:id/kit/photos/:fileId/complete. */
export async function completePhoto(request: FastifyRequest, orderId: string, fileId: string) {
  const session = portalSessionOf(request)
  const order = await request.withClient((client) => heldJob(client, session, orderId))
  if (session.preview) throw new ForbiddenError('A preview reads the portal; it never acts for the workshop.')
  if (!mayActOf(request, session, order).upload) throw new ForbiddenError(CAPABILITY_WORDS.upload)
  const kit = await request.withClient((client) => client.subcontractKitLine.findMany({ where: { subcontractOrderId: order.id }, select: { id: true } }))
  const file = isUuid(fileId)
    ? await systemOf(request, session.tenantId).withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'SubcontractKitLine', recordId: { in: kit.map((line) => line.id) }, partyId: order.partyId }, select: { id: true } }))
    : null
  if (!file) throw new NotFoundError('File not found.')
  const view = await completeUpload(processFiles(), workshopUploader(request, session.tenantId, order.companyId, order.partyId), fileId, idempotencyKeyFrom(request))
  return { file: fileOf(view) }
}

// ---- Home ----------------------------------------------------------------------------------------------------------------

/** The workshop Home's counts (platform/portal/home/sources/subcontract-jobs.ts); null without the page (fails closed). */
export async function portalJobCounts(request: FastifyRequest, now: Date): Promise<{ readonly toAccept: number; readonly kitToConfirm: number; readonly readyToSendBack: number; readonly late: number } | null> {
  const session = portalSessionOf(request)
  if (!can(actorOf(requireContext(request)), PORTAL_JOBS_VIEW, { companyId: session.company.id, partyId: session.partyId })) return null
  const list = await listPortalJobs(request, { chip: 'DONE' }, now)
  return list.counts
}

