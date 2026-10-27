/**
 * Reviews › eBay — "Leave feedback for buyers" (2026-10-27, build spec B19 / PR G).
 *
 *   refreshEbayBuyerFeedback()   with the 30-minute review pass: eBay's sales that wait for the seller's feedback
 *                                (REST getItemsAwaitingFeedback, a read through the gateway) → EbayBuyerFeedback rows,
 *                                each matched to its Nexus order (buyer, market, sale date come from that order).
 *   listEbayBuyerFeedback()      GET  /api/reviews/area/ebay/buyer-feedback?market=   the queue with why each line is held
 *   sendEbayBuyerFeedback()      POST /api/reviews/area/ebay/buyer-feedback/send { ids ≤ 200, text }
 *
 * Nexus never leaves feedback by itself. "Send for approval" asks through the same door as every other change
 * (approval-gate.service.ts requestApproval): ONE ticked sale = one request of the tool `leave-buyer-feedback`; several =
 * ONE change plan with one step per sale. A person who may approve decides it on the Approvals page; only then does the
 * tool call eBay (leaveFeedback, POSITIVE only). eBay's rules (`@nexus/shared/review-reply-rules`): positive only, up to
 * 500 characters, within 90 days of the completed sale; a sale with an open return or case is held until it closes.
 * Every line follows its approval on each read (`syncBuyerFeedbackApprovals`): declined, expired or failed → it waits
 * again, with why.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import type { Prisma } from '@prisma/client'
import {
  EBAY_BUYER_FEEDBACK_LIMIT, EBAY_BUYER_FEEDBACK_RULE, buyerFeedbackDaysLeft, buyerFeedbackLineHeld, buyerFeedbackTextHeld,
} from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { UserPrincipal } from '../agents/call-tool.js'
import { tryResolveConnection } from '../connection-resolver.service.js'
import { matchEbayOrderLines } from './adapters/ebay-feedback.adapter.js'
import { readItemsAwaitingFeedback, type AwaitingLine, type RestDeps } from './adapters/ebay-feedback-rest.adapter.js'
import { ACTIVE_RETURN_STATUSES } from './review-request.service.js'

/** The approved tool that leaves the feedback (agents/tools/review-actions.tools.ts). */
export const LEAVE_TOOL = 'leave-buyer-feedback'
export const BUYER_FEEDBACK_SEND_MAX = 200
/** A line left from Nexus stays in the list this long, so the person sees it went. */
const LEFT_SHOWN_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

export class BuyerFeedbackInputError extends Error {
  readonly statusCode = 400
}

// ── Refresh (with the review pass) ───────────────────────────────────

/**
 * eBay's list of sales waiting for the seller's feedback → rows. New lines arrive as AWAITING; a line eBay no longer
 * lists (left on eBay, or too late) becomes GONE once the whole list was read. Lines left from Nexus stay LEFT. Never
 * throws for eBay's sake: eBay off, no account or a refused read comes back as a note.
 */
export async function refreshEbayBuyerFeedback(deps: RestDeps = {}, now = new Date()): Promise<{ note?: string; lines: number }> {
  const connection = await tryResolveConnection({ channel: 'EBAY', primary: true })
  if (!connection) return { note: 'no active eBay connection', lines: 0 }
  const read = await readItemsAwaitingFeedback(connection.id, deps)
  if (!read.ok) return { note: (read as Extract<typeof read, { ok: false }>).words, lines: 0 }
  await storeAwaitingLines(connection.id, read.lines, read.complete, now)
  return { lines: read.lines.length }
}

