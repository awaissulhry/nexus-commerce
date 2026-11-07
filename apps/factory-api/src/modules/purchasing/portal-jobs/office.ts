import type { FastifyRequest } from 'fastify'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { dateDecisionProblem, type AcceptInput, type DateDecision, type DeclineInput, type KitCheckInput, type ProgressInput, type ReturnInput } from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { PURCHASING_SUBCONTRACT_MANAGE, PURCHASING_SUBCONTRACT_RECEIVE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import { command, idempotencyKeyFrom, type CommandTools } from '../../../core/command'
import { actorOf, requireContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { dayOf } from '../store'
import { officeOrder } from '../subcontracting/store'
import { acceptInCommand, announceInCommand, cancelNoticeInCommand, checkKitInCommand, decideDateInCommand, declineInCommand, reportInCommand, rowsInCommand, type Who } from './acts'
import { jobLinksOf, jobView, prefillsOf, readJobContext, readJobOrder, readJobRows, type JobContext, type JobRows } from './read'

/**
 * The job on the office's subcontract order (B-W2b-176; design purchasing.subcontracting › Kit "received by the workshop (W2b
 * link or portal)"; Owner answer C3: "the office acts for a terzista without e-mail"):
 *
 *   GET  …/orders/:id/workshop                 purchasing.view: what the workshop said — its answer and our answer to a
 *                                              proposed date, the kit it checked (with its photos), its progress per
 *                                              operation and size, its send-backs (each ANNOUNCED one with the receive back
 *                                              it prefills), the job's links, and how the workshop can be reached
 *   POST …/workshop/date                       purchasing.subcontract.manage: accept or refuse the date it proposed
 *   POST …/workshop/accept | decline | kit | progress | returns
 *                                              purchasing.subcontract.manage: the office writes the workshop's act for it
 *                                              (the name it gave by phone, else the office person's), via OFFICE
 *   POST …/workshop/returns/:noticeId/cancel   purchasing.subcontract.receive: an announced send-back will not come so
 *
 * Every act is the same command as the workshop's (./acts.ts) in the office's scope, with the order's version. Words are the
 * office's (English; the web has its catalogue).
 */

async function officeJob(request: FastifyRequest, orderId: string, permission: Permission) {
  const { context, order: seen } = await officeOrder(request, orderId, permission)
  const order = await request.withClient((client) => readJobOrder(client, seen.id))
  if (!order) throw new NotFoundError('Subcontract order not found.')
  const rows = await request.withClient((client) => readJobRows(client, order))
  const facts = await request.withClient((client) => readJobContext(client, rows, null))
  const user = await request.withClient((client) => client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } }))
  const who: Who = { via: 'OFFICE', personId: context.actorId, name: user?.displayName ?? null }
  return { office: context, rows, facts, who }
}

/** GET /purchasing/subcontracting/orders/:id/workshop. */
export async function workshopView(request: FastifyRequest, orderId: string) {
  const { rows, facts } = await officeJob(request, orderId, PURCHASING_VIEW)
  return answerOf(request, rows, facts)
}

async function answerOf(request: FastifyRequest, rows: JobRows, facts: JobContext) {
  const now = officeAuthOf(request.server).clock.now()
  const { order } = rows
  const actor = actorOf(requireContext(request))
  const scope = { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId }
  const reach = await request.withClient(async (client) => {
    const contacts = await client.partyContact.findMany({ where: { partyId: order.partyId, status: 'ACTIVE', email: { not: null } }, select: { id: true, name: true, email: true, language: true }, orderBy: { name: 'asc' }, take: 20 })
    const settings = await client.portalSettings.findFirst({ where: { partyId: order.partyId }, select: { portalOn: true } })
    const people = await client.user.count({ where: { audience: 'PARTNER', partyId: order.partyId, partnerKind: 'SUBCONTRACTOR', status: 'ACTIVE' } })
    return { contacts: contacts.map((row) => ({ id: row.id, name: row.name, email: row.email!, language: row.language })), portalOn: settings?.portalOn === true, portalPeople: people }
  })
  const job = jobView(rows, facts, 'en')
  const dateProblem = dateDecisionProblem({ status: order.status, proposedDate: dayOf(order.proposedDate), decided: order.proposedDateDecision !== null })
  return {
    job,
    links: await request.withClient((client) => jobLinksOf(client, order.id, now)),
    prefills: prefillsOf(rows),
    reach,
    office: {
      manage: can(actor, PURCHASING_SUBCONTRACT_MANAGE, scope),
      receive: can(actor, PURCHASING_SUBCONTRACT_RECEIVE, scope),
      /** Why the date answer is held (null: it may be given). */
      decideDate: dateProblem,
      /** Why a job link cannot go now (null: it may). */
      sendLink: jobLinkProblem(order),
    },
  }
}

