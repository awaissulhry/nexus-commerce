import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, matchesLinkHash, mintLinkToken, parseLinkToken } from '@nexus/factory-domain/links/token'
import type { ComplaintStatus } from '@nexus/factory-domain/quality/complaints/rules'
import { CASE_LIMITS, CASE_TYPES, complaintRequestProblems, complaintTakesPhotos, OUTCOMES_WANTED, OUTCOME_WANTED_WORDS, returnTakesPhotos, sentWords, type CaseType } from '@nexus/factory-domain/sales/portal-returns/rules'
import type { ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import { idempotencyKeyFrom, type CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type RequestContext } from '../../../core/context'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { dropLinkDraft } from '../../../platform/links/drafts'
import { deliverLinkMail } from '../../../platform/links/mail'
import { linkCommand, useLink } from '../../../platform/links/use'
import { systemContext } from '../../../platform/outbox/system'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { aboveSoldError, answerByFor, createComplaintInCommand, createRequestInCommand, itemsOf, planRequest, refuse, returnableFor, type ClaimScope, type ComplaintBody, type ReturnRequestBody } from './create'
import { announcePhoto, completePhoto, instructionsPdf, presignOpen, returnPhotoTarget, sharedFile, type OpenMode, type PhotoTarget, type PhotoUpload } from './files'
import { claimMail, claimRecordOf, makeClaimLinkInCommand, type ClaimRecordType } from './office'
import { COMPLAINT_RECORD, LINE_RECORD, readComplaint, readLines, readReturn, RETURN_RECORD, type Place, type Reader } from './store'
import { complaintRecord, listCases, returnReasons, returnRecord } from './views'

/**
 * "Report a problem" by link (B-W2b-192; SAL-334 by link; design links.claim, its screen SCR-197 is B-W2b-198's): a CLAIM
 * link (B-W2b-154/163) names a shipment that left us or an order of the customer, and opens nothing else.
 *
 *   GET  /link/claim                          the sender, the shipment or order, the items that may come back (no price),
 *                                             the reasons and outcomes, the cases this link opened with their next step,
 *                                             and for its complaints the answer letter and the 8D once shared (CO5:01)
 *   POST /link/claim {type, …}                a return request (RMA REQUESTED) or a quality complaint (channel LINK): the
 *                                             request is checked first (a refusal uses nothing), then the link is used
 *                                             (SUBMITTED, a counted use; typed name optional) in the link's own command,
 *                                             then ONE system command makes the case, drops the link's draft (B-W2b-163) and
 *                                             notes the case on the link. A repeat with the same Idempotency-Key replays both.
 *   POST /link/claim/photos (+ /:fileId/complete)  a photo of a case this link opened, while not decided
 *   POST /link/claim/files/:fileId/open       a photo or document of a case this link opened (logged)
 *   GET  /link/claim/returns/:id/instructions  the return instructions PDF of a return it opened, once authorised
 *   POST /link/tracking/claim                 from a tracking link (SHIPMENT_TRACK, "Report a problem"): a claim link for
 *                                             the same shipment, its address once (at most 3 live at a time)
 *
 * The link session reads only its party's own rows; returns and complaints are not partner-readable, so the reads here run in
 * the tenant's system scope, for the link's company and party, and only the cases this link opened (its audit rows).
 * "Ask for a new link" for a dead claim link: renewClaimLink below (platform/links registers it per record type).
 */

const RECORD_TYPES: readonly ClaimRecordType[] = ['Shipment', 'SalesOrder']
// B-W2b-346: exported for the remake by link (returns-outcomes/remake.ts), which opens a case of this link the same way.
export const LINK_CASE_ACTION = 'portalReturns.linkCase'

export function claimLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'CLAIM' || !RECORD_TYPES.includes(link.record.type as ClaimRecordType)) throw linkUnavailable()
  return link
}

const placeOf = (link: LinkSession): Place => ({ companyId: link.companyId, partyId: link.partyId })
const systemOf = (request: FastifyRequest, link: { readonly tenantId: string }): CommandCaller => systemCallerOf(request)(link.tenantId)

/** What the link keeps to: its shipment (and that shipment's order) or its order. */
export async function scopeOf(db: Reader, link: LinkSession): Promise<ClaimScope> {
  if (link.record.type === 'SalesOrder') return { salesOrderId: link.record.id, shipmentId: null }
  const shipment = await db.shipment.findUnique({ where: { id: link.record.id }, select: { salesOrderId: true } })
  return { salesOrderId: shipment?.salesOrderId ?? null, shipmentId: link.record.id }
}