/** Stores one read of eBay's list for one account (exported for tests). */
export async function storeAwaitingLines(connectionId: string, lines: readonly AwaitingLine[], complete: boolean, now = new Date()): Promise<void> {
  const matches = await matchEbayOrderLines(lines.map((l) => ({ orderLineItemId: l.orderLineItemId, transactionId: l.transactionId, itemId: l.listingId })))
  const existing = await prisma.ebayBuyerFeedback.findMany({
    where: { connectionId, orderLineItemId: { in: lines.map((l) => l.orderLineItemId) } },
    select: { id: true, orderLineItemId: true, state: true },
  })
  const byLine = new Map(existing.map((e) => [e.orderLineItemId, e]))
  for (const [i, line] of lines.entries()) {
    const facts = {
      listingId: line.listingId,
      transactionId: line.transactionId,
      title: line.title,
      price: line.price,
      currency: line.currency,
      ...(matches[i] ? { orderId: matches[i]!.orderId } : {}),
      lastSeenAt: now,
    }
    const row = byLine.get(line.orderLineItemId)
    if (!row) {
      await prisma.ebayBuyerFeedback.upsert({
        where: { connectionId_orderLineItemId: workspaceKey({ connectionId, orderLineItemId: line.orderLineItemId }) },
        create: { connectionId, orderLineItemId: line.orderLineItemId, ...facts, firstSeenAt: now },
        update: facts,
      })
    } else {
      // eBay lists it again (a GONE line that came back): it waits again. A line left from Nexus stays LEFT.
      await prisma.ebayBuyerFeedback.update({ where: { id: row.id }, data: { ...facts, ...(row.state === 'GONE' ? { state: 'AWAITING' } : {}) } })
    }
  }
  if (complete) {
    await prisma.ebayBuyerFeedback.updateMany({
      where: { connectionId, state: 'AWAITING', lastSeenAt: { lt: now } },
      data: { state: 'GONE' },
    })
  }
}

// ── Following the approvals ──────────────────────────────────────────

/**
 * Every line with an approval follows it: declined or expired → it waits again with why; a change plan that ran
 * without leaving this line's feedback → it waits again with the step's reason; a single request whose run failed
 * stays waiting on the Approvals page (it can be approved again or declined) and says why. Idempotent.
 */
export async function syncBuyerFeedbackApprovals(): Promise<number> {
  const rows = await prisma.ebayBuyerFeedback.findMany({ where: { approvalId: { not: null } }, select: { id: true, approvalId: true, state: true } })
  if (rows.length === 0) return 0
  const ids = [...new Set(rows.map((r) => r.approvalId!))]
  const [approvals, steps] = await Promise.all([
    prisma.agentApproval.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, reason: true, decidedBy: true } }),
    prisma.agentPlanStep.findMany({ where: { approvalId: { in: ids }, toolName: LEAVE_TOOL }, select: { approvalId: true, args: true, status: true, reason: true } }),
  ])
  const byId = new Map(approvals.map((a) => [a.id, a]))
  let moved = 0
  for (const row of rows) {
    const approval = byId.get(row.approvalId!)
    let data: Prisma.EbayBuyerFeedbackUpdateManyMutationInput | null = null
    if (row.state !== 'AWAITING') {
      data = { approvalId: null }
    } else if (!approval) {
      data = { approvalId: null, lastWords: 'Its approval request is gone: send it again.' }
    } else if (approval.status === 'rejected' || approval.status === 'expired') {
      const withdrawn = (approval.reason ?? '').startsWith('withdrawn')
      data = {
        approvalId: null,
        lastWords: withdrawn ? 'Withdrawn before anyone approved it.' : approval.status === 'expired' ? 'Nobody approved it before it expired.' : `Declined on the Approvals page${approval.decidedBy ? ` by ${approval.decidedBy}` : ''}.`,
      }
    } else if (approval.status === 'executed') {
      const step = steps.find((s) => s.approvalId === approval.id && (s.args as { lineId?: unknown } | null)?.lineId === row.id)
      data = { approvalId: null, lastWords: step?.reason ? `Not left: ${step.reason}` : 'The approved change ran but did not leave this feedback. Send it again.' }
    } else if (approval.status === 'pending' && (approval.reason ?? '').startsWith('execution failed')) {
      data = { lastWords: `eBay did not take it: ${approval.reason!.replace(/^execution failed:\s*/, '')} It still waits on the Approvals page.` }
    }
    if (!data) continue
    const done = await prisma.ebayBuyerFeedback.updateMany({ where: { id: row.id, approvalId: row.approvalId }, data })
    moved += done.count
  }
  return moved
}

// ── The list ─────────────────────────────────────────────────────────

export interface BuyerFeedbackRow {
  id: string
  orderLineItemId: string
  title: string | null
  price: string | null
  currency: string | null
  buyer: string | null
  order: { id: string; label: string } | null
  market: string | null
  /** The sale (the Nexus order's purchase date); null when Nexus does not have the order. */
  soldAt: string | null
  daysLeft: number | null
  state: 'AWAITING' | 'LEFT' | 'GONE'
  /** Why it cannot be sent now (words), or null. */
  held: string | null
  approval: { id: string; words: string } | null
  left: { at: string | null; by: string | null; text: string | null } | null
  lastWords: string | null
  firstSeenAt: string
}

