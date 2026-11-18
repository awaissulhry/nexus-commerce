import { events as approvalEvents } from '@nexus/factory-domain/approvals-out/events'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { isCustomer, type PartyRole } from '@nexus/factory-domain/parties/rules'
import { brandUrgencyChanged } from '@nexus/factory-domain/production-brand/events'
import { approvalOfficeNotice, askOfficeNotice, batchAskOfficeNotice, counterOfficeNotice, mayTellApproval, urgencyOfficeNotice, withdrawnOfficeNotice, type OfficeNotice } from '@nexus/factory-domain/production-brand/office-notices'
import { PRODUCTION_BRAND_MANAGE } from '@nexus/factory-domain/production-brand/permissions'
import { effectiveSupervisor } from '@nexus/factory-domain/production-brand/supervisor'
import { events as changeRequestEvents } from '@nexus/factory-domain/sales-change-requests/events'
import { customerDefaultsOf, orderSupervisorsOf } from '../../../modules/production/supervisor/resolver'
import { mayOnThread } from '../../threads/records'
import type { Draft, FanOutRule, Reader, RuleContext } from '../fan-out'

/**
 * B-PR-32 — the factory is told of every customer action on its production (production plan §1 "Full control", §3, §6 slice 3
 * "notices"; lead picks L15, L21; review fixes R-43, R-51, R-60; 06-tree A.7 O-NOTIF-brand; Appendix C "TOP gates nothing; a refusal
 * tells the office"; walls PW-04, PW-09, PW-14; the Owner rule 2026-11-16: "One brand must not be able to see anything related to
 * any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."). Which act makes which
 * sentence is factory-domain production-brand/office-notices.ts (pure); this file reads the records and decides who is told:
 *
 *   brand_production.urgency_changed       the customer's own marks (Urgent, back to Regular), its urgent list put in a new order,
 *                                          an undo — ONE event per command and customer (a bulk mark is one); ours tell nothing
 *   order_change_request.asked             an ask of one order, only while it still waits; one that carries a batchId is skipped
 *   order_change_request.batch_asked       a bulk ask, ONE notice per batch over its requests that still wait (R-51)
 *   order_change_request.withdrawn         a withdrawal; a batch's Undo (one command: one withdrawal time) is told ONCE, by the
 *                                          first of the requests it withdrew together (its events carry no batchId)
 *   order_change_request.counter_answered  our counter-offer accepted or refused
 *   approval_request.answered              a production approval answered (PP, size set, top of production, fabric, trims), a
 *                                          refused top of production, a refused new date — not to the person the refusal's
 *                                          follow-up task already told (B-PR-28: its id is the request's)
 *
 * WHO (lead pick L21, R-60): per order its supervisor (its own, else the customer's default: modules/production/supervisor
 * resolver, B-PR-42a) and the customer's backup; when neither may be told, the holders of production.brand.manage over the
 * order's company and customer. A notice of the customer itself (a sample round of no order) goes the same way through the
 * customer's default. Each person is told once per event, of the orders he is told of ("asks to pause 3 orders"), and a batch's
 * notices are one bell group per person (the draft's batchId). Nobody of the customer acted as an office person: no actor.
 * fix-pr-4 (pr3n open point, lead decision): an answer to OUR question also tells the office person who asked it — the approval
 * request's maker (createdById), the counter-offer's (counteredById) — beside the supervisor and backup (or the managers), while he
 * is an ACTIVE office person who reads the record over its company and customer (the same wall; a person limited to another
 * customer, suspended or without threads.read is never told).
 *
 * THE WALL (PW-04, PW-09, PW-14): every order is read by its own row and kept only when it is the event's customer's (an order of
 * another customer named by mistake is dropped, never told); a person is told only while he is an ACTIVE office person who reads
 * the record the notice opens over its company and customer (threads.read there, `mayOnThread` over his live roles — re-checked
 * at the fan-out, never at the act); a person limited to another customer is never told, whatever the default names. The words
 * name the customer (to its readers only) and our order numbers; never a person of the customer, an amount or a typed reason.
 */