/** Why the job cannot go to the workshop by link now (null: it may): issued and not answered. */
export function jobLinkProblem(order: { readonly status: string; readonly acceptedAt: Date | null; readonly declinedAt: Date | null }): string | null {
  if (order.status === 'DRAFT') return 'Send the order to the workshop first.'
  if (order.acceptedAt) return 'The workshop accepted this job already.'
  if (order.declinedAt) return 'The workshop declined this job.'
  if (order.status !== 'ISSUED' && order.status !== 'AT_WORKSHOP') return `The order is ${order.status.toLowerCase().replace('_', ' ')}: there is nothing to accept any more.`
  return null
}

async function officeAct<Result>(
  request: FastifyRequest,
  orderId: string,
  permission: Permission,
  spec: { readonly name: `${string}.${string}`; readonly version: number; readonly input: unknown },
  work: (tools: CommandTools, rows: JobRows, facts: JobContext, who: Who) => Promise<Result>,
) {
  const { rows, facts, who } = await officeJob(request, orderId, permission)
  await command(
    request,
    { name: spec.name, idempotencyKey: idempotencyKeyFrom(request), input: { orderId, ...(spec.input as object) }, record: { type: 'SubcontractOrder', id: rows.order.id, expectedVersion: spec.version } },
    async (tools) => work(tools, await rowsInCommand(tools, rows.order.id), facts, who),
  )
  const again = await officeJob(request, orderId, PURCHASING_VIEW)
  return answerOf(request, again.rows, again.facts)
}

export const acceptForWorkshop = (request: FastifyRequest, orderId: string, body: AcceptInput & { readonly version: number }) =>
  officeAct(request, orderId, PURCHASING_SUBCONTRACT_MANAGE, { name: 'purchasing.subcontract.jobAcceptForWorkshop', version: body.version, input: body }, (tools, rows, facts, who) => acceptInCommand(tools, rows, facts, body, who))

export const declineForWorkshop = (request: FastifyRequest, orderId: string, body: DeclineInput & { readonly version: number }) =>
  officeAct(request, orderId, PURCHASING_SUBCONTRACT_MANAGE, { name: 'purchasing.subcontract.jobDeclineForWorkshop', version: body.version, input: body }, (tools, rows, facts, who) => declineInCommand(tools, rows, facts, body, who))

export const checkKitForWorkshop = (request: FastifyRequest, orderId: string, body: KitCheckInput & { readonly version: number }) =>
  officeAct(request, orderId, PURCHASING_SUBCONTRACT_MANAGE, { name: 'purchasing.subcontract.kitForWorkshop', version: body.version, input: body }, (tools, rows, facts, who) => checkKitInCommand(tools, rows, facts, body, who))

export const reportForWorkshop = (request: FastifyRequest, orderId: string, body: ProgressInput & { readonly version: number }) =>
  officeAct(request, orderId, PURCHASING_SUBCONTRACT_MANAGE, { name: 'purchasing.subcontract.progressForWorkshop', version: body.version, input: body }, (tools, rows, facts, who) => reportInCommand(tools, rows, facts, body, who))

export const announceForWorkshop = (request: FastifyRequest, orderId: string, body: ReturnInput & { readonly version: number }) =>
  officeAct(request, orderId, PURCHASING_SUBCONTRACT_MANAGE, { name: 'purchasing.subcontract.returnForWorkshop', version: body.version, input: body }, (tools, rows, facts, who) => announceInCommand(tools, rows, facts, body, who))

/** POST …/workshop/date: the office's answer to the date the workshop proposed. */
export const decideDate = (request: FastifyRequest, orderId: string, body: { readonly version: number; readonly decision: DateDecision }) =>
  officeAct(request, orderId, PURCHASING_SUBCONTRACT_MANAGE, { name: 'purchasing.subcontract.jobDate', version: body.version, input: body }, (tools, rows, _facts, who) => {
    if (!who.personId) throw new ForbiddenError('Only an office person answers a proposed date.')
    return decideDateInCommand(tools, rows, body.decision, who.personId)
  })

/** POST …/workshop/returns/:noticeId/cancel: an announced send-back will not come as announced. */
export const cancelNotice = (request: FastifyRequest, orderId: string, noticeId: string, body: { readonly version: number; readonly reason: string }) =>
  officeAct(request, orderId, PURCHASING_SUBCONTRACT_RECEIVE, { name: 'purchasing.subcontract.returnCancel', version: body.version, input: { noticeId, ...body } }, (tools, rows) => cancelNoticeInCommand(tools, rows.order, noticeId, body.reason))
