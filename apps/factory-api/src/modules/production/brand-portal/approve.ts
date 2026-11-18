import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApprovalKind, ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import {
  approveManyProblems,
  approveRowCodeOf,
  APPROVED_WORDS,
  approvesInBulk,
  BULK_APPROVE_KINDS,
  BULK_REVIEW_MAX,
  NO_UNDO_WORDS,
  NONE_APPROVED_WORDS,
  OWN_ANSWER_WORDS,
  wordsOfRefusal,
  type ApproveRowCode,
} from '@nexus/factory-domain/production-brand/approve-zip'
import { ORDER_NOT_FOUND_WORDS } from '@nexus/factory-domain/production-brand/words'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { answerManyInPortal, portalApproval, type ManyItem } from '../../../platform/approvals-out/answer'
import { walledForOutside } from '../../../platform/files/content-wall'
import { portalReader, type PortalReader } from '../../sales/portal-orders/access'
import { partnerOrders, type OwnOrder } from './access'

/**
 * B-PR-46b — a customer's Approve N on My production (production plan §1 "Bulk", §3 "Bulk 'Approve' cannot be undone; the dialog
 * says so before Send"; lead pick L26; wall test PW-12; the Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."). Rules
 * and words: factory-domain production-brand/approve-zip.
 *
 *   GET  /portal/production/approvals?orderIds=a,b,…   (portal.approvals.view) the review list: the approvals waiting on the
 *                                                       picked orders, each once, with the orders it is about, its facts and its
 *                                                       photo or PDF (the files the request shares with the customer: opened by
 *                                                       the portal's own file routes), and whether THIS person may approve it
 *                                                       from the list (`may.approve`, else `may.held` in words: a priced
 *                                                       counter-offer waits for the Buyer, a named approver's for that person,
 *                                                       a revised order, a concession or a signature "Open it to answer")
 *   POST /portal/production/approvals/answer            (portal.approvals.view + portal.approve, never a preview)
 *        {items [{requestId, version}] 1–50, typedName}  Approve N: each request APPROVED with the one typed name through the
 *                                                       approvals answer path (platform/approvals-out answerManyInPortal: its own
 *                                                       rules, its own command and key, its own settle); one result per request;
 *                                                       nothing approved: 409 with each request's words. No Undo (the list says so)
 *
 * "Waiting on the order" (the same records the keeper's Waiting on you and the order's Gates & dates read): a request asked on the
 * order itself (a sample, a swatch or an artwork on its thread, a new date), on one of its lines (a design proof), on one of its
 * asks (our counter-offer), on one of its amendments (a revised order), on a sample round one of its gates names, and on the
 * styles its lines make — their sample rounds, swatches and the style's own thread (the PP sample of the jacket it ordered).
 *
 * The wall (PW-12): the orders are read in the PARTNER scope first (./access.ts partnerOrders): an id that is not one of its own
 * orders is neither read nor named, only counted (`notFound`); none of its own: 404 "Order not found.". Every record above is read
 * in the partner scope (row-level security by party) or, for the office-only ones (gates, amendments), in the tenant's scope keyed
 * by exactly those order ids and its party; the requests themselves in the partner scope (its own party, the portal's company,
 * OPEN). Each request's page is the portal's own (portalApproval: the page's permissions, a revised order's prices behind the price
 * grain — never sent here), and a shared file whose content is another customer's is left out (platform/files content-wall). A
 * request id of another customer in the answer is neither answered nor named: counted (`notFound`).
 */

/** The order a request is about, as the customer names it. */
const orderRef = (order: OwnOrder) => ({ orderId: order.orderId, number: order.number, customerRef: order.customerRef })

/**
 * The OPEN approval requests of the customer about these own orders: request id → the orders it is about (in the body's order).
 * Partner scope first (its lines, asks, styles' rounds and swatches), then the tenant's (its gates' rounds, its amendments; keyed by
 * those order ids and its party), then the requests in the partner scope.
 */
