import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { waitWords } from '@nexus/factory-domain/abuse/policies'
import { readPublicDocCode } from '@nexus/factory-domain/compliance/public-doc/code'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { intakeProblems, PHOTO_TICKET, SAFETY_LIMITS, sentWords } from '@nexus/factory-domain/sales/safety-reports/rules'
import { readFactoryVariables } from '../../../env'
import { abuseGuardOf, abuseKey, networkOf, type ProofInput } from '../../../platform/abuse/guard'
import { portalOf } from '../../../platform/auth/portal/service'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { systemCallerOf } from '../../../platform/files/files'
import { assertOutsideUploadsOpen } from '../../../platform/files/multipart/outside'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { noticeInForce } from '../../../platform/privacy/read'
import { NOT_FOUND_WORDS, pagesUnder } from '../../compliance/public-doc/public-doc'
import { assertMayRequest, assertMayUpload, portalReader } from '../portal-returns/access'
import { refuse } from '../service/open'
import { announceReportPhoto, completeReportPhoto, type PhotoBody } from './files'
import { intakeInCommand, type IntakeBody } from './intake'

/**
 * The doors from outside (B-W2b-351; SAL-414; design links.doc "Report a problem", portal.customer.returns "Report a safety
 * incident"), BOTH OFF until the privacy notice for these reports is published (GATE-PRIVACY; the Owner's switch below):
 *
 *   POST /public/safety-reports                 PUBLIC: the reader of a garment's public DoC page (the code from its QR names
 *                                               the batch, or the style): what happened, the serial when they have it, whether
 *                                               anyone was hurt (the words only after the consent tick), the day and place of an
 *                                               accident, how to reach them. The abuse guard (`public.lookup` per network, a
 *                                               challenge after many) and at most SAFETY_LIMITS.publicPerHour reports a network
 *                                               an hour; an Idempotency-Key is required (a repeat answers the same report). ONE
 *                                               command in the tenant's system scope (the partner has no grant): the report, its
 *                                               SAFETY case, the injury apart, the accident log (./intake.ts). The answer: the
 *                                               number, the words, and a photo ticket (photos after the send).
 *   POST /public/safety-reports/photos (+ /:fileId/complete)   a photo with the ticket the send gave (signed, this report only,
 *                                               for SAFETY_LIMITS.outsidePhotoMinutes), at most SAFETY_LIMITS.photos
 *   GET  /public/safety-reports/status          whether the public door is open (the DoC page draws its "Report a problem")
 *   POST /portal/safety-reports                 a customer's person (portal.returns.view; asking: portal.returns.request): the
 *                                               same report for its party, ONE command in the tenant's office scope as the person
 *   POST /portal/safety-reports/:id/photos (+ /:fileId/complete)  photos after the send: the person's own report, in its window
 *   GET  /portal/safety-reports/status          whether the portal's door is open for this company
 *
 * THE SWITCH: FACTORY_SAFETY_REPORTS_OUTSIDE=on in apps/factory-api's environment (Railway; the Owner's), read through the env
 * loader's variables; anything else, or unset: OFF. With it on, a company still takes reports from outside only while its
 * public privacy notice (Admin › Privacy & notices, PRIVACY_PUBLIC) is in force: the reader can read it before sending. A
 * notice of its own for safety reports (a PrivacyNoticeKind) and a per-company switch are schema needs; the office types a report
 * from a mail meanwhile. Nothing is mailed to the reporter (no mail carries anything of a report).
 */

let forced: boolean | undefined
/** Tests: the switch on or off; undefined goes back to the environment's. */
export function useSafetyReportsOutside(on: boolean | undefined): void {
  forced = on
}
export const outsideSwitchOn = (): boolean => forced ?? readFactoryVariables().FACTORY_SAFETY_REPORTS_OUTSIDE === 'on'