/** The cases this link opened (`type:id`), from the audit rows its submits wrote on it. */
async function casesOfLink(db: Reader, linkId: string): Promise<Set<string>> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'OneOffLink', recordId: linkId, action: LINK_CASE_ACTION }, select: { after: true } })
  return new Set(
    rows.flatMap((row) => {
      const after = (row.after ?? {}) as Record<string, unknown>
      return typeof after.caseType === 'string' && typeof after.caseId === 'string' ? [`${after.caseType}:${after.caseId}`] : []
    }),
  )
}

const localeOf = (value: string | undefined): 'it' | 'en' => (value === 'en' ? 'en' : 'it')

/** GET /link/claim?language= */
export async function linkClaim(app: FastifyInstance, request: FastifyRequest, language?: 'it' | 'en') {
  const link = claimLinkOf(request)
  const now = appClock(app).now()
  const place = placeOf(link)
  const page = await systemOf(request, link).withClient(async (db) => {
    const record = await claimRecordOf(db, link.record.type as ClaimRecordType, link.record.id)
    if (!record || record.partyId !== link.partyId) return null
    const scope = await scopeOf(db, link)
    const company = await db.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } })
    const party = await db.party.findUnique({ where: { id: link.partyId }, select: { language: true } })
    const only = await casesOfLink(db, link.id)
    const options = { seesPrices: false, readsComplaints: true, now }
    const cases = await listCases(db, place, { chip: 'ALL' }, options, only)
    const complaints = []
    for (const item of cases.items) {
      if (item.type !== 'COMPLAINT') continue
      const row = await readComplaint(db, place, item.id)
      if (row) complaints.push(await complaintRecord(db, place, row, { ...options, mayUpload: true }))
    }
    return { record, scope, company, party, cases: cases.items, complaints, items: itemsOf(await returnableFor(db, place, scope, now), false), reasons: await returnReasons(db) }
  })
  if (!page) throw linkUnavailable()
  return {
    sender: { companyName: page.company?.tradeName ?? page.company?.legalName ?? '' },
    record: { type: link.record.type, id: link.record.id, label: page.record.label },
    types: [...CASE_TYPES],
    items: page.items,
    reasons: page.reasons,
    outcomes: OUTCOMES_WANTED.map((code) => ({ code, words: OUTCOME_WANTED_WORDS[code] })),
    cases: page.cases,
    complaints: page.complaints,
    link: { expiresAt: toUtcIso(link.expiresAt), usesLeft: Math.max(0, link.maxUses - link.uses), live: link.expiresAt.getTime() > now.getTime() },
    locale: language ?? localeOf(page.party?.language ?? undefined),
  }
}

export type ClaimBody = { readonly type: CaseType; readonly typedName?: string | null | undefined } & Partial<ReturnRequestBody> & Partial<ComplaintBody>

