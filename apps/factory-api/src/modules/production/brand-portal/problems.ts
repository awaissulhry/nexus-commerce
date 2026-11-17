import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { PORTAL_COMMENT } from '@nexus/factory-domain/auth/partners/permissions'
import { DomainError, ForbiddenError, isDomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { productionIssueRaised } from '@nexus/factory-domain/production-brand/events'
import { ESCALATION_ROLE_KEYS, firstTaker, PROBLEM_WORDS, problemTaskWords } from '@nexus/factory-domain/production-brand/issues'
import { problemWords } from '@nexus/factory-domain/production-brand/portal-read'
import { ORDER_NOT_FOUND_WORDS } from '@nexus/factory-domain/production-brand/words'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { excerptOf } from '@nexus/factory-domain/threads/rules'
import { partnerThreadWords } from '@nexus/factory-domain/threads/partner/rules'
import type { CommandTools } from '../../../core/command'
import { systemCallerOf } from '../../../platform/files/files'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { postPartnerMessage } from '../../../platform/threads/partner/service'
import { portalReader, type PortalReader } from '../../sales/portal-orders/access'
import { isKeptState } from '../brand/facts'
import { issueDueOn } from '../issues/raise'
import { localeOf, roleHolders, takesIssueTask, writeSystemTask, type TaskRecord } from '../issues/tasks'
import { supervisorOfOrder } from '../supervisor/resolver'

/**
 * B-PR-45 — the customer reports a problem (production plan §1 "Report a problem on one or many orders: it lands in each order's
 * thread and reaches that order's supervisor as ONE task per batch. The brand sees 'Waiting on us since …' until we really reply
 * in the thread", §3 "Issues"; lead picks L24, L25; review fixes R-41, R-42, R-43, R-48; the Owner rule 2026-11-16: "One brand
 * must not be able to see anything related to any other brand. But we, as the production unit, should be able to see it all.
 * And manage it all as well.").
 *
 *   POST /portal/production/problems   {orderIds 1–50, body}: portal.production.view (manifest) and portal.comment over the
 *                                      session's party (the words of the thread's own refusal), never a preview
 *
 *   1. the partner read: its own orders among the ids, in the portal's company (row-level security by party). An id that is not
 *      one of its own orders is neither acted on nor named, only counted (`notFound`); none of its own: 404 "Order not found.";
 *      an own order no longer in production is refused in words ("write in its conversation")
 *   2. per order, ONE portal message in the order's own thread — threads' `postPartnerMessage` (T5), the same INBOUND PORTAL
 *      post by the person's name as the thread's own composer, with that command's own Idempotency-Key derived from the
 *      request's and the order (a retry with the same key replays the same message); a refusal of the thread (closed …) is that
 *      order's result in its words, the others go on
 *   3. ONE system command keyed by the messages (a retry makes no second issue; a message that already carries an issue is
 *      never raised twice): per posted order a ProductionIssue (source BRAND, the order's company and customer, the message),
 *      all of one batch, and ONE Task for the batch — on the FIRST order (a sales order: it carries the customer's wall), its
 *      description listing the others — for the first who may take it of: the order's production supervisor
 *      (../supervisor/resolver), the customer's backup, the production managers; checked on the order itself (reads its thread,
 *      may hold a task: PW-17), else nobody's yet (the escalation still finds it); due at raise + 1 working day, 08:00 company
 *      time (raise.ts issueDueOn, R-44); one production_issue.raised per issue (office live rule, no partner entry: R-48, PW-15)
 *      and one audit row per batch
 *
 * The answer names no person (R-41: the customer is never told who supervises; whoever answers in the thread signs with their
 * name, as today): each order's result and "Waiting on us since <today>". Answering is B-PR-43b's (../issues/answered.ts: the
 * first shared office message after the raise in any order of the batch answers them all); escalation ../issues/escalate.ts.
 */

export interface ProblemBody {
  readonly orderIds: readonly string[]
  readonly body: string
}

interface OwnOrder {
  readonly orderId: string
  readonly number: string
  readonly customerRef: string | null
  readonly status: string
  readonly index: number
}

/** The ids named twice (400: each order once). */
function twiceProblems(orderIds: readonly string[]): Issue[] {
  const seen = new Set<string>()
  const issues: Issue[] = []
  orderIds.forEach((orderId, index) => {
    if (seen.has(orderId)) issues.push({ path: `body/orderIds/${index}`, message: 'This order is named twice.' })
    seen.add(orderId)
  })
  return issues
}

/** Its own orders among these ids, in the portal's company (the partner scope: another customer's order is not found here). */
async function ownOrders(request: FastifyRequest, reader: PortalReader, orderIds: readonly string[]): Promise<OwnOrder[]> {
  const rows = await request.withClient((client) =>
    client.salesOrder.findMany({ where: { id: { in: [...orderIds] }, companyId: reader.session.company.id }, select: { id: true, number: true, customerRef: true, status: true, partyId: true } }),
  )
  // The wall: only the session's party's (row-level security already keeps it so).
  const byId = new Map(rows.filter((row) => row.partyId === reader.session.partyId).map((row) => [row.id, row]))
  return orderIds.flatMap((orderId, index) => {
    const row = byId.get(orderId)
    return row ? [{ orderId, number: row.number, customerRef: row.customerRef, status: row.status, index }] : []
  })
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The Idempotency-Key of one order's post: the request's and the order (the same request, the same message). */
const postKeyOf = (key: string | undefined, orderId: string): string | undefined => (key ? `problem-post-${sha(`${key}|${orderId}`).slice(0, 48)}` : undefined)
/** The key of the raise: the messages themselves (the same messages never raise twice). */
const raiseKeyOf = (messageIds: readonly string[]): string => `problem-raise-${sha([...messageIds].sort().join('|')).slice(0, 48)}`

export interface ProblemResult {
  readonly orderId: string
  readonly number: string
  readonly customerRef: string | null
  readonly done: boolean
  /** Why it was not sent (null: sent). */
  readonly words: Words | null
  /** Sent: the order's problem as it reads it now ("Waiting on us since …"). */
  readonly problem: { readonly state: 'WAITING_ON_US'; readonly since: BusinessDate; readonly words: Words } | null
}

const refusedResult = (order: OwnOrder, words: Words): ProblemResult => ({ orderId: order.orderId, number: order.number, customerRef: order.customerRef, done: false, words, problem: null })

/** A thread's refusal of one order's post, in words the customer may read (they never name anyone). */
function refusalWords(error: DomainError): Words {
  if (error instanceof NotFoundError) return ORDER_NOT_FOUND_WORDS
  const text = error.message.trim()
  return text ? { it: text, en: text } : PROBLEM_WORDS.NOT_SENT
}

/** POST /portal/production/problems */
export async function reportProblem(app: FastifyInstance, request: FastifyRequest, body: ProblemBody, idempotencyKey: string | undefined) {
  const twice = twiceProblems(body.orderIds)
  if (twice.length > 0) throw new ValidationError('Name each order once.', twice)
  const reader = portalReader(app, request)
  const { session } = reader
  if (session.preview) throw new ForbiddenError(partnerThreadWords('PREVIEW', session.person.locale, session.company.name))
  if (!can(reader.actor, PORTAL_COMMENT, { companyId: session.company.id, partyId: session.partyId })) throw new ForbiddenError(partnerThreadWords('NO_COMMENT', session.person.locale, session.company.name))
  const orders = await ownOrders(request, reader, body.orderIds)
  // A foreign id is neither acted on nor named: only counted; none of its own → the words of an unknown order.
  const notFound = body.orderIds.length - orders.length
  if (orders.length === 0) throw new NotFoundError(ORDER_NOT_FOUND_WORDS.en)

  // 2. One portal message per order, in its own thread (threads' own command each; one after the other).
  const results = new Map<string, ProblemResult>()
  const posted: { order: OwnOrder; messageId: string }[] = []
  for (const order of orders) {
    if (!isKeptState(order.status)) {
      results.set(order.orderId, refusedResult(order, PROBLEM_WORDS.NOT_IN_PRODUCTION))
      continue
    }
    try {
      const { message } = await postPartnerMessage(request, { type: 'SalesOrder', id: order.orderId }, { body: body.body }, postKeyOf(idempotencyKey, order.orderId))
      posted.push({ order, messageId: message.id })
    } catch (error) {
      if (!isDomainError(error)) throw error
      results.set(order.orderId, refusedResult(order, refusalWords(error)))
    }
  }
  if (posted.length === 0) {
    const issues = orders.map((order) => ({ path: `body/orderIds/${order.index}`, message: results.get(order.orderId)?.words?.en ?? PROBLEM_WORDS.NOT_SENT.en }))
    throw new DomainError('conflict', PROBLEM_WORDS.NONE_SENT.en, issues)
  }

  // 3. The issues and the batch's one task, in the tenant's system scope (ProductionIssue and Task are the office's tables).
  const input = { partyId: session.partyId, companyId: session.company.id, userId: session.userId, orders: posted.map((entry) => ({ orderId: entry.order.orderId, messageId: entry.messageId })), body: body.body }
  const system = systemCallerOf(request)(session.tenantId)
  const { result, replayed } = await commandOn(app, system, { name: 'portal.production.reportProblem', idempotencyKey: raiseKeyOf(input.orders.map((entry) => entry.messageId)), input }, (tools) => raiseProblemsInCommand(tools, { ...input, tenantId: session.tenantId }))
  const since = businessDate(new Date(result.raisedAt))
  for (const { order } of posted) {
    const problem = { state: 'WAITING_ON_US' as const, since }
    results.set(order.orderId, { orderId: order.orderId, number: order.number, customerRef: order.customerRef, done: true, words: null, problem: { ...problem, words: problemWords(problem) } })
  }
  return { batchId: result.batchId, results: orders.map((order) => results.get(order.orderId)!), notFound, replayed }
}

export interface RaiseProblems {
  readonly tenantId: string
  readonly partyId: string
  readonly companyId: string
  /** The portal person who reported (the issues' maker). */
  readonly userId: string
  /** The posted orders in the order the customer named them, each with its message. */
  readonly orders: readonly { readonly orderId: string; readonly messageId: string }[]
  readonly body: string
}

/** Inside the system command: the issues of the posted orders and the batch's one task (see the module's head, step 3). */
export async function raiseProblemsInCommand(tools: CommandTools, input: RaiseProblems): Promise<{ batchId: string; issueIds: string[]; raisedAt: string }> {
  const { tx, now } = tools
  // A message that carries an issue already is never raised twice (a second request for the same messages).
  const known = await tx.productionIssue.findMany({ where: { messageId: { in: input.orders.map((entry) => entry.messageId) } }, select: { id: true, batchId: true, messageId: true, raisedAt: true }, orderBy: { id: 'asc' } })
  const raised = new Set(known.map((row) => row.messageId))
  // The orders again, in the system scope: still the customer's, at the portal's company (the wall of every row below).
  const rows = await tx.salesOrder.findMany({ where: { id: { in: input.orders.map((entry) => entry.orderId) }, partyId: input.partyId, companyId: input.companyId }, select: { id: true, number: true } })
  const numberOf = new Map(rows.map((row) => [row.id, row.number]))
  const fresh = input.orders.filter((entry) => numberOf.has(entry.orderId) && !raised.has(entry.messageId))
  if (fresh.length === 0) {
    const first = known[0]
    if (!first) throw new NotFoundError(ORDER_NOT_FOUND_WORDS.en)
    return { batchId: first.batchId ?? first.id, issueIds: known.map((row) => row.id), raisedAt: first.raisedAt.toISOString() }
  }
  const batchId = newId()
  const dueOn = await issueDueOn(tools, input.companyId)
  const party = await tx.party.findUnique({ where: { id: input.partyId }, select: { legalName: true, tradeName: true } })
  const customer = party?.tradeName ?? party?.legalName ?? ''
  const first = fresh[0]!
  const record: TaskRecord = { type: 'SalesOrder', id: first.orderId, label: numberOf.get(first.orderId)!, companyId: input.companyId, siteId: null, partyId: input.partyId }

  // The batch task's person: the first order's supervisor, the customer's backup, the production managers — the first who may
  // take it on that order (PW-17); else nobody's yet.
  const supervisor = await supervisorOfOrder(tx, first.orderId)
  const chain = [supervisor?.userId ?? null, supervisor?.backupId ?? null, ...(await roleHolders(tx, ESCALATION_ROLE_KEYS[1], now))]
  const takes = new Set<string>()
  for (const userId of [...new Set(chain.filter((entry): entry is string => entry !== null))]) {
    if (await takesIssueTask(tx, input.tenantId, userId, record, now)) {
      takes.add(userId)
      break
    }
  }
  const assigneeId = firstTaker(chain, takes)
  const words = problemTaskWords({ locale: await localeOf(tx, assigneeId), labels: fresh.map((entry) => numberOf.get(entry.orderId)!), customer, excerpt: excerptOf(input.body) })
  const taskId = newId()
  await writeSystemTask(tools, { id: taskId, record, title: words.title, description: words.description, assigneeId, assignedById: input.userId, dueOn, messageId: first.messageId, by: 'production.problem', batchId })

  const issueIds: string[] = []
  for (const entry of fresh) {
    const issueId = newId()
    await tx.productionIssue.create({
      data: {
        id: issueId,
        companyId: input.companyId,
        siteId: null,
        partyId: input.partyId,
        recordType: 'SalesOrder',
        recordId: entry.orderId,
        salesOrderId: entry.orderId,
        taskId,
        messageId: entry.messageId,
        source: 'BRAND',
        batchId,
        raisedAt: now,
        dueDate: new Date(`${dueOn}T00:00:00.000Z`),
        createdAt: now,
        updatedAt: now,
        createdById: input.userId,
      },
      select: { id: true },
    })
    issueIds.push(issueId)
    tools.emit(eventFor(productionIssueRaised, { subject: issueId, companyId: input.companyId, siteId: null, payload: { issueId, partyId: input.partyId, recordType: 'SalesOrder', recordId: entry.orderId, source: 'BRAND', batchId } }))
  }
  // R-48: one audit row per batch (one customer at one company), naming only its own orders.
  tools.audit({
    action: 'production.issuesRaised',
    recordType: 'Party',
    recordId: input.partyId,
    companyId: input.companyId,
    after: { batchId, source: 'BRAND', dueOn, issues: issueIds.map((issueId, index) => ({ issueId, recordType: 'SalesOrder', recordId: fresh[index]!.orderId, messageId: fresh[index]!.messageId })), taskId, assigned: assigneeId !== null },
  })
  return { batchId, issueIds, raisedAt: now.toISOString() }
}