export const OUTSIDE_OFF_WORDS = 'Safety reports cannot be sent here yet: their privacy notice is not published. Write to the maker at the address on this page, or call them.'
export const NO_NOTICE_WORDS = "This company's privacy notice is not published: safety reports cannot be sent here yet. Write to the maker at the address on this page."

const off = (words: string) => new DomainError('invalid_state', words, [{ path: 'held/OFF', message: words }])

/** The door is open for this company: the switch, and its public privacy notice in force. */
async function outsideHeld(db: Pick<FactoryClient, 'privacyNotice'>, companyId: string): Promise<string | null> {
  if (!outsideSwitchOn()) return OUTSIDE_OFF_WORDS
  return (await noticeInForce(db, companyId, 'PRIVACY_PUBLIC')) ? null : NO_NOTICE_WORDS
}

// ---- the photo ticket of the public door ----------------------------------------------------------------------------------

const ticketKey = (app: FastifyInstance): Buffer => abuseKey(officeAuthOf(app).secrets, 'safety-report-photos')
const signature = (key: Buffer, body: string): string => createHmac('sha256', key).update(`safety-report-photos|${body}`, 'utf8').digest('base64url')

export function photoTicket(app: FastifyInstance, tenantId: string, reportId: string, until: Date): string {
  const body = `${tenantId}.${reportId}.${Math.floor(until.getTime() / 1000)}`
  return `${body}.${signature(ticketKey(app), body)}`
}

/** The ticket's tenant and report while it is good; null otherwise (expired, changed, not one). */
export function readTicket(app: FastifyInstance, ticket: unknown, now: Date): { tenantId: string; reportId: string } | null {
  if (typeof ticket !== 'string') return null
  const parts = PHOTO_TICKET.exec(ticket)
  if (!parts) return null
  const [, tenantId, reportId, expires, signed] = parts
  if (Number(expires) * 1000 <= now.getTime()) return null
  const wanted = Buffer.from(signature(ticketKey(app), `${tenantId}.${reportId}.${expires}`), 'utf8')
  const given = Buffer.from(signed!, 'utf8')
  return wanted.length === given.length && timingSafeEqual(wanted, given) ? { tenantId: tenantId!, reportId: reportId! } : null
}

// ---- the public door ------------------------------------------------------------------------------------------------------

export interface PublicBody extends Omit<IntakeBody, 'styleId' | 'colourwayId'> {
  readonly code: string
  readonly n?: number | undefined
  readonly proof?: ProofInput | undefined
}

const HOUR = 60 * 60 * 1000

/** GET /public/safety-reports/status */
export function publicStatus() {
  const open = outsideSwitchOn()
  return { open, words: open ? null : OUTSIDE_OFF_WORDS }
}