// The events' own schemas (checked at compile time to be the ones named).
const asked = changeRequestEvents[0] satisfies { readonly type: 'order_change_request.asked' }
const withdrawn = changeRequestEvents[1] satisfies { readonly type: 'order_change_request.withdrawn' }
const counterAnswered = changeRequestEvents[4] satisfies { readonly type: 'order_change_request.counter_answered' }
const batchAsked = changeRequestEvents[5] satisfies { readonly type: 'order_change_request.batch_asked' }
const approvalAnswered = approvalEvents[1] satisfies { readonly type: 'approval_request.answered' }

/** The most requests of one batch a notice reads (a customer's bulk action holds at most 50 orders). */
const BATCH_READ = 200

interface Customer {
  readonly id: string
  /** As the office reads it: its trade name, else its legal name. */
  readonly name: string
}

interface OwnOrder {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
}

/** What a notice is about, for who is told: an order (its supervisor), or the customer itself (null: its default). */
interface Subject {
  readonly orderId: string | null
  /** Where the reader must read: the record the notice opens, over this company and the customer. */
  readonly recordType: string
  readonly companyId: string
}

/** The party when it is a customer (CUSTOMER or BRAND), by its own row. */
async function customerOf(context: RuleContext, partyId: string): Promise<Customer | null> {
  const party = await context.tx.party.findUnique({ where: { id: partyId }, select: { id: true, roles: true, tradeName: true, legalName: true } })
  if (!party || !isCustomer(party.roles as PartyRole[])) return null
  return { id: party.id, name: party.tradeName ?? party.legalName }
}

/** The named orders by their own rows, only the customer's (W06: the record's party, never the event's word), by number. */
async function ownOrders(context: RuleContext, partyId: string, orderIds: readonly string[]): Promise<OwnOrder[]> {
  const wanted = [...new Set(orderIds)]
  if (wanted.length === 0) return []
  const rows = await context.tx.salesOrder.findMany({ where: { id: { in: wanted } }, select: { id: true, number: true, companyId: true, partyId: true } })
  return rows.filter((row) => row.partyId === partyId).sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : a.id < b.id ? -1 : 1))
}

/** The holders of production.brand.manage at the place who read the record there (the fallback when nobody named may be told). */
async function managersOf(context: RuleContext, place: ScopedRecord, reads: (reader: Reader) => boolean): Promise<string[]> {
  const found: string[] = []
  for (const userId of await context.people()) {
    const reader = await context.reader(userId)
    if (reader && can(reader.actor, PRODUCTION_BRAND_MANAGE, place) && reads(reader)) found.push(userId)
  }
  return found
}

/**
 * Who is told of each subject (see the head): its supervisor and the customer's backup who read it now, else the holders of
 * production.brand.manage over its company and customer who read it. Each person once, with the subjects he is told of.
 */
async function audienceOf(context: RuleContext, partyId: string, subjects: readonly Subject[], asker: string | null = null): Promise<Map<string, Subject[]>> {
  const defaults = (await customerDefaultsOf(context.tx, [partyId])).get(partyId) ?? null
  const own = await orderSupervisorsOf(context.tx, subjects.flatMap((subject) => (subject.orderId !== null ? [subject.orderId] : [])))
  const managers = new Map<string, readonly string[]>()
  const told = new Map<string, Subject[]>()
  for (const subject of subjects) {
    const place = { companyId: subject.companyId, siteId: null, partyId }
    const reads = (reader: Reader): boolean => mayOnThread(reader.actor, THREADS_READ, subject.recordType, place)
    const supervisor = effectiveSupervisor(subject.orderId !== null ? (own.get(subject.orderId) ?? null) : null, defaults?.supervisorId ?? null).userId
    const named: string[] = []
    for (const userId of [supervisor, defaults?.backupId ?? null]) {
      if (userId === null || named.includes(userId)) continue
      const reader = await context.reader(userId)
      if (reader && reads(reader)) named.push(userId)
    }
    let people: readonly string[] = named
    if (people.length === 0) {
      const key = `${subject.recordType}|${subject.companyId}`
      const cached = managers.get(key) ?? (await managersOf(context, place, reads))
      managers.set(key, cached)
      people = cached
    }
    for (const userId of people) told.set(userId, [...(told.get(userId) ?? []), subject])
  }
  // fix-pr-4: the office person who asked the customer, of the subjects he reads now (each person once, each subject once).
  if (asker !== null) {
    const reader = await context.reader(asker)
    const his = reader ? subjects.filter((subject) => mayOnThread(reader.actor, THREADS_READ, subject.recordType, { companyId: subject.companyId, siteId: null, partyId })) : []
    const already = told.get(asker) ?? []
    const added = his.filter((subject) => !already.includes(subject))
    if (added.length > 0) told.set(asker, [...already, ...added])
  }
  return told
}