/** POST /link/claim: the case, then the page with the end state's words. */
export async function submitClaim(app: FastifyInstance, request: FastifyRequest, body: ClaimBody, language?: 'it' | 'en') {
  const link = claimLinkOf(request)
  const place = placeOf(link)
  const system = systemOf(request, link)
  const now = appClock(app).now()
  const scope = await system.withClient((db) => scopeOf(db, link))
  const returnBody: ReturnRequestBody = { lines: body.lines ?? [], outcomeWanted: body.outcomeWanted ?? null, customerRef: body.customerRef ?? null, note: body.note ?? null }
  const complaintBody: ComplaintBody = { description: body.description ?? '', salesOrderLineId: body.salesOrderLineId ?? null, size: body.size ?? null, serial: body.serial ?? null, batchNumber: body.batchNumber ?? null, customerRef: body.customerRef ?? null }
  // Checked before the link is used: a request that cannot go uses nothing.
  if (body.type === 'RETURN') {
    const { problems, aboveSold } = await system.withClient((db) => planRequest(db, place, scope, returnBody, now))
    if (problems.length > 0) refuse(problems, 'The return request cannot be sent like this.')
    if (aboveSold.length > 0) throw aboveSoldError(aboveSold)
  } else {
    const problems = complaintRequestProblems(complaintBody)
    if (problems.length > 0) refuse(problems, 'The complaint cannot be sent like this.')
  }
  const key = idempotencyKeyFrom(request)
  const use = await linkCommand(request, { name: 'portalReturns.claimSubmit', idempotencyKey: key, input: { type: body.type } }, async (tools) => {
    const used = await useLink(tools, request, { action: 'submit', typedName: body.typedName ?? null })
    return { evidenceId: used.evidenceId, usesLeft: used.usesLeft }
  })
  const { result } = await commandOn(app, system, { name: 'portalReturns.claimCase', idempotencyKey: key ? `claim.${createHash('sha256').update(`${link.id}|${key}`).digest('hex').slice(0, 48)}` : undefined, input: { linkId: link.id, ...body } }, async (tools) => {
    const made =
      body.type === 'RETURN'
        ? await createRequestInCommand(tools, place, scope, returnBody, { via: 'LINK', personId: null, linkId: link.id }).then((rma) => ({ caseType: 'RETURN' as const, caseId: rma.returnId, number: rma.number }))
        : await createComplaintInCommand(tools, place, scope, complaintBody, { via: 'LINK', personId: null, linkId: link.id }).then((complaint) => ({ caseType: 'COMPLAINT' as const, caseId: complaint.complaintId, number: complaint.number }))
    await dropLinkDraft(tools, link.id)
    tools.audit({ action: LINK_CASE_ACTION, recordType: 'OneOffLink', recordId: link.id, companyId: link.companyId, after: { caseType: made.caseType === 'RETURN' ? RETURN_RECORD : COMPLAINT_RECORD, caseId: made.caseId, number: made.number, evidenceId: use.result.evidenceId } })
    return made
  })
  const answerBy = await system.withClient((db) => answerByFor(db, place.companyId, now))
  const page = await linkClaim(app, request, language)
  // The page's link counts were read when the request came in: the uses left are the send's.
  return { ...page, link: { ...page.link, usesLeft: use.result.usesLeft }, sent: { type: result.caseType, id: result.caseId, number: result.number, answerBy, words: sentWords(result.caseType, result.number, answerBy) } }
}

/** A case this link opened, or the link's one 404. */
async function linkCase(request: FastifyRequest, link: LinkSession, caseType: CaseType, caseId: string) {
  const place = placeOf(link)
  return systemOf(request, link).withClient(async (db) => {
    const only = await casesOfLink(db, link.id)
    const type = caseType === 'RETURN' ? RETURN_RECORD : COMPLAINT_RECORD
    if (!only.has(`${type}:${caseId}`)) return null
    return caseType === 'RETURN' ? { type: 'RETURN' as const, rma: await readReturn(db, place, caseId), complaint: null } : { type: 'COMPLAINT' as const, rma: null, complaint: await readComplaint(db, place, caseId) }
  })
}

export async function linkClaimPhoto(files: FilesRuntime, request: FastifyRequest, body: PhotoUpload & { readonly caseType: CaseType; readonly caseId: string; readonly lineId?: string | null | undefined }, idempotencyKey?: string) {
  const link = claimLinkOf(request)
  const found = await linkCase(request, link, body.caseType, body.caseId)
  if (!found || (!found.rma && !found.complaint)) throw new NotFoundError('Case not found.')
  let target: PhotoTarget
  if (found.rma) {
    if (!returnTakesPhotos(found.rma.status as ReturnStatus)) throw new InvalidStateError(`Return ${found.rma.number} is decided or closed: no more photos.`)
    target = await systemOf(request, link).withClient((db) => returnPhotoTarget(db, found.rma!, body.lineId))
  } else {
    if (!complaintTakesPhotos(found.complaint!.status as ComplaintStatus)) throw new InvalidStateError(`Complaint ${found.complaint!.number} is answered or closed: no more photos.`)
    target = { type: COMPLAINT_RECORD, id: found.complaint!.id }
  }
  return announcePhoto(files, request, link.tenantId, placeOf(link), target, body, idempotencyKey)
}

export async function linkClaimPhotoDone(files: FilesRuntime, request: FastifyRequest, fileId: string, idempotencyKey?: string) {
  const link = claimLinkOf(request)
  const targets = await systemOf(request, link).withClient(async (db) => {
    const only = await casesOfLink(db, link.id)
    const records = [...only].map((key) => {
      const [type, id] = key.split(':') as [string, string]
      return { type, id }
    })
    const returns = records.filter((record) => record.type === RETURN_RECORD).map((record) => record.id)
    const lines = await readLines(db, returns)
    return [...records, ...lines.map((line) => ({ type: LINE_RECORD, id: line.id }))] as PhotoTarget[]
  })
  return completePhoto(files, request, link.tenantId, placeOf(link), targets, fileId, idempotencyKey)
}