/** POST /public/safety-reports */
export async function sendPublicReport(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, body: PublicBody, idempotencyKey: string | undefined) {
  const guard = abuseGuardOf(app)
  await guard.check(request, reply, 'public.lookup', { proof: body.proof })
  if (!outsideSwitchOn()) throw off(OUTSIDE_OFF_WORDS)
  if (!idempotencyKey) throw new ValidationError('Send the report with an Idempotency-Key: a repeat then answers the same report.', [{ path: 'headers/idempotency-key', message: 'Required.' }])
  const code = readPublicDocCode(body.code)
  const found = code ? (await pagesUnder(request, code))[body.n ?? 0] : undefined
  if (!found) {
    await guard.failed(request, 'public.lookup')
    throw new NotFoundError(NOT_FOUND_WORDS)
  }
  const { tenantId, kind, id } = found.match
  const system = systemCallerOf(request)(tenantId)
  // What the QR names: a released batch (its work order's company, style and batch number) or a style (its company, else the page's sender).
  const where = await system.withClient(async (db) => {
    if (kind === 'BATCH') {
      const order = await db.workOrder.findUnique({ where: { id }, select: { companyId: true, styleId: true, batchNumber: true } })
      return order ? { companyId: order.companyId, fixed: { batchNumber: order.batchNumber, styleId: order.styleId } } : null
    }
    const style = await db.style.findUnique({ where: { id }, select: { id: true, companyId: true } })
    return style ? { companyId: style.companyId ?? found.page.sender.companyId, fixed: { styleId: style.id } } : null
  })
  if (!where) throw new NotFoundError(NOT_FOUND_WORDS)
  const closed = await system.withClient((db) => outsideHeld(db, where.companyId))
  if (closed) throw off(closed)
  const { proof: _proof, code: _code, n: _n, ...facts } = body
  // The form's own mistakes are said before anything counts (a reader corrects them); the rest is checked in the command.
  const early = intakeProblems({ ...facts, batchNumber: where.fixed.batchNumber ?? facts.batchNumber }, businessDate(appClock(app).now()), true)
  if (early.length > 0) refuse(early, 'The safety report cannot be sent like this.')
  // At most SAFETY_LIMITS.publicPerHour reports a network an hour (a repeat of the same report counts too).
  const sent = await guard.hit('public.lookup', 'safety-report', networkOf(request.ip), HOUR)
  if (sent.count > SAFETY_LIMITS.publicPerHour) {
    const seconds = Math.max(1, Math.ceil(sent.resetInMs / 1000))
    void reply.header('retry-after', String(seconds))
    throw new DomainError('rate_limited', waitWords(sent.resetInMs), [{ path: 'retryAfter', message: String(seconds) }])
  }
  const { result } = await commandOn(app, system, { name: 'safetyReports.receivePublic', idempotencyKey, input: { code: found.match.id, ...facts } }, (tools) =>
    intakeInCommand(tools, { source: 'PUBLIC_LINK', companyId: where.companyId, partyId: null, contactId: null, receivedAt: tools.now, ownerId: null, actor: { kind: 'system' }, fixed: where.fixed }, facts),
  )
  const until = new Date(appClock(app).now().getTime() + SAFETY_LIMITS.outsidePhotoMinutes * 60_000)
  return {
    sent: { number: result.number, words: sentWords(result.number) },
    photos: { ticket: photoTicket(app, tenantId, result.reportId, until), until: toUtcIso(until), max: SAFETY_LIMITS.photos },
  }
}

/** The report a good ticket names, still taking photos (read as the tenant's system), or the one 404. */
async function ticketReport(app: FastifyInstance, request: FastifyRequest, ticket: string) {
  const guard = abuseGuardOf(app)
  const named = readTicket(app, ticket, appClock(app).now())
  const report = named ? await systemCallerOf(request)(named.tenantId).withClient((db) => db.productSafetyReport.findUnique({ where: { id: named.reportId }, select: { id: true, number: true, companyId: true, status: true, source: true } })) : null
  if (!named || !report || report.source !== 'PUBLIC_LINK' || report.status === 'CLOSED') {
    await guard.failed(request, 'public.lookup')
    throw new NotFoundError('This photo link has expired: write to the maker at the address on the page.')
  }
  return { tenantId: named.tenantId, report }
}

/** POST /public/safety-reports/photos */
export async function publicPhoto(app: FastifyInstance, request: FastifyRequest, body: PhotoBody & { readonly ticket: string }, idempotencyKey?: string) {
  if (!outsideSwitchOn()) throw off(OUTSIDE_OFF_WORDS)
  const { tenantId, report } = await ticketReport(app, request, body.ticket)
  // B-W2b-160 (FV1:02): an upload from outside waits for the virus scanner in a live environment (GATE-SPEND).
  assertOutsideUploadsOpen()
  const { ticket: _ticket, ...photo } = body
  return announceReportPhoto(request, tenantId, report, photo, idempotencyKey)
}

/** POST /public/safety-reports/photos/:fileId/complete */
export async function publicPhotoDone(app: FastifyInstance, request: FastifyRequest, fileId: string, body: { readonly ticket: string }, idempotencyKey?: string) {
  const { tenantId, report } = await ticketReport(app, request, body.ticket)
  return completeReportPhoto(request, tenantId, report, fileId, idempotencyKey)
}

