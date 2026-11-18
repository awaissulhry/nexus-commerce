import { z } from 'zod'
import type { Prisma } from '@nexus/factory-db'
import { KIND_RULES, type ApprovalLocale, type ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import {
  ASK_CUSTOMER_ACTION,
  ASKED_ONLY_FROM_REPROMISE,
  CUSTOMER_ACCEPTED_ACTION,
  CUSTOMER_ANSWER_WORDS,
  CUSTOMER_REFUSED_ACTION,
  customerAnswerOf,
  NEWER_DATE_WORDS,
  refusalTaskOf,
  repromiseFactsOf,
  repromiseHeld,
  repromiseQuestion,
  repromiseReverseHeld, // B-PR-30b
  type CustomerAnswer,
  type RepromiseAsked,
  type RepromiseFacts,
} from '@nexus/factory-domain/planning/promise-keep/brand-answer'
import type { ProposalSize } from '@nexus/factory-domain/planning/promise-keep/repromise'
import { currentPromiseOf } from '@nexus/factory-domain/planning/promise/rules'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { dueAtFor } from '@nexus/factory-domain/approvals-out/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import type { CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import type { RecordAdapter, RecordReverseFacts, RequestRef, ReverseInput } from '../../../platform/approvals-out/adapter'
import { localeOf, lockRequest, RECORD, revokeLinksInCommand, sourceKeyOf } from '../../../platform/approvals-out/store'
import { closeTasksInCommand, openTaskInCommand } from '../../../platform/portal/tasks/store'
import { mayBeAssigned } from '../../../platform/tasks/tasks'
import { followInCommand } from '../../../platform/threads/followers'
import { supervisorOfOrder } from '../../production/supervisor/resolver'
import { readPromiseRows } from '../promise/store'
import type { Reader } from '../store'
import { KEEP_ORDER_STATUSES, readKeepLine, typedOf, type KeepLine, type ProposalRecord } from './store'

/**
 * B-PR-28 (production plan §3 "Brand alone: accept or refuse a new date", plain rule "A brand's 'no' to a new date does not undo
 * the date (capacity is shared). It sets 'waiting on us' and tells us."; 08-backend §4.3; 07-control (e); rules factory-domain
 * planning/promise-keep/brand-answer; wall test PW-P05): the customer answers a new promise date, through the ONE approvals engine.
 *
 *   ask      `askCustomerInCommand`, in sales' accept command (repromise.ts, `askBrand`): after the promise is given (the date
 *            stands) a REPROMISE approval request on the sales order (its question in the customer's language: the order, the
 *            line, each size from → to, the reason, "the date stands"), its APPROVAL link (one use, expires at the due time;
 *            handed once to sales: a customer without a portal answers by it) and the partner's task (APPROVE) — as the engine's
 *            own ask makes them (platform/approvals-out/office.ts) — plus its audit row naming the proposal (the request ↔ the
 *            proposal: `askedOf`). An OPEN question about an older date of the same line is withdrawn first (`NEWER_DATE_WORDS`).
 *   adapter  REPROMISE joins the sales order's adapter (platform/approvals-out/records.ts: one adapter per record type) as a kind
 *            only its own command asks (`commandKinds`): "Ask for approval" never offers it, and its read holds it (the generic
 *            ask is refused in words). Content: the order's own dates only (factory-domain repromiseFactsOf). Held: the order no
 *            longer waits, or the line's date moved again since. The answer is kept on the order's thread (the engine's settle).
 *   settle   in the tenant's system scope, after the customer's answer: accepted → the order's timeline says so; refused → the
 *            date STANDS, a follow-up task on the order (its id = the request's) for its supervisor, else the person who asked
 *            (when they may keep it; else nobody yet: it shows on the order), task.created / task.assigned (the bell) — and while
 *            that task is open the order waits on us (production/brand/facts reads it: BRAND_REQUEST)
 *   reverse  B-PR-30b: the office puts the customer's answer back (Reverse: a reason it reads, step-up, a second person when its
 *            switch is on): the date stands either way, the customer is asked again about the same date — a new REPROMISE
 *            request, link and task as the first ask made them — unless the order no longer waits or the line's date moved
 *            since (`held`: the office asks about the newest date from the re-promise). A refusal's follow-up task stays for the
 *            office to close; the keeper no longer counts a refusal that was put back (production/brand/facts reversedAt).
 *   reads    `customerAnswersOf`: the proposal's customer answer for planning's screens (the newest question of each proposal)
 * The ProposalRecord shape stays as it is (threads' B-TH-077 reads the same proposals on the order record).
 */

type Client = Reader

const [taskCreated, taskAssigned] = taskEvents

const ASKED_AFTER = z.object({
  proposalId: z.uuid(),
  orderLineId: z.uuid(),
  sizes: z.array(z.object({ size: z.string().nullable(), from: z.string().nullable(), to: z.string() })),
  reasonCode: z.string(),
})

/** What each REPROMISE request is about (its ask's audit row), by request. */
export async function askedOf(db: Client, requestIds: readonly string[]): Promise<Map<string, RepromiseAsked>> {
  const out = new Map<string, RepromiseAsked>()
  if (requestIds.length === 0) return out
  const rows = await db.auditLog.findMany({ where: { action: ASK_CUSTOMER_ACTION, recordType: RECORD, recordId: { in: [...new Set(requestIds)] } }, select: { recordId: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  for (const row of rows) {
    const after = ASKED_AFTER.safeParse(row.after)
    if (after.success && !out.has(row.recordId)) out.set(row.recordId, after.data)
  }
  return out
}

/** The facts of the question: the order, its line and the dates asked (the order's own, nothing else). */
const factsOf = (line: KeepLine, asked: RepromiseAsked): RepromiseFacts => ({
  orderNumber: line.order.number,
  customerRef: line.order.customerRef,
  lineSeq: line.seq,
  style: { code: line.style.code, name: line.style.name },
  colourway: { code: line.colourway.code, name: line.colourway.name },
  sizes: asked.sizes,
  reasonCode: asked.reasonCode,
})

// ---- the ask, in sales' accept command ---------------------------------------------------------------------------------------

export interface CustomerAsk {
  readonly context: OfficeContext
  readonly line: KeepLine
  readonly proposal: Pick<ProposalRecord, 'id' | 'reasonCode'>
  readonly sizes: readonly ProposalSize[]
  readonly requestId: string
  readonly linkId: string
  readonly tokenHash: string
  readonly dueAt: Date
  readonly locale: ApprovalLocale
  readonly askedBy: { readonly id: string; readonly name: string } | null
}

/** An OPEN question about an older date of this line: withdrawn (its link revoked, its task cancelled), in words. */
export async function withdrawOlderInCommand(tools: CommandTools, input: { readonly orderId: string; readonly orderLineId: string; readonly actorId: string }): Promise<string[]> {
  const { tx, now } = tools
  const open = await tx.approvalRequest.findMany({ where: { kind: 'REPROMISE', recordType: 'SalesOrder', recordId: input.orderId, status: 'OPEN' }, select: { id: true } })
  const asked = await askedOf(tx, open.map((row) => row.id))
  const withdrawn: string[] = []
  for (const { id } of open) {
    if (asked.get(id)?.orderLineId !== input.orderLineId) continue
    const current = await lockRequest(tx, id)
    if (current.status !== 'OPEN') continue
    await tx.approvalRequest.update({ where: { id }, data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnById: input.actorId, withdrawReason: NEWER_DATE_WORDS, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const revoked = await revokeLinksInCommand(tools, current, input.actorId)
    await closeTasksInCommand(tools, { recordType: RECORD, recordId: id, sourceKey: sourceKeyOf(id), status: 'CANCELLED', doneById: null })
    tools.audit({ recordType: RECORD, recordId: id, companyId: current.companyId, reason: NEWER_DATE_WORDS, before: { status: 'OPEN' }, after: { status: 'WITHDRAWN', linksRevoked: revoked.length } })
    tools.emit({ type: 'approval_request.withdrawn', subject: id, companyId: current.companyId, payload: { requestId: id, kind: 'REPROMISE', recordType: current.recordType, recordId: current.recordId, partyId: current.partyId } })
    withdrawn.push(id)
  }
  return withdrawn
}

/** The REPROMISE request, its APPROVAL link and the partner's task, in the accept's command (the date is given already). */
export async function askCustomerInCommand(tools: CommandTools, input: CustomerAsk): Promise<{ readonly requestId: string; readonly taskId: string }> {
  const { tx, now } = tools
  const { line, context } = input
  const asked: RepromiseAsked = { proposalId: input.proposal.id, orderLineId: line.id, sizes: [...input.sizes], reasonCode: input.proposal.reasonCode }
  const question = repromiseQuestion(factsOf(line, asked), input.locale)
  await tx.approvalRequest.create({
    data: { id: input.requestId, companyId: line.companyId, recordType: 'SalesOrder', recordId: line.orderId, partyId: line.partyId, contactId: null, kind: 'REPROMISE', question, dueAt: input.dueAt, createdAt: now, updatedAt: now, createdById: context.actorId },
    select: { id: true },
  })
  await tx.oneOffLink.createMany({
    data: [{ id: input.linkId, companyId: line.companyId, partyId: line.partyId, purpose: 'APPROVAL', recordType: RECORD, recordId: input.requestId, tokenHash: input.tokenHash, email: null, expiresAt: input.dueAt, maxUses: 1, contactId: null, createdAt: now, updatedAt: now, createdById: context.actorId }],
  })
  tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: input.linkId, companyId: line.companyId, after: { purpose: 'APPROVAL', recordType: RECORD, recordId: input.requestId, partyId: line.partyId, email: null, expiresAt: toUtcIso(input.dueAt), maxUses: 1 } })
  const label = `${KIND_RULES.REPROMISE.name[input.locale]} · ${line.order.number}`
  const { task } = await openTaskInCommand(tools, { companyId: line.companyId, partyId: line.partyId, kind: KIND_RULES.REPROMISE.task, record: { type: RECORD, id: input.requestId, label }, sourceKey: sourceKeyOf(input.requestId), dueAt: input.dueAt, askedBy: input.askedBy })
  // The request ↔ the proposal (askedOf reads it): what was asked, on the request's own audit row.
  tools.audit({ action: ASK_CUSTOMER_ACTION, recordType: RECORD, recordId: input.requestId, companyId: line.companyId, after: { kind: 'REPROMISE', recordType: 'SalesOrder', recordId: line.orderId, partyId: line.partyId, ...asked, dueAt: toUtcIso(input.dueAt), linkId: input.linkId, taskId: task.id } })
  tools.emit({ type: 'approval_request.asked', subject: input.requestId, companyId: line.companyId, payload: { requestId: input.requestId, kind: 'REPROMISE', recordType: 'SalesOrder', recordId: line.orderId, partyId: line.partyId, dueAt: toUtcIso(input.dueAt), linkId: input.linkId, taskId: task.id, files: 0 } })
  return { requestId: input.requestId, taskId: task.id }
}

// ---- the adapter's REPROMISE part ------------------------------------------------------------------------------------------

/** The question's own facts: what was asked and the line now (null: not one of ours). */
async function questionOf(client: Client, request: Pick<RequestRef, 'id' | 'recordId'>): Promise<{ asked: RepromiseAsked; line: KeepLine } | null> {
  const asked = (await askedOf(client, [request.id])).get(request.id)
  if (!asked) return null
  const line = await readKeepLine(client, asked.orderLineId)
  return line && line.orderId === request.recordId ? { asked, line } : null
}

async function repromiseRead(client: Client, orderId: string) {
  const order = await client.salesOrder.findUnique({ where: { id: orderId }, select: { companyId: true, partyId: true, number: true } })
  if (!order) return null
  // Held: a new date is asked only from the re-promise (the generic ask is refused in words; its other reads use the label).
  return { companyId: order.companyId, siteId: null, partyId: order.partyId, label: { it: `${order.number} · nuova data`, en: `${order.number} · new date` }, held: ASKED_ONLY_FROM_REPROMISE, thread: { type: 'SalesOrder', id: orderId } }
}

async function repromiseContent(client: Client, request: RequestRef, locale: ApprovalLocale) {
  const found = await questionOf(client, request)
  return { facts: found ? repromiseFactsOf(factsOf(found.line, found.asked), locale) : [], revisedOrder: null }
}

async function repromiseAnswerHeld(client: Client, request: RequestRef, locale: ApprovalLocale): Promise<string | null> {
  const found = await questionOf(client, request)
  if (!found) return repromiseHeld({ orderOpen: false, movedSince: false }, locale)
  const { asked, line } = found
  const rows = (await readPromiseRows(client, [line.id])).get(line.id) ?? []
  const typed = typedOf(line)
  const movedSince = asked.sizes.some((entry) => (currentPromiseOf(entry.size, rows, typed)?.date ?? null) !== entry.to)
  return repromiseHeld({ orderOpen: (KEEP_ORDER_STATUSES as readonly string[]).includes(line.order.status), movedSince }, locale)
}

/** Accepted: the order's timeline says so. Refused: the date stands; a follow-up task for us (the order then waits on us). */
async function repromiseSettle(tools: CommandTools, request: RequestRef): Promise<Prisma.InputJsonObject | null> {
  const { tx, now } = tools
  const found = await questionOf(tx, request)
  if (!found) return null
  const { asked, line } = found
  if (request.status !== 'REFUSED') {
    tools.audit({ action: CUSTOMER_ACCEPTED_ACTION, recordType: 'SalesOrder', recordId: line.orderId, companyId: line.companyId, after: { requestId: request.id, proposalId: asked.proposalId, orderLineId: line.id, sizes: asked.sizes.map((entry) => ({ size: entry.size, to: entry.to })) } })
    return { accepted: true }
  }
  const known = await tx.task.findUnique({ where: { id: request.id }, select: { id: true } })
  if (known) return { refused: true, taskId: known.id }
  const row = await tx.approvalRequest.findUnique({ where: { id: request.id }, select: { createdById: true, answer: true } })
  const scope = { companyId: line.companyId, siteId: null, partyId: line.partyId }
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : undefined
  if (!tenantId) throw new Error('promise-keep: an answer settled outside a tenant')
  const may = async (userId: string | null | undefined): Promise<string | null> => (userId && (await mayBeAssigned(tx, tenantId, userId, scope, true, now, 'SalesOrder')) ? userId : null)
  // The order's supervisor first (plan B-PR-32: office notices to the supervisor), else the person who asked.
  const assigneeId = (await may((await supervisorOfOrder(tx, line.orderId))?.userId)) ?? (await may(row?.createdById))
  // Who settles it (an office, partner or system actor); a link reader is no person: none.
  const systemId = 'actorId' in tools.context ? tools.context.actorId : null
  const { title, description } = refusalTaskOf({ orderNumber: line.order.number, lineSeq: line.seq, sizes: asked.sizes, answer: row?.answer ?? request.answer })
  await tx.task.create({
    data: {
      id: request.id,
      companyId: line.companyId,
      siteId: null,
      partyId: line.partyId,
      title,
      description,
      recordType: 'SalesOrder',
      recordId: line.orderId,
      recordLabel: line.order.number,
      assigneeId,
      assignedById: assigneeId ? systemId : null,
      assignedAt: assigneeId ? now : null,
      checklist: [],
      createdAt: now,
      updatedAt: now,
      createdById: null,
    },
    select: { id: true },
  })
  tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: request.id, companyId: line.companyId, after: { title, assigneeId, status: 'OPEN', recordType: 'SalesOrder', recordId: line.orderId, by: CUSTOMER_REFUSED_ACTION } })
  const about = { taskId: request.id, recordType: 'SalesOrder', recordId: line.orderId }
  const where = { subject: request.id, companyId: line.companyId, siteId: null }
  tools.emit(eventFor(taskCreated, { ...where, payload: { ...about, assigneeId } }))
  if (assigneeId) {
    tools.emit(eventFor(taskAssigned, { ...where, payload: { ...about, assigneeId, assignedById: systemId } }))
    await followInCommand(tools, { type: 'SalesOrder', id: line.orderId, companyId: line.companyId, siteId: null }, assigneeId, 'ASSIGNEE', null)
  }
  tools.audit({ action: CUSTOMER_REFUSED_ACTION, recordType: 'SalesOrder', recordId: line.orderId, companyId: line.companyId, after: { requestId: request.id, proposalId: asked.proposalId, orderLineId: line.id, taskId: request.id, assigneeId, dateStands: true } })
  return { refused: true, taskId: request.id, assigneeId }
}

// ---- B-PR-30b: putting the customer's answer back -------------------------------------------------------------------------

/** Whether the customer's answer may be put back and asked again: the order still waits, the line's date did not move since. */
async function repromiseReverseFacts(client: Client, request: RequestRef): Promise<RecordReverseFacts> {
  const found = await questionOf(client, request)
  const facts = { sampleKind: null, cut: null, passedGate: false, applied: false }
  if (!found) return { ...facts, held: { code: 'HELD', words: repromiseReverseHeld({ orderOpen: false, movedSince: false })! } }
  const { asked, line } = found
  const rows = (await readPromiseRows(client, [line.id])).get(line.id) ?? []
  const typed = typedOf(line)
  const movedSince = asked.sizes.some((entry) => (currentPromiseOf(entry.size, rows, typed)?.date ?? null) !== entry.to)
  const held = repromiseReverseHeld({ orderOpen: (KEEP_ORDER_STATUSES as readonly string[]).includes(line.order.status), movedSince })
  return { ...facts, held: held ? { code: 'HELD', words: held } : null }
}

/** ASK_AGAIN: the same date asked of the customer again (a new request, link and task), in the reversal's command. */
async function repromiseReverse(tools: CommandTools, request: RequestRef, input: ReverseInput): Promise<Prisma.InputJsonObject | null> {
  if (!input.effects.includes('ASK_AGAIN')) return null
  const { tx, now } = tools
  const found = await questionOf(tx, request)
  if (!found) return null
  const { asked, line } = found
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : undefined
  if (!tenantId) throw new Error('promise-keep: a reversal outside a tenant')
  // The link's token is minted outside the command by the route (its URL handed once); a second person's yes mints its own
  // here (the customer answers in its portal: nobody is handed that link).
  const ask = input.ask ?? (() => {
    const linkId = newId()
    return { requestId: newId(), linkId, tokenHash: linkTokenHash(mintLinkToken({ tenantId, partyId: line.partyId, linkId }).value) }
  })()
  const [person, party] = await Promise.all([
    tx.user.findUnique({ where: { id: input.actorId }, select: { id: true, displayName: true } }),
    tx.party.findUnique({ where: { id: line.partyId }, select: { language: true } }),
  ])
  const context = { ...(tools.context as OfficeContext), actorId: input.actorId }
  const sizes = asked.sizes.map((entry) => ({ size: entry.size, from: entry.from, to: entry.to }))
  const asks = await askCustomerInCommand(tools, {
    context,
    line,
    proposal: { id: asked.proposalId, reasonCode: asked.reasonCode },
    sizes,
    requestId: ask.requestId,
    linkId: ask.linkId,
    tokenHash: ask.tokenHash,
    dueAt: dueAtFor('REPROMISE', null, now),
    locale: localeOf(party?.language),
    askedBy: person ? { id: person.id, name: person.displayName } : null,
  })
  return { askedAgain: asks.requestId, taskId: asks.taskId }
}

const isRepromise = (kind: string): boolean => kind === 'REPROMISE'

/**
 * The sales order's adapter with REPROMISE joined (records.ts: one adapter per record type): every other kind is the base's, as
 * it was; REPROMISE is a kind only its own command asks (`commandKinds`), never offered by "Ask for approval".
 */
export function withRepromise(base: RecordAdapter): RecordAdapter {
  if (base.recordType !== 'SalesOrder') return base
  return Object.freeze<RecordAdapter>({
    ...base,
    commandKinds: Object.freeze(['REPROMISE' as const]),
    read: (client, recordId, kind, context) => (isRepromise(kind) ? repromiseRead(client, recordId) : base.read(client, recordId, kind, context)),
    content: (client, request, locale) => (isRepromise(request.kind) ? repromiseContent(client, request, locale) : base.content(client, request, locale)),
    answerHeld: async (client, request, locale) => (isRepromise(request.kind) ? repromiseAnswerHeld(client, request, locale) : base.answerHeld ? base.answerHeld(client, request, locale) : null),
    settle: async (tools, request) => (isRepromise(request.kind) ? repromiseSettle(tools, request) : base.settle ? base.settle(tools, request) : null),
    // B-PR-30b: a new date's answer put back asks the customer again; every other kind is the base's (marked put back only).
    reverseFacts: async (client, request) =>
      isRepromise(request.kind) ? repromiseReverseFacts(client, request) : base.reverseFacts ? base.reverseFacts(client, request) : { sampleKind: null, cut: null, passedGate: false, applied: false, held: null },
    reverse: async (tools, request, input) => (isRepromise(request.kind) ? repromiseReverse(tools, request, input) : base.reverse ? base.reverse(tools, request, input) : null),
  })
}

// ---- the customer's answer on planning's screens ----------------------------------------------------------------------------

export interface CustomerAnswerView {
  readonly requestId: string
  readonly state: CustomerAnswer
  readonly words: string
  /** When the customer answered (null: not yet). */
  readonly at: string | null
  /** Their words (a refusal always says why) and the name they signed with. */
  readonly answer: string | null
  readonly typedName: string | null
  /** The follow-up task of a refusal (its id = the request's). */
  readonly followUp: { readonly taskId: string; readonly status: 'OPEN' | 'DONE' | 'CANCELLED' } | null
}

/** The customer's answer to each proposal's newest question (none asked: not in the map). */
export async function customerAnswersOf(db: Client, proposals: readonly Pick<ProposalRecord, 'id' | 'orderId'>[]): Promise<Map<string, CustomerAnswerView>> {
  const out = new Map<string, CustomerAnswerView>()
  const orderIds = [...new Set(proposals.map((proposal) => proposal.orderId))]
  if (orderIds.length === 0) return out
  const requests = await db.approvalRequest.findMany({ where: { kind: 'REPROMISE', recordType: 'SalesOrder', recordId: { in: orderIds } }, select: { id: true, status: true, answer: true, typedName: true, answeredAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (requests.length === 0) return out
  const asked = await askedOf(db, requests.map((row) => row.id))
  const tasks = new Map((await db.task.findMany({ where: { id: { in: requests.map((row) => row.id) } }, select: { id: true, status: true } })).map((task) => [task.id, task.status as 'OPEN' | 'DONE' | 'CANCELLED']))
  const wanted = new Set(proposals.map((proposal) => proposal.id))
  for (const row of requests) {
    const proposalId = asked.get(row.id)?.proposalId
    if (!proposalId || !wanted.has(proposalId) || out.has(proposalId)) continue
    const state = customerAnswerOf(row.status as ApprovalStatus)
    const followUp = tasks.get(row.id)
    out.set(proposalId, { requestId: row.id, state, words: CUSTOMER_ANSWER_WORDS[state], at: row.answeredAt ? toUtcIso(row.answeredAt) : null, answer: row.answer, typedName: row.typedName, followUp: followUp ? { taskId: row.id, status: followUp } : null })
  }
  return out
}
