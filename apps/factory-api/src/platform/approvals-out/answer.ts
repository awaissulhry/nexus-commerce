import type { FastifyInstance, FastifyRequest } from 'fastify'
import { KIND_RULES, type ApprovalDecision, type ApprovalKind, type ApprovalLocale, type ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { PORTAL_APPROVALS_VIEW } from '@nexus/factory-domain/approvals-out/permissions'
import { answerHeld, answerProblems, answerWords, markupDraftProblems, markupShapesOf, typedNameOf, type MarkupDraft } from '@nexus/factory-domain/approvals-out/rules'
import { PORTAL_APPROVE } from '@nexus/factory-domain/auth/partners/permissions'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { cleanNote, markupTargetOf } from '@nexus/factory-domain/files/markup/rules'
import { userAgentOf } from '@nexus/factory-domain/links/evidence'
import { PORTAL_SALES_ORDERS_VIEW } from '@nexus/factory-domain/sales/portal-orders/permissions'
import { idempotencyKeyFrom, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, requireContext } from '../../core/context'
import { portalSessionOf } from '../auth/portal/authenticator'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { systemCallerOf } from '../files/files'
import { recordMarkupInCommand } from '../files/markup/markup'
import { linkSessionOf, linkUnavailable } from '../links/authenticator'
import { linkCommand, useLink } from '../links/use'
import { commandOn } from '../portal/tasks/clock'
import { closeTasksInCommand } from '../portal/tasks/store'
import { partnerPage } from './page'
import { adapterOf } from './records'
import { settleRequest } from './settle'
import { localeOf, lockRequest, readPartner, RECORD, refOf, sourceKeyOf, type PartnerRow } from './store'

/**
 * The partner's answer (B-W2b-184; design links.approve "Your decision: approve · approve with comments (where the kind
 * allows) · reject (reason required) · comment · markup on a photo · SignBlock (typed name)", "Decided"): by its APPROVAL link
 * or in its portal, ONE answer per request.
 *
 *   link     GET /link/approval?language= (links.open; the open uses nothing, a mail scanner cannot burn it) ·
 *            POST /link/approval/approve {decision APPROVED | APPROVED_WITH_CHANGES, answer?, typedName, markup?}
 *            (links.approve) · POST /link/approval/refuse {answer, typedName, markup?} (links.refuse)
 *   portal   GET /portal/approvals?state= · GET /portal/approvals/:requestId (portal.approvals.view; a revised order also
 *            portal.salesOrders.view) · POST /portal/approvals/:requestId/answer {decision, answer?, typedName, markup?,
 *            version} (+ portal.approve over the request's company and party; a preview never answers)
 *
 * The answer: the request read in the session's scope, the record's own hold read in the system scope (a newer revision, an
 * answer recorded by hand), the words checked (factory-domain approvals-out/rules); a photo markup first, as the tenant's
 * system with the session's party (files/markup recordMarkupInCommand: an overlay on the request's own file, the party's
 * marks; its own command, its key derived from the answer's); then ONE command in the session's OWN scope
 * (factory_partner_runtime): the request locked and checked again, the link used (evidence APPROVED or REFUSED, typed name,
 * address hash, user agent) for a link, the request answered (time, typed name, words, markup file, who: the link or the
 * portal person, evidence: the request id, the address hash, the user agent), the record's own answer (a concession,
 * recordedById null), the partner's task done, the audit row and approval_request.answered. Then the office's side in the
 * system scope (./settle.ts): the consequence, the thread, the receipt mail. The page comes back with the decided words.
 */

export interface AnswerBody {
  readonly decision: ApprovalDecision
  readonly answer?: string | null | undefined
  readonly typedName: string
  readonly markup?: MarkupDraft | null | undefined
  readonly version?: number | undefined
}

interface Answerer {
  readonly via: 'LINK' | 'PORTAL'
  readonly tenantId: string
  readonly partyId: string
  /** The portal person; null for a link. */
  readonly userId: string | null
  readonly locale: ApprovalLocale
}

const clockOf = (app: FastifyInstance) => officeAuthOf(app).clock

/** Reads the request as the session sees it, and the record's own hold as the system does. */
async function prepare(app: FastifyInstance, request: FastifyRequest, who: Answerer, requestId: string, body: AnswerBody) {
  const row = await request.withClient((client) => readPartner(client, requestId))
  if (!row || row.partyId !== who.partyId) throw who.via === 'LINK' ? linkUnavailable() : new NotFoundError('Approval request not found.')
  const kind = row.kind as ApprovalKind
  const now = clockOf(app).now()
  const system = systemCallerOf(request)(who.tenantId)
  const adapter = adapterOf(kind, row.recordType)
  const held = answerHeld({ status: row.status as ApprovalStatus, dueAt: row.dueAt, answeredAt: row.answeredAt, withdrawnAt: row.withdrawnAt }, now, who.locale) ?? (adapter?.answerHeld ? await system.withClient((client) => adapter.answerHeld!(client, refOf(row), who.locale)) : null)
  if (held) throw new InvalidStateError(held)
  const problems = answerProblems({ kind, decision: body.decision, answer: body.answer, typedName: body.typedName })
  let markupFile: { id: string; companyId: string | null; recordType: string; recordId: string } | null = null
  if (body.markup) {
    const file = isUuid(body.markup.fileId)
      ? await system.withClient((client) => client.storedFile.findUnique({ where: { id: body.markup!.fileId }, select: { id: true, companyId: true, recordType: true, recordId: true, contentType: true, status: true, supersededAt: true } }))
      : null
    if (!file || file.recordType !== RECORD || file.recordId !== row.id || file.status !== 'AVAILABLE' || file.supersededAt !== null) problems.push({ path: 'body/markup/fileId', message: 'Mark one of the photos or files of this request.' })
    else {
      problems.push(...markupDraftProblems(body.markup, markupTargetOf(file.contentType)))
      markupFile = file
    }
  }
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The answer is not complete.', problems)
  return { row, kind, system, markupFile }
}

/** The answer itself, in the session's own command (the link's, or the portal person's). */
async function answerInCommand(tools: CommandTools, request: FastifyRequest, who: Answerer, prepared: Awaited<ReturnType<typeof prepare>>, body: AnswerBody) {
  const { row, kind } = prepared
  const current = await lockRequest(tools.tx, row.id, who.via === 'PORTAL' ? body.version : undefined)
  const again = answerHeld({ status: current.status as ApprovalStatus, dueAt: current.dueAt, answeredAt: current.answeredAt, withdrawnAt: current.withdrawnAt }, tools.now, who.locale)
  if (again) throw new InvalidStateError(again)
  const link = who.via === 'LINK' ? linkSessionOf(request) : null
  if (link) await useLink(tools, request, { action: body.decision === 'REFUSED' ? 'refuse' : 'approve', typedName: body.typedName })
  const auth = officeAuthOf(request.server)
  const typedName = typedNameOf(body)
  const words = answerWords(body)
  const { count } = await tools.tx.approvalRequest.updateMany({
    where: { id: row.id, status: 'OPEN', version: current.version },
    data: {
      status: body.decision,
      answer: words,
      typedName,
      markupFileId: prepared.markupFile?.id ?? null,
      answeredAt: tools.now,
      answeredByUserId: who.userId,
      answeredViaLinkId: link?.id ?? null,
      answerRequestId: tools.context.requestId,
      answerIpHash: auth.secrets.ipHash(request.ip),
      answerUserAgent: userAgentOf(request.headers['user-agent']),
      version: current.version + 1,
      updatedAt: tools.now,
    },
  })
  if (count !== 1) throw new InvalidStateError('This request is answered already.')
  const answered = { ...refOf(current), status: body.decision, answer: words, typedName, answeredAt: tools.now }
  const adapter = adapterOf(kind, row.recordType)
  if (adapter?.onAnswered) await adapter.onAnswered(tools, answered)
  await closeTasksInCommand(tools, { recordType: RECORD, recordId: row.id, sourceKey: sourceKeyOf(row.id), status: 'DONE', doneById: who.userId })
  tools.audit({
    action: 'approvalsOut.answer',
    recordType: RECORD,
    recordId: row.id,
    companyId: row.companyId,
    before: { status: 'OPEN' },
    after: { status: body.decision, via: who.via, typedName, answered: words !== null, markupFileId: prepared.markupFile?.id ?? null, personId: who.userId, linkId: link?.id ?? null },
  })
  tools.emit({ type: 'approval_request.answered', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, kind, recordType: row.recordType, recordId: row.recordId, partyId: row.partyId, status: body.decision, via: who.via, markedUp: prepared.markupFile !== null } })
  return null
}