// ---- the portal's door ----------------------------------------------------------------------------------------------------

/** GET /portal/safety-reports/status */
export async function portalStatus(app: FastifyInstance, request: FastifyRequest) {
  const reader = portalReader(app, request)
  const closed = await reader.inTenant((db) => outsideHeld(db, reader.place.companyId))
  return { open: closed === null && reader.mayRequest, words: closed, mayRequest: reader.mayRequest, mayUpload: reader.mayUpload }
}

export type PortalBody = Omit<IntakeBody, 'styleId' | 'colourwayId'>

/** POST /portal/safety-reports */
export async function sendPortalReport(app: FastifyInstance, request: FastifyRequest, body: PortalBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  assertMayRequest(reader)
  const closed = await reader.inTenant((db) => outsideHeld(db, reader.place.companyId))
  if (closed) throw off(closed)
  // The person's own contact of the customer, when one has their address.
  const contact = await reader.inTenant((db) =>
    db.partyContact.findFirst({ where: { partyId: reader.place.partyId, email: { equals: reader.session.person.email, mode: 'insensitive' }, status: 'ACTIVE', erasedAt: null }, select: { id: true }, orderBy: { id: 'asc' } }),
  )
  const auth = portalOf(app).auth
  const { result } = await auth.command(auth.contextFor(request, reader.session.tenantId, reader.session.userId), { name: 'safetyReports.receivePortal', idempotencyKey, input: { ...body, sessionId: reader.session.id } }, (tools) =>
    intakeInCommand(tools, { source: 'PORTAL', companyId: reader.place.companyId, partyId: reader.place.partyId, contactId: contact?.id ?? null, receivedAt: tools.now, ownerId: null, actor: { kind: 'portal', userId: reader.session.userId } }, body),
  )
  const until = new Date(appClock(app).now().getTime() + SAFETY_LIMITS.outsidePhotoMinutes * 60_000)
  return { report: { id: result.reportId, number: result.number }, sent: { number: result.number, words: sentWords(result.number) }, photos: { until: toUtcIso(until), max: SAFETY_LIMITS.photos, mayUpload: reader.mayUpload } }
}

/** The person's own portal report, still taking photos (its window, not closed), read as the person. */
async function ownPortalReport(app: FastifyInstance, request: FastifyRequest, reportId: string) {
  const reader = portalReader(app, request)
  assertMayUpload(reader)
  if (!isUuid(reportId)) throw new NotFoundError('Safety report not found.')
  const since = new Date(appClock(app).now().getTime() - SAFETY_LIMITS.outsidePhotoMinutes * 60_000)
  const report = await reader.inTenant((db) =>
    db.productSafetyReport.findFirst({
      where: { id: reportId, source: 'PORTAL', companyId: reader.place.companyId, partyId: reader.place.partyId, createdById: reader.session.userId, status: { not: 'CLOSED' }, receivedAt: { gte: since } },
      select: { id: true, number: true, companyId: true },
    }),
  )
  if (!report) throw new NotFoundError('Safety report not found, or its time for photos is over: write to us in the messages.')
  return { tenantId: reader.session.tenantId, report }
}

/** POST /portal/safety-reports/:reportId/photos */
export async function portalPhoto(app: FastifyInstance, request: FastifyRequest, reportId: string, body: PhotoBody, idempotencyKey?: string) {
  const { tenantId, report } = await ownPortalReport(app, request, reportId)
  assertOutsideUploadsOpen()
  return announceReportPhoto(request, tenantId, report, body, idempotencyKey)
}

/** POST /portal/safety-reports/:reportId/photos/:fileId/complete */
export async function portalPhotoDone(app: FastifyInstance, request: FastifyRequest, reportId: string, fileId: string, idempotencyKey?: string) {
  const { tenantId, report } = await ownPortalReport(app, request, reportId)
  return completeReportPhoto(request, tenantId, report, fileId, idempotencyKey)
}