/** The notices of an act on the customer's orders: one per person, over the orders he is told of (the first named, how many). */
async function orderDrafts(context: RuleContext, customer: Customer, orders: readonly OwnOrder[], noticeOf: (count: number) => OfficeNotice | null, options: { readonly batchId: string | null; readonly skip?: ReadonlySet<string>; /* fix-pr-4 */ readonly asker?: string | null }): Promise<Draft[]> {
  if (orders.length === 0) return []
  const audience = await audienceOf(context, customer.id, orders.map((order): Subject => ({ orderId: order.id, recordType: 'SalesOrder', companyId: order.companyId })), options.asker ?? null)
  const drafts: Draft[] = []
  for (const [userId, subjects] of audience) {
    if (options.skip?.has(userId)) continue
    const his = orders.filter((order) => subjects.some((subject) => subject.orderId === order.id))
    const first = his[0]
    const notice = noticeOf(his.length)
    if (first === undefined || notice === null) continue
    drafts.push({
      userId,
      category: notice.category,
      record: { type: 'SalesOrder', id: first.id, label: first.number },
      companyId: first.companyId,
      anchor: null,
      messageKey: notice.key,
      params: { customer: customer.name, count: his.length },
      actorId: null,
      batchId: options.batchId,
    })
  }
  return drafts
}

// ---- an answered approval: the record it opens and the orders whose supervisor counts ------------------------------------------

interface ApprovalAbout {
  readonly record: { readonly type: string; readonly id: string; readonly label: string }
  readonly companyId: string
  /** The orders it is about (their supervisors); none: the customer's default. */
  readonly orderIds: readonly string[]
}

interface AnsweredRequest {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly recordType: string
  readonly recordId: string
}

/** The orders a sample round is about: the gates it passes and the sample-round asks it answered (TOP gates nothing). */
async function roundOrders(context: RuleContext, roundId: string): Promise<string[]> {
  const gates = await context.tx.orderGate.findMany({ where: { sampleRoundId: roundId }, select: { salesOrderId: true } })
  const asks = await context.tx.orderChangeRequest.findMany({ where: { sampleRoundId: roundId }, select: { orderId: true } })
  return [...new Set([...gates.map((gate) => gate.salesOrderId), ...asks.map((ask) => ask.orderId)])].sort()
}

async function roundAbout(context: RuleContext, roundId: string, request: AnsweredRequest): Promise<ApprovalAbout | null> {
  const round = await context.tx.sampleRound.findUnique({ where: { id: roundId }, select: { id: true, number: true, partyId: true } })
  if (!round || round.partyId !== request.partyId) return null
  const orders = await ownOrders(context, request.partyId, await roundOrders(context, round.id))
  return { record: { type: 'SampleRound', id: round.id, label: round.number }, companyId: request.companyId, orderIds: orders.map((order) => order.id) }
}

async function styleAbout(context: RuleContext, styleId: string, request: AnsweredRequest): Promise<ApprovalAbout | null> {
  const style = await context.tx.style.findUnique({ where: { id: styleId }, select: { id: true, code: true } })
  return style ? { record: { type: 'Style', id: style.id, label: style.code }, companyId: request.companyId, orderIds: [] } : null
}