export interface BuyerFeedbackPage {
  rows: BuyerFeedbackRow[]
  counts: { awaiting: number; ready: number; waitingApproval: number; held: number; left: number }
  /** When eBay's list was last read for this business (ISO), or null when it never was. */
  readAt: string | null
  /** Why the list may be empty or old, in words, or null. */
  readWords: string | null
  rule: string
  limit: number
}

function marketOf(raw: string | null | undefined): string | null {
  const code = raw?.trim().toUpperCase() ?? ''
  if (!/^[A-Z]{2}$/.test(code)) return null
  return code === 'GB' ? 'UK' : code
}

/** The queue, newest first: what waits (and why some are held) and what was left from Nexus lately. */
export async function listEbayBuyerFeedback(input: { market?: unknown; now?: Date } = {}): Promise<BuyerFeedbackPage> {
  const now = input.now ?? new Date()
  const market = typeof input.market === 'string' ? marketOf(input.market) : null
  await syncBuyerFeedbackApprovals().catch((error) => logger.warn('[ebay-buyer-feedback] sync with approvals failed', { error: error instanceof Error ? error.message : String(error) }))
  const rows = await prisma.ebayBuyerFeedback.findMany({
    where: { OR: [{ state: 'AWAITING' }, { state: 'LEFT', leftAt: { gte: new Date(now.getTime() - LEFT_SHOWN_DAYS * DAY_MS) } }] },
    orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
    take: 500,
  })
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => !!id))]
  const [orders, returns, lastRead] = await Promise.all([
    orderIds.length
      ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, channelOrderId: true, marketplace: true, purchaseDate: true, createdAt: true, customerName: true } })
      : Promise.resolve([] as Array<{ id: string; channelOrderId: string; marketplace: string | null; purchaseDate: Date | null; createdAt: Date; customerName: string }>),
    orderIds.length
      ? prisma.return.findMany({ where: { orderId: { in: orderIds }, status: { in: [...ACTIVE_RETURN_STATUSES] } }, select: { orderId: true } })
      : Promise.resolve([] as Array<{ orderId: string | null }>),
    prisma.ebayBuyerFeedback.aggregate({ _max: { lastSeenAt: true } }),
  ])
  const orderById = new Map(orders.map((o) => [o.id, o]))
  const openReturn = new Set(returns.map((r) => r.orderId).filter((id): id is string => !!id))

  const out: BuyerFeedbackRow[] = []
  for (const r of rows) {
    const order = r.orderId ? orderById.get(r.orderId) : undefined
    const rowMarket = marketOf(order?.marketplace)
    if (market && rowMarket !== market) continue
    const soldAt = order ? order.purchaseDate ?? order.createdAt : null
    const state = (r.state === 'LEFT' || r.state === 'GONE' ? r.state : 'AWAITING') as BuyerFeedbackRow['state']
    out.push({
      id: r.id,
      orderLineItemId: r.orderLineItemId,
      title: r.title,
      price: r.price != null ? r.price.toString() : null,
      currency: r.currency,
      buyer: order?.customerName?.trim() || null,
      order: order ? { id: order.id, label: order.channelOrderId } : null,
      market: rowMarket,
      soldAt: soldAt?.toISOString() ?? null,
      daysLeft: state === 'AWAITING' ? buyerFeedbackDaysLeft(soldAt, now) : null,
      state,
      held: buyerFeedbackLineHeld({ state, waiting: !!r.approvalId, soldAt, openReturn: !!r.orderId && openReturn.has(r.orderId) }, now),
      approval: r.approvalId ? { id: r.approvalId, words: 'Waits for approval on the Approvals page' } : null,
      left: state === 'LEFT' ? { at: r.leftAt?.toISOString() ?? null, by: r.leftBy, text: r.commentText } : null,
      lastWords: r.lastWords,
      firstSeenAt: r.firstSeenAt.toISOString(),
    })
  }
  const awaiting = out.filter((r) => r.state === 'AWAITING')
  const readAt = lastRead._max.lastSeenAt
  const readWords = process.env.NEXUS_EBAY_REAL_API !== 'true'
    ? 'Nexus does not read eBay in this setup, so this list does not update.'
    : !readAt
      ? 'eBay’s list of sales waiting for your feedback has not been read yet. Nexus reads it every 30 minutes.'
      : null
  return {
    rows: out,
    counts: {
      awaiting: awaiting.length,
      ready: awaiting.filter((r) => !r.held).length,
      waitingApproval: awaiting.filter((r) => r.approval).length,
      held: awaiting.filter((r) => r.held && !r.approval).length,
      left: out.filter((r) => r.state === 'LEFT').length,
    },
    readAt: readAt?.toISOString() ?? null,
    readWords,
    rule: EBAY_BUYER_FEEDBACK_RULE,
    limit: EBAY_BUYER_FEEDBACK_LIMIT,
  }
}