/** POST /link/claim/files/:fileId/open {mode}: a file of a case this link opened (shared with the party), logged. */
export async function linkClaimFile(files: FilesRuntime, app: FastifyInstance, request: FastifyRequest, fileId: string, body: { readonly mode: OpenMode }) {
  const link = claimLinkOf(request)
  const place = placeOf(link)
  const system = systemOf(request, link)
  const row = await system.withClient(async (db) => {
    const only = await casesOfLink(db, link.id)
    const returns = [...only].filter((key) => key.startsWith(`${RETURN_RECORD}:`)).map((key) => key.split(':')[1]!)
    const lines = await readLines(db, returns)
    const records = [...[...only].map((key) => ({ type: key.split(':')[0]!, id: key.split(':')[1]! })), ...lines.map((line) => ({ type: LINE_RECORD, id: line.id }))]
    return sharedFile(db, place, records, fileId)
  })
  if (!row) throw new NotFoundError('File not found.')
  await commandOn(app, system, { name: 'portalReturns.linkOpenFile', input: { fileId, linkId: link.id, mode: body.mode } }, async (tools) => {
    tools.audit({ recordType: 'StoredFile', recordId: row.id, companyId: link.companyId, after: { mode: body.mode, recordType: row.recordType, recordId: row.recordId, linkId: link.id, sha256: row.sha256 } })
    return null
  })
  return presignOpen(files, request, link.tenantId, row, body.mode)
}

export async function linkInstructions(app: FastifyInstance, request: FastifyRequest, returnId: string, language: DocumentLanguage | undefined) {
  const link = claimLinkOf(request)
  const found = isUuid(returnId) ? await linkCase(request, link, 'RETURN', returnId) : null
  if (!found?.rma) throw new NotFoundError('Return not found.')
  return instructionsPdf(request, link.tenantId, found.rma, language ?? 'it', appClock(app).now())
}

/** One case's record by link (the same views as the portal's; its complaints' letters and 8D included). */
export async function linkClaimCase(app: FastifyInstance, request: FastifyRequest, caseType: CaseType, caseId: string) {
  const link = claimLinkOf(request)
  const found = isUuid(caseId) ? await linkCase(request, link, caseType, caseId) : null
  if (!found || (!found.rma && !found.complaint)) throw new NotFoundError('Case not found.')
  const options = { seesPrices: false, readsComplaints: true, now: appClock(app).now() }
  return systemOf(request, link).withClient(async (db) =>
    found.rma ? { return: await returnRecord(db, placeOf(link), found.rma, { ...options, mayRequest: false, mayUpload: true }) } : { complaint: await complaintRecord(db, placeOf(link), found.complaint!, { ...options, mayUpload: true }) },
  )
}

// ---- from a tracking page ------------------------------------------------------------------------------------------------

/** POST /link/tracking/claim: the tracking link's holder asks to report a problem with the same shipment. */
export async function claimFromTracking(app: FastifyInstance, request: FastifyRequest) {
  const tracking = linkSessionOf(request)
  if (tracking.purpose !== 'SHIPMENT_TRACK' || tracking.record.type !== 'Shipment') throw linkUnavailable()
  const system = systemOf(request, tracking)
  const now = appClock(app).now()
  const facts = await system.withClient(async (db) => {
    const record = await claimRecordOf(db, 'Shipment', tracking.record.id)
    if (!record || record.partyId !== tracking.partyId) return null
    const live = await db.oneOffLink.count({ where: { purpose: 'CLAIM', recordType: 'Shipment', recordId: tracking.record.id, createdById: SYSTEM_ACTOR_ID, renewalOfId: null, revokedAt: null, expiresAt: { gt: now } } })
    return { record, live }
  })
  if (!facts) throw linkUnavailable()
  if (facts.live >= CASE_LIMITS.claimLinksFromTracking) throw new InvalidStateError('Links to report a problem with this shipment were made already: use one of them, or ask the sender.')
  const linkId = newId()
  const token = mintLinkToken({ tenantId: tracking.tenantId, partyId: tracking.partyId, linkId })
  const { result } = await commandOn(app, system, { name: 'portalReturns.trackingClaimLink', idempotencyKey: idempotencyKeyFrom(request), input: { trackingLinkId: tracking.id } }, (tools) =>
    makeClaimLinkInCommand(tools, { record: { ...facts.record, type: 'Shipment', id: tracking.record.id }, linkId, tokenHash: linkTokenHash(token.value), to: tracking.email, contactId: null, send: false, via: 'TRACKING', createdById: SYSTEM_ACTOR_ID, mail: () => ({ subject: '' }), locale: 'it', sender: null }),
  )
  return { link: { id: result.linkId, expiresAt: result.expiresAt }, url: result.linkId === linkId ? officeAuthOf(app).link('/l', token.value) : null }
}