/** The marks on the photo, before the answer: the party's overlay on the request's own file (the tenant's system writes it). */
async function markupFirst(app: FastifyInstance, who: Answerer, prepared: Awaited<ReturnType<typeof prepare>>, markup: MarkupDraft, idempotencyKey: string | undefined) {
  const file = prepared.markupFile!
  await commandOn(app, prepared.system, { name: 'approvalsOut.markup', idempotencyKey: idempotencyKey ? `${idempotencyKey}:markup` : undefined, input: { requestId: prepared.row.id, markup } }, async (tools) => {
    await recordMarkupInCommand(tools, file, { page: markup.page, shapes: markupShapesOf(markup), note: cleanNote(markup.note), resultFileId: null, partyId: who.partyId, createdById: who.userId })
    return null
  })
}

async function answer(app: FastifyInstance, request: FastifyRequest, who: Answerer, requestId: string, body: AnswerBody, run: (work: (tools: CommandTools) => Promise<null>) => Promise<unknown>) {
  const prepared = await prepare(app, request, who, requestId, body)
  const idempotencyKey = idempotencyKeyFrom(request)
  if (body.markup && prepared.markupFile) await markupFirst(app, who, prepared, body.markup, idempotencyKey)
  await run((tools) => answerInCommand(tools, request, who, prepared, body))
  const settled = await settleRequest(prepared.system, requestId, clockOf(app), who.locale)
  const row = (await request.withClient((client) => readPartner(client, requestId)))!
  return { ...(await partnerPage(prepared.system, row, who.locale, clockOf(app).now())), receipt: settled.receipt }
}