// ── Send for approval ────────────────────────────────────────────────

export interface SendAnswer {
  changed: number
  held: Array<{ id: string; words: string }>
  /** The approval the sendable lines went into: one request, or ONE change plan. */
  sent: { approvalId: string; kind: 'request' | 'plan'; lines: number; expiresAt: string | null } | null
}

type Requester = (tool: string, args: Record<string, unknown>, person: UserPrincipal) => Promise<{
  ok: boolean
  mode: string
  approvalId?: string
  expiresAt?: Date | null
  error?: string
  refusals?: Array<{ step: number; tool: string; error: string }>
}>

async function defaultRequester(): Promise<{ ask: Requester; planTool: string }> {
  const [{ requestApproval }, { PLAN_TOOL }] = await Promise.all([import('../agents/approval-gate.service.js'), import('../agents/tool-types.js')])
  return { ask: requestApproval as Requester, planTool: PLAN_TOOL }
}

/** Validates the body: the ticked ids (1–200) and the feedback text (eBay's limit). Throws BuyerFeedbackInputError. */
export function parseSendBody(body: unknown): { ids: string[]; text: string } {
  const b = (body ?? {}) as { ids?: unknown; text?: unknown }
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))] : []
  if (ids.length === 0) throw new BuyerFeedbackInputError('Tick at least one sale.')
  if (ids.length > BUYER_FEEDBACK_SEND_MAX) throw new BuyerFeedbackInputError(`Send at most ${BUYER_FEEDBACK_SEND_MAX} at once.`)
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  const held = buyerFeedbackTextHeld(text)
  if (held) throw new BuyerFeedbackInputError(held)
  return { ids, text }
}

/**
 * "Send for approval": the ticked sales that may get feedback go to ONE approval (a request for one sale, a change plan
 * for several), each held line says why. A step the door refuses holds only its own line; the rest are asked again
 * (at most three rounds). Nothing reaches eBay here.
 */