// ---- "Ask for a new link" ------------------------------------------------------------------------------------------------

function asContext(request: FastifyRequest, context: RequestContext): FastifyRequest {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

const RENEW_COALESCE_MS = 10 * 60_000

/**
 * The renewer of a dead claim link (B-W2b-163's registerLinkRenewer, after POST /link/renew answered): the token's link in
 * its tenant's system scope; a claim link that is used up or expired (never a withdrawn one), sent to an address that is
 * still an active contact's of the customer, with no live claim link of the same record to that address and none renewed
 * in the last 10 minutes → a new claim link to the same address, mailed (FAKE locally). The outcome code is only logged.
 */
export async function renewClaimLink(email: EmailRuntime, request: FastifyRequest, header: unknown): Promise<string> {
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
    if (!link || link.partyId !== token.partyId || !matchesLinkHash(token, link.tokenHash)) return null
    const record = RECORD_TYPES.includes(link.recordType as ClaimRecordType) ? await claimRecordOf(client, link.recordType as ClaimRecordType, link.recordId) : null
    const onFile = link.email ? await client.partyContact.count({ where: { partyId: link.partyId, status: 'ACTIVE', email: { equals: link.email, mode: 'insensitive' } } }) : 0
    const others = link.email
      ? await client.oneOffLink.findMany({ where: { purpose: 'CLAIM', recordType: link.recordType, recordId: link.recordId, email: link.email!, id: { not: link.id } }, select: { revokedAt: true, uses: true, maxUses: true, expiresAt: true, createdAt: true } })
      : []
    const company = await client.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } })
    const party = await client.party.findUnique({ where: { id: link.partyId }, select: { language: true } })
    return { link, record, onFile, others, company, party }
  })
  if (!found || found.link.purpose !== 'CLAIM') return 'UNKNOWN'
  const { link, record } = found
  const state = linkState(link, now)
  if (state === 'REVOKED') return 'WITHDRAWN'
  if (state === 'LIVE') return 'STILL_LIVE'
  if (!record) return 'NOTHING_TO_SHARE'
  if (!link.email) return 'NO_ADDRESS'
  if (found.onFile === 0) return 'ADDRESS_NOT_ON_FILE'
  if (found.others.some((other) => linkState(other, now) === 'LIVE')) return 'NEWER_LINK'
  if (found.others.some((other) => other.createdAt.getTime() > now.getTime() - RENEW_COALESCE_MS)) return 'ASKED_RECENTLY'
  const locale = localeOf(found.party?.language ?? undefined)
  const companyName = found.company?.tradeName ?? found.company?.legalName ?? ''
  const linkId = newId()
  const fresh = mintLinkToken({ tenantId: token.tenantId, partyId: link.partyId, linkId })
  const mail = (expiresAt: Date) => claimMail(locale, { companyName, label: record.label, expiresAt }, '')
  const { result } = await commandOn(request.server, system, { name: 'portalReturns.renewClaimLink', input: { linkId: link.id } }, (tools) =>
    makeClaimLinkInCommand(tools, { record: { ...record, type: link.recordType as ClaimRecordType, id: link.recordId }, linkId, tokenHash: linkTokenHash(fresh.value), to: link.email, contactId: link.contactId, send: true, via: 'OFFICE', createdById: SYSTEM_ACTOR_ID, renewalOfId: link.id, mail, locale, sender: null }),
  )
  if (!result.outboundId) return 'NO_ADDRESS'
  const url = officeAuthOf(request.server).link('/l', fresh.value)
  const text = claimMail(locale, { companyName, label: record.label, expiresAt: new Date(result.expiresAt) }, url).body
  await deliverLinkMail(email, system, result.outboundId, text, null, clock)
  return 'SENT'
}