// ---- the link -----------------------------------------------------------------------------------------------------------

function approvalLink(request: FastifyRequest) {
  const link = linkSessionOf(request)
  if (link.purpose !== 'APPROVAL' || link.record.type !== RECORD) throw linkUnavailable()
  return link
}

async function linkLocale(request: FastifyRequest, tenantId: string, row: PartnerRow | null, language: ApprovalLocale | undefined): Promise<ApprovalLocale> {
  if (language) return language
  if (!row) return 'it'
  const system = systemCallerOf(request)(tenantId)
  const language2 = await system.withClient(async (client) => (row.contactId ? (await client.partyContact.findFirst({ where: { id: row.contactId }, select: { language: true } }))?.language : null) ?? (await client.party.findUnique({ where: { id: row.partyId }, select: { language: true } }))?.language)
  return localeOf(language2)
}

/** GET /link/approval. */
export async function linkApproval(app: FastifyInstance, request: FastifyRequest, language?: ApprovalLocale) {
  const link = approvalLink(request)
  const row = await request.withClient((client) => readPartner(client, link.record.id))
  if (!row) throw linkUnavailable()
  const locale = await linkLocale(request, link.tenantId, row, language)
  const page = await partnerPage(systemCallerOf(request)(link.tenantId), row, locale, clockOf(app).now())
  return { ...page, link: { expiresAt: toUtcIso(link.expiresAt), usesLeft: Math.max(0, link.maxUses - link.uses) } }
}

/** POST /link/approval/approve and /link/approval/refuse. */
export async function answerByLink(app: FastifyInstance, request: FastifyRequest, body: AnswerBody, language?: ApprovalLocale) {
  const link = approvalLink(request)
  const row = await request.withClient((client) => readPartner(client, link.record.id))
  const locale = await linkLocale(request, link.tenantId, row, language)
  const who: Answerer = { via: 'LINK', tenantId: link.tenantId, partyId: link.partyId, userId: null, locale }
  const page = await answer(app, request, who, link.record.id, body, (work) =>
    linkCommand(request, { name: 'approvalsOut.answer', idempotencyKey: idempotencyKeyFrom(request), input: { requestId: link.record.id, ...body } }, work),
  )
  return { ...page, link: { expiresAt: toUtcIso(link.expiresAt), usesLeft: 0 } }
}