/** What an answered request is about, by its record's own row (of the request's customer), or null: nothing to tell. */
async function approvalAbout(context: RuleContext, request: AnsweredRequest): Promise<ApprovalAbout | null> {
  const { tx } = context
  switch (request.recordType) {
    case 'SampleRound':
      return roundAbout(context, request.recordId, request)
    case 'SampleSwatch': {
      // A swatch opens its round, else its style (a swatch has no page of its own).
      const swatch = await tx.sampleSwatch.findUnique({ where: { id: request.recordId }, select: { partyId: true, roundId: true, styleId: true } })
      if (!swatch || swatch.partyId !== request.partyId) return null
      return swatch.roundId !== null ? roundAbout(context, swatch.roundId, request) : styleAbout(context, swatch.styleId, request)
    }
    case 'SalesOrder': {
      const [order] = await ownOrders(context, request.partyId, [request.recordId])
      return order ? { record: { type: 'SalesOrder', id: order.id, label: order.number }, companyId: order.companyId, orderIds: [order.id] } : null
    }
    case 'Style': {
      const style = await tx.style.findUnique({ where: { id: request.recordId }, select: { brandPartyId: true } })
      return style && style.brandPartyId === request.partyId ? styleAbout(context, request.recordId, request) : null
    }
    case 'Quote': {
      const quote = await tx.quote.findUnique({ where: { id: request.recordId }, select: { id: true, number: true, partyId: true } })
      return quote && quote.partyId === request.partyId ? { record: { type: 'Quote', id: quote.id, label: quote.number }, companyId: request.companyId, orderIds: [] } : null
    }
    case 'Project': {
      const project = await tx.project.findUnique({ where: { id: request.recordId }, select: { id: true, number: true, partyId: true } })
      return project && project.partyId === request.partyId ? { record: { type: 'Project', id: project.id, label: project.number }, companyId: request.companyId, orderIds: [] } : null
    }
    default:
      return null
  }
}