export async function sendEbayBuyerFeedback(body: unknown, person: UserPrincipal, opts: { now?: Date; requester?: { ask: Requester; planTool: string } } = {}): Promise<SendAnswer> {
  const now = opts.now ?? new Date()
  const { ids, text } = parseSendBody(body)
  await syncBuyerFeedbackApprovals().catch(() => 0)
  const rows = await prisma.ebayBuyerFeedback.findMany({ where: { id: { in: ids } }, select: { id: true, state: true, approvalId: true, orderId: true, title: true } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => !!id))]
  const [orders, returns] = await Promise.all([
    orderIds.length ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, purchaseDate: true, createdAt: true } }) : Promise.resolve([]),
    orderIds.length ? prisma.return.findMany({ where: { orderId: { in: orderIds }, status: { in: [...ACTIVE_RETURN_STATUSES] } }, select: { orderId: true } }) : Promise.resolve([]),
  ])
  const soldOf = new Map(orders.map((o) => [o.id, o.purchaseDate ?? o.createdAt]))
  const openReturn = new Set(returns.map((r) => r.orderId))

  const held: SendAnswer['held'] = []
  let sendable: string[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      held.push({ id, words: 'Not found in this business’s list of sales waiting for feedback.' })
      continue
    }
    const why = buyerFeedbackLineHeld({ state: row.state, waiting: !!row.approvalId, soldAt: row.orderId ? soldOf.get(row.orderId) ?? null : null, openReturn: !!row.orderId && openReturn.has(row.orderId) }, now)
    if (why) held.push({ id, words: why })
    else sendable.push(id)
  }

  let sent: SendAnswer['sent'] = null
  const door = sendable.length ? opts.requester ?? (await defaultRequester()) : null
  for (let round = 0; round < 3 && sendable.length > 0 && door; round++) {
    const single = sendable.length === 1
    const asked = single
      ? await door.ask(LEAVE_TOOL, { lineId: sendable[0], text }, person)
      : await door.ask(door.planTool, {
          title: `eBay: positive feedback for ${sendable.length} buyers`.slice(0, 120),
          steps: sendable.map((lineId) => ({ tool: LEAVE_TOOL, args: { lineId, text } })),
        }, person)
    if (asked.ok && asked.mode === 'queued' && asked.approvalId) {
      const done = await prisma.ebayBuyerFeedback.updateMany({
        where: { id: { in: sendable }, state: 'AWAITING', approvalId: null },
        data: { approvalId: asked.approvalId, lastWords: null },
      })
      sent = { approvalId: asked.approvalId, kind: single ? 'request' : 'plan', lines: done.count, expiresAt: asked.expiresAt ? new Date(asked.expiresAt).toISOString() : null }
      break
    }
    if (!single && asked.refusals?.length) {
      const refused = new Map<string, string>()
      for (const r of asked.refusals) {
        const id = sendable[r.step - 1]
        if (id && !refused.has(id)) refused.set(id, `Not sent: ${r.error}`)
      }
      if (refused.size > 0) {
        for (const [id, words] of refused) held.push({ id, words })
        sendable = sendable.filter((id) => !refused.has(id))
        continue
      }
    }
    for (const id of sendable) held.push({ id, words: asked.error ? `Not sent: ${asked.error}` : 'Not sent: the approval request was refused.' })
    sendable = []
  }
  return { changed: sent?.lines ?? 0, held, sent }
}

// ── One line, for the approved tool ──────────────────────────────────

export interface LineFacts {
  id: string
  connectionId: string
  orderLineItemId: string
  listingId: string | null
  transactionId: string | null
  title: string | null
  state: string
  approvalId: string | null
  buyer: string | null
  order: { id: string; label: string; market: string | null } | null
  soldAt: Date | null
  openReturn: boolean
}

/** Everything the tool `leave-buyer-feedback` checks about one line; null when it is not in this business. */
export async function buyerFeedbackLine(lineId: string): Promise<LineFacts | null> {
  const row = await prisma.ebayBuyerFeedback.findUnique({ where: { id: lineId } })
  if (!row) return null
  const [order, openReturns] = await Promise.all([
    row.orderId ? prisma.order.findUnique({ where: { id: row.orderId }, select: { id: true, channelOrderId: true, marketplace: true, purchaseDate: true, createdAt: true, customerName: true } }) : Promise.resolve(null),
    row.orderId ? prisma.return.count({ where: { orderId: row.orderId, status: { in: [...ACTIVE_RETURN_STATUSES] } } }) : Promise.resolve(0),
  ])
  return {
    id: row.id,
    connectionId: row.connectionId,
    orderLineItemId: row.orderLineItemId,
    listingId: row.listingId,
    transactionId: row.transactionId,
    title: row.title,
    state: row.state,
    approvalId: row.approvalId,
    buyer: order?.customerName?.trim() || null,
    order: order ? { id: order.id, label: order.channelOrderId, market: marketOf(order.marketplace) } : null,
    soldAt: order ? order.purchaseDate ?? order.createdAt : null,
    openReturn: openReturns > 0,
  }
}

/** After eBay took it: the line is LEFT, with what was left, eBay's id, who approved it and when. */
export async function markBuyerFeedbackLeft(lineId: string, left: { text: string; feedbackId: string | null; by: string }, now = new Date()): Promise<void> {
  await prisma.ebayBuyerFeedback.update({
    where: { id: lineId },
    data: { state: 'LEFT', commentText: left.text, feedbackId: left.feedbackId, leftBy: left.by, leftAt: now, approvalId: null, lastWords: null },
  })
}

/** eBay refused it: the line keeps waiting, with eBay's words. */
export async function markBuyerFeedbackRefused(lineId: string, words: string): Promise<void> {
  await prisma.ebayBuyerFeedback.update({ where: { id: lineId }, data: { lastWords: words } })
}