// ---- the portal ---------------------------------------------------------------------------------------------------------

/** The page permission of a kind beside portal.approvals.view: a revised order shows the order's lines. */
const pageNeeds = (kind: ApprovalKind): readonly Permission[] => (KIND_RULES[kind].task === 'RECONFIRM_ORDER' ? [PORTAL_APPROVALS_VIEW, PORTAL_SALES_ORDERS_VIEW] : [PORTAL_APPROVALS_VIEW])

function portalWho(request: FastifyRequest): Answerer & { readonly companyId: string; readonly preview: boolean; readonly caller: CommandCaller } {
  const session = portalSessionOf(request)
  return { via: 'PORTAL', tenantId: session.tenantId, partyId: session.partyId, userId: session.userId, locale: localeOf(session.person.locale), companyId: session.company.id, preview: session.preview, caller: request }
}

const sees = (request: FastifyRequest, row: { readonly kind: string; readonly companyId: string; readonly partyId: string }): boolean => {
  const actor = actorOf(requireContext(request))
  return pageNeeds(row.kind as ApprovalKind).every((permission) => can(actor, permission, { companyId: row.companyId, partyId: row.partyId }))
}

/** GET /portal/approvals?state=OPEN|DONE: what we ask the organisation (OPEN), or what it answered or no longer waits (DONE). */
export async function portalApprovals(app: FastifyInstance, request: FastifyRequest, state: 'OPEN' | 'DONE' = 'OPEN') {
  const who = portalWho(request)
  const rows = await request.withClient((client) =>
    client.approvalRequest.findMany({
      where: { companyId: who.companyId, status: state === 'OPEN' ? 'OPEN' : { not: 'OPEN' } },
      orderBy: state === 'OPEN' ? [{ dueAt: 'asc' }, { id: 'asc' }] : [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true },
    }),
  )
  const items = []
  const system = systemCallerOf(request)(who.tenantId)
  const now = clockOf(app).now()
  for (const { id } of rows) {
    const row = (await request.withClient((client) => readPartner(client, id)))!
    if (!sees(request, row)) continue
    const page = await partnerPage(system, row, who.locale, now)
    items.push({ id: row.id, kind: page.request.kind, words: page.request.words, question: row.question, dueAt: page.request.dueAt, status: page.request.status, decided: page.request.decided })
  }
  return { state, items }
}

async function portalRow(request: FastifyRequest, requestId: string): Promise<PartnerRow> {
  const who = portalWho(request)
  const row = isUuid(requestId) ? await request.withClient((client) => readPartner(client, requestId)) : null
  if (!row || row.companyId !== who.companyId || !sees(request, row)) throw new NotFoundError('Approval request not found.')
  return row
}

/** GET /portal/approvals/:requestId. */
export async function portalApproval(app: FastifyInstance, request: FastifyRequest, requestId: string) {
  const who = portalWho(request)
  const row = await portalRow(request, requestId)
  const page = await partnerPage(systemCallerOf(request)(who.tenantId), row, who.locale, clockOf(app).now())
  const mayApprove = !who.preview && can(actorOf(requireContext(request)), PORTAL_APPROVE, { companyId: row.companyId, partyId: row.partyId })
  return { ...page, may: { ...page.may, answer: page.may.answer && mayApprove, withChanges: page.may.withChanges && mayApprove, held: page.may.held ?? (mayApprove ? null : 'Your access lets you read this request, not answer it: ask your admin for the right to approve.') } }
}

/** POST /portal/approvals/:requestId/answer. */
export async function answerInPortal(app: FastifyInstance, request: FastifyRequest, requestId: string, body: AnswerBody) {
  const who = portalWho(request)
  const row = await portalRow(request, requestId)
  if (who.preview) throw new ForbiddenError('A preview reads the portal; it never answers for the partner.')
  if (!can(actorOf(requireContext(request)), PORTAL_APPROVE, { companyId: row.companyId, partyId: row.partyId })) throw new ForbiddenError('Your access lets you read this request, not answer it: ask your admin for the right to approve.')
  return answer(app, request, who, requestId, body, (work) => commandOn(app, request, { name: 'approvalsOut.answer', idempotencyKey: idempotencyKeyFrom(request), input: { requestId, ...body } }, work))
}