export const BRAND_PRODUCTION_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'production.customerUrgency',
    events: ['brand_production.urgency_changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const event = brandUrgencyChanged.payload.parse(raw)
      // Decided on the payload first: ours (set back, lock, unlock, our yes to its ask) tell nobody here.
      if (urgencyOfficeNotice(event, 1) === null) return []
      const customer = await customerOf(context, event.partyId)
      if (!customer) return []
      const orders = await ownOrders(context, customer.id, event.orderIds)
      return orderDrafts(context, customer, orders, (count) => urgencyOfficeNotice(event, count), { batchId: event.batchId })
    },
  },
  {
    name: 'production.customerAsked',
    events: ['order_change_request.asked'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const event = asked.payload.parse(raw)
      // R-51: a bulk ask is told once, on its batch_asked.
      if (event.batchId !== undefined) return []
      const request = await context.tx.orderChangeRequest.findUnique({ where: { id: event.requestId }, select: { partyId: true, orderId: true, kind: true, status: true, batchId: true } })
      // Told only while it still waits for our answer (a withdrawal or our answer since is news of its own).
      if (!request || request.partyId !== event.partyId || request.orderId !== event.orderId || request.kind !== event.kind || request.status !== 'OPEN' || request.batchId !== null) return []
      const customer = await customerOf(context, event.partyId)
      if (!customer) return []
      const orders = await ownOrders(context, customer.id, [event.orderId])
      const notice = askOfficeNotice(event.kind, event.wholeOrder)
      return orderDrafts(context, customer, orders, () => notice, { batchId: null })
    },
  },
  {
    name: 'production.customerAskedBatch',
    events: ['order_change_request.batch_asked'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const event = batchAsked.payload.parse(raw)
      const customer = await customerOf(context, event.partyId)
      if (!customer) return []
      // The batch's requests by their own rows (one customer, one kind: the database's rule), only those that still wait.
      const requests = await context.tx.orderChangeRequest.findMany({ where: { batchId: event.batchId, partyId: customer.id, kind: event.kind, status: 'OPEN' }, select: { orderId: true }, orderBy: { id: 'asc' }, take: BATCH_READ })
      const orders = await ownOrders(context, customer.id, requests.map((request) => request.orderId))
      return orderDrafts(context, customer, orders, (count) => batchAskOfficeNotice(event.kind, count), { batchId: event.batchId })
    },
  },
  {
    name: 'production.customerWithdrew',
    events: ['order_change_request.withdrawn'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const event = withdrawn.payload.parse(raw)
      const request = await context.tx.orderChangeRequest.findUnique({ where: { id: event.requestId }, select: { partyId: true, orderId: true, status: true, batchId: true, withdrawnAt: true } })
      if (!request || request.partyId !== event.partyId || request.orderId !== event.orderId || request.status !== 'WITHDRAWN' || request.withdrawnAt === null) return []
      const customer = await customerOf(context, event.partyId)
      if (!customer) return []
      let orderIds: readonly string[] = [request.orderId]
      let batchId: string | null = null
      if (request.batchId !== null) {
        // pr3l: a batch's Undo emits one withdrawn per request, with no batchId. One command, one withdrawal time: the requests of the
        // batch withdrawn at that same time were withdrawn together — told once, by the first of them; the others tell nothing.
        const together = await context.tx.orderChangeRequest.findMany({ where: { batchId: request.batchId, partyId: customer.id, status: 'WITHDRAWN', withdrawnAt: request.withdrawnAt }, select: { id: true, orderId: true }, orderBy: { id: 'asc' }, take: BATCH_READ })
        const speaker = together[0]
        if (speaker !== undefined && speaker.id !== event.requestId) return []
        orderIds = together.map((row) => row.orderId)
        batchId = request.batchId
      }
      const orders = await ownOrders(context, customer.id, orderIds)
      return orderDrafts(context, customer, orders, (count) => withdrawnOfficeNotice(count), { batchId })
    },
  },
  {
    name: 'production.customerCounterAnswered',
    events: ['order_change_request.counter_answered'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const event = counterAnswered.payload.parse(raw)
      const request = await context.tx.orderChangeRequest.findUnique({ where: { id: event.requestId }, select: { partyId: true, orderId: true, counteredById: true } })
      if (!request || request.partyId !== event.partyId || request.orderId !== event.orderId) return []
      const customer = await customerOf(context, event.partyId)
      if (!customer) return []
      const orders = await ownOrders(context, customer.id, [event.orderId])
      const notice = counterOfficeNotice(event.answer)
      // fix-pr-4: the office person who made the counter-offer is told too.
      return orderDrafts(context, customer, orders, () => notice, { batchId: null, asker: request.counteredById })
    },
  },
  {
    name: 'production.customerApprovalAnswered',
    events: ['approval_request.answered'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const event = approvalAnswered.payload.parse(raw)
      // Decided on the payload first (a kind or a record that never tells: nothing to read); the round's kind is read after.
      if (!mayTellApproval({ kind: event.kind, recordType: event.recordType, status: event.status })) return []
      // The request by its own row, still answered so (a decision for the customer or a reversal is the office's own act).
      const row = await context.tx.approvalRequest.findUnique({ where: { id: event.requestId }, select: { id: true, companyId: true, partyId: true, kind: true, recordType: true, recordId: true, status: true, decidedForPartyById: true, createdById: true } })
      if (!row || row.partyId !== event.partyId || row.kind !== event.kind || row.recordType !== event.recordType || row.recordId !== event.recordId || row.status !== event.status || row.decidedForPartyById !== null) return []
      const round = row.recordType === 'SampleRound' ? await context.tx.sampleRound.findUnique({ where: { id: row.recordId }, select: { kind: true } }) : null
      const notice = approvalOfficeNotice({ kind: event.kind, recordType: row.recordType, sampleKind: round?.kind ?? null, status: event.status })
      if (notice === null) return []
      const customer = await customerOf(context, row.partyId)
      if (!customer) return []
      const about = await approvalAbout(context, row)
      if (!about) return []
      // B-PR-28: a refused new date opened a follow-up task (its id = the request's); its assignee was told by it.
      const followUp = event.kind === 'REPROMISE' ? await context.tx.task.findUnique({ where: { id: row.id }, select: { assigneeId: true } }) : null
      const skip = new Set(followUp?.assigneeId ? [followUp.assigneeId] : [])
      const subjects = about.orderIds.length > 0 ? about.orderIds.map((orderId): Subject => ({ orderId, recordType: about.record.type, companyId: about.companyId })) : [{ orderId: null, recordType: about.record.type, companyId: about.companyId }]
      // fix-pr-4: the office person who sent the request is told too.
      const audience = await audienceOf(context, customer.id, subjects, row.createdById)
      return [...audience.keys()]
        .filter((userId) => !skip.has(userId))
        .map((userId): Draft => ({ userId, category: notice.category, record: about.record, companyId: about.companyId, anchor: null, messageKey: notice.key, params: { customer: customer.name }, actorId: null }))
    },
  },
])