async function approvalsOfOrders(request: FastifyRequest, reader: PortalReader, orders: readonly OwnOrder[]): Promise<Map<string, string[]>> {
  const orderIds = orders.map((order) => order.orderId)
  const { partyId } = reader.session
  const companyId = reader.session.company.id
  const own = await request.withClient(async (client) => {
    const lines = await client.salesOrderLine.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, styleId: true } })
    const asks = await client.orderChangeRequest.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true } })
    const styleIds = [...new Set(lines.map((line) => line.styleId))]
    const rounds = styleIds.length === 0 ? [] : await client.sampleRound.findMany({ where: { styleId: { in: styleIds }, partyId }, select: { id: true, styleId: true } })
    const swatches = styleIds.length === 0 ? [] : await client.sampleSwatch.findMany({ where: { styleId: { in: styleIds }, partyId }, select: { id: true, styleId: true } })
    return { lines, asks, rounds, swatches, styleIds }
  })
  const office = await reader.inTenant(async (client) => ({
    gates: await client.orderGate.findMany({ where: { salesOrderId: { in: orderIds }, partyId, sampleRoundId: { not: null } }, select: { salesOrderId: true, sampleRoundId: true } }),
    amendments: await client.salesOrderAmendment.findMany({ where: { orderId: { in: orderIds }, partyId }, select: { id: true, orderId: true } }),
  }))

  // Each record → the orders it is about.
  const about = new Map<string, Set<string>>()
  const add = (recordType: string, recordId: string, orderId: string) => {
    const key = `${recordType}:${recordId}`
    about.set(key, (about.get(key) ?? new Set<string>()).add(orderId))
  }
  const ordersOfStyle = new Map<string, Set<string>>()
  for (const line of own.lines) ordersOfStyle.set(line.styleId, (ordersOfStyle.get(line.styleId) ?? new Set<string>()).add(line.orderId))
  for (const orderId of orderIds) add('SalesOrder', orderId, orderId)
  for (const line of own.lines) add('SalesOrderLine', line.id, line.orderId)
  for (const ask of own.asks) add('OrderChangeRequest', ask.id, ask.orderId)
  for (const amendment of office.amendments) add('SalesOrderAmendment', amendment.id, amendment.orderId)
  for (const gate of office.gates) if (gate.sampleRoundId) add('SampleRound', gate.sampleRoundId, gate.salesOrderId)
  for (const styleId of own.styleIds) for (const orderId of ordersOfStyle.get(styleId) ?? []) add('Style', styleId, orderId)
  for (const round of own.rounds) for (const orderId of ordersOfStyle.get(round.styleId) ?? []) add('SampleRound', round.id, orderId)
  for (const swatch of own.swatches) for (const orderId of ordersOfStyle.get(swatch.styleId) ?? []) add('SampleSwatch', swatch.id, orderId)

  const byType = new Map<string, string[]>()
  for (const key of about.keys()) {
    const [recordType, recordId] = key.split(':') as [string, string]
    byType.set(recordType, [...(byType.get(recordType) ?? []), recordId])
  }
  if (byType.size === 0) return new Map()
  const requests = await request.withClient((client) =>
    client.approvalRequest.findMany({
      where: { companyId, partyId, status: 'OPEN', OR: [...byType].map(([recordType, ids]) => ({ recordType, recordId: { in: ids } })) },
      select: { id: true, partyId: true, recordType: true, recordId: true },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    }),
  )
  const index = new Map(orders.map((order) => [order.orderId, order.index]))
  const out = new Map<string, string[]>()
  for (const row of requests) {
    // The wall once more (row-level security keeps them the party's; fail closed).
    if (row.partyId !== partyId) continue
    const named = about.get(`${row.recordType}:${row.recordId}`)
    if (!named) continue
    out.set(row.id, [...named].sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0)))
  }
  return out
}

/** GET /portal/production/approvals?orderIds= */
export async function approvalsToReview(app: FastifyInstance, request: FastifyRequest, orderIds: readonly string[]) {
  const reader = portalReader(app, request)
  const { orders, notFound } = await partnerOrders(request, reader, orderIds)
  if (orders.length === 0) throw new NotFoundError(ORDER_NOT_FOUND_WORDS.en)
  const about = await approvalsOfOrders(request, reader, orders)
  const orderOf = new Map(orders.map((order) => [order.orderId, order]))
  const pages: { readonly page: Awaited<ReturnType<typeof portalApproval>>; readonly orderIds: readonly string[] }[] = []
  let more = false
  for (const [requestId, ids] of about) {
    if (pages.length >= BULK_REVIEW_MAX) {
      more = true
      break
    }
    try {
      // The portal's own page of the request: its permissions (a revised order also the orders right), its holds, the named
      // approver, the answerer's money rule, its files. A request the person may not read is not listed.
      pages.push({ page: await portalApproval(app, request, requestId), orderIds: ids })
    } catch (error) {
      if (error instanceof NotFoundError) continue
      throw error
    }
  }
  // A file shared with the customer whose content is another customer's (an old copy) is never listed outside the office.
  const walled = await walledForOutside(request, pages.flatMap(({ page }) => page.files.map((file) => file.id)))
  const items = pages.map(({ page, orderIds: ids }) => {
    const bulk = approvesInBulk(page.request.kind)
    const approve = bulk && page.may.answer
    return {
      requestId: page.request.id,
      version: page.request.version,
      kind: page.request.kind,
      words: page.request.words,
      question: page.request.question,
      dueAt: page.request.dueAt,
      orders: ids.flatMap((orderId) => {
        const order = orderOf.get(orderId)
        return order ? [orderRef(order)] : []
      }),
      facts: page.content.facts.map((fact) => ({ label: fact.label, value: fact.value })),
      files: page.files.filter((file) => !walled.has(file.id)).map((file) => ({ id: file.id, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes })),
      may: { approve, held: approve ? null : bulk ? page.may.held : OWN_ANSWER_WORDS[page.locale] },
    }
  })
  const waitingOf = (orderId: string): number => items.filter((item) => item.orders.some((order) => order.orderId === orderId)).length
  return {
    orders: orders.map((order) => ({ ...orderRef(order), waiting: waitingOf(order.orderId) })),
    items,
    /** More approvals wait on these orders than the list holds: the rest are in Waiting for you. */
    more,
    notFound,
    undo: NO_UNDO_WORDS,
  }
}

// ---- POST /portal/production/approvals/answer -------------------------------------------------------------------------------

export interface ApproveManyBody {
  readonly items: readonly ManyItem[]
  readonly typedName: string
}

interface ApproveResult {
  readonly requestId: string
  readonly kind: ApprovalKind
  readonly done: boolean
  readonly status: ApprovalStatus
  readonly code: ApproveRowCode | null
  readonly words: Words
  readonly replayed: boolean
}

/** POST /portal/production/approvals/answer */
export async function approveMany(app: FastifyInstance, request: FastifyRequest, body: ApproveManyBody, idempotencyKey: string | undefined) {
  const problems = approveManyProblems(body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These approvals cannot be sent like this.', problems)
  const answered = await answerManyInPortal(app, request, { items: body.items, typedName: body.typedName, kinds: BULK_APPROVE_KINDS }, idempotencyKey)
  const results: ApproveResult[] = answered.rows.map((row) => {
    const own = row.refusal?.code === 'OWN_ANSWER'
    const code: ApproveRowCode | null = row.done ? null : own ? 'OWN_ANSWER' : approveRowCodeOf(row.refusal?.code ?? '')
    const words = row.done ? APPROVED_WORDS : own ? OWN_ANSWER_WORDS : wordsOfRefusal(row.refusal?.message ?? '')
    return { requestId: row.requestId, kind: row.kind, done: row.done, status: row.status, code, words, replayed: row.replayed }
  })
  // None of its own: the words of an unknown request (another customer's is as unknown as a wrong id).
  if (results.length === 0) throw new NotFoundError('Approval request not found.')
  if (!results.some((row) => row.done)) {
    const indexOf = new Map(body.items.map((item, index) => [item.requestId, index]))
    const issues: Issue[] = results.map((row) => ({ path: `body/items/${indexOf.get(row.requestId) ?? 0}/${row.code ?? 'NOT_DONE'}`, message: row.words.en }))
    throw new DomainError('conflict', issues.length === 1 ? issues[0]!.message : NONE_APPROVED_WORDS.en, issues)
  }
  return {
    results: results.map((row) => ({ requestId: row.requestId, kind: row.kind, done: row.done, status: row.status, code: row.code, words: row.words })),
    notFound: answered.notFound,
    /** Every request done was done by an earlier try of the same Idempotency-Key: nothing ran again. */
    replayed: results.filter((row) => row.done).every((row) => row.replayed),
  }
}
