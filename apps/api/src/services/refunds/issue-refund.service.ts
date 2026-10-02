/**
 * MCP full control 07 O12 — a return's refund, moved out of routes/returns.routes.ts (POST /fulfillment/returns/:id/refund)
 * so the Returns page and Claude's `issue-refund` run the same code. It answers as the route did (RouteAnswer), proven by
 * routes/return-actions-parity.vitest.test.ts, with two changes (07 O12, RED first in routes/return-refund-rules):
 *
 *   - The cap: a refund may not be larger than what is still refundable on its order — what the order paid less the
 *     refunds of all its returns that are in progress or done (PENDING, POSTED, MANUAL_REQUIRED). Above it: 400
 *     OVER_REFUNDABLE, nothing recorded, nothing sent. (A return without an order has no cap here; its channel push
 *     fails without an order anyway.)
 *   - A refund that goes through publishes `refund.issued` (ids, channel and outcome; never the amount or the buyer).
 *
 * R5.1 — every call creates a Refund row and a RefundAttempt row; Return.refund* is a write-through cache. One refund
 * at a time per return: a fail-fast 409 here, the partial unique index Refund_oneActivePerReturn underneath.
 * H.14 — the channel push (refund-publisher.service: eBay real, Amazon finish in Seller Central, Shopify behind
 * NEXUS_ENABLE_SHOPIFY_REFUND, Woo/Etsy not wired). A channel failure leaves the return as it was (CHANNEL_FAILED).
 */

import prisma from '../../db.js'
import { auditLogService } from '../audit-log.service.js'
import { publishEvent } from '../../lib/events/publish.js'
import { AnswerReply, RouteAnswer, answered, type RouteLog } from '../../lib/route-answer.js'
import type { ReturnWho } from '../returns/return-actions.service.js'
import { suppressReviewRequestsForRefund } from '../reviews/review-request.service.js'

/** Refund statuses that hold money: in progress or done. (FAILED and NOT_IMPLEMENTED can be posted again.) */
export const ACTIVE_REFUND_STATUSES = ['PENDING', 'POSTED', 'MANUAL_REQUIRED'] as const

export interface Refundable {
  orderId: string
  channelOrderId: string
  currencyCode: string
  paidCents: number
  refundedCents: number
  leftCents: number
}

type RefundReader = Pick<typeof prisma, 'order' | 'refund'>

/**
 * What is still refundable on an order: what it paid less the active refunds of all its returns. Null: no such order.
 * `db` is the transaction that holds the order's row lock when the answer decides a refund (see issueRefund).
 */
export async function refundableOn(orderId: string, db: RefundReader = prisma): Promise<Refundable | null> {
  const order = await db.order.findFirst({ where: { id: orderId }, select: { id: true, channelOrderId: true, currencyCode: true, totalPrice: true } })
  if (!order) return null
  const refunded = await db.refund.aggregate({
    where: { return: { orderId }, channelStatus: { in: [...ACTIVE_REFUND_STATUSES] } },
    _sum: { amountCents: true },
  })
  const paidCents = Math.round(Number(order.totalPrice) * 100)
  const refundedCents = refunded._sum.amountCents ?? 0
  return {
    orderId: order.id,
    channelOrderId: order.channelOrderId,
    currencyCode: order.currencyCode ?? 'EUR',
    paidCents,
    refundedCents,
    leftCents: Math.max(0, paidCents - refundedCents),
  }
}

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`

/** The cap refused the refund (thrown inside the locked transaction, answered as 400 OVER_REFUNDABLE). */
class OverRefundable extends Error {
  constructor(readonly cap: Refundable, readonly amountCents: number) {
    super('over refundable')
  }
}

export interface RefundBody {
  /** The amount to refund, in cents. Required (or staged on Return.refundCents first). */
  refundCents?: number
  kind?: 'CASH' | 'STORE_CREDIT' | 'EXCHANGE'
  /** True when the refund was already issued in the channel's back office and Nexus only records it. */
  skipChannelPush?: boolean
  /** Channel-reason text override (eBay's `comment`, …). */
  reason?: string
  // RX.3 — per-line allocation + order-level fee breakdown. amountCents stays the NET moved to the buyer.
  perLineAmounts?: Record<string, number>
  grossCents?: number
  restockingFeeCents?: number
  returnShippingFeeCents?: number
}

async function refundIssued(log: RouteLog, payload: { refundId: string; returnId: string; orderId: string | null; channel: string; outcome: 'OK' | 'OK_MANUAL_REQUIRED' | 'NOT_IMPLEMENTED' | 'SKIPPED' }, rmaNumber: string | null) {
  // The refund already went through: an event or a suppression that cannot be written is logged, never turned into a
  // failed refund.
  try {
    await publishEvent(prisma, 'refund.issued', payload)
  } catch (err) {
    log.error({ err, refundId: payload.refundId }, 'refund.issued event write failed')
  }
  // A refunded buyer is not asked for a review (2026-10-02).
  if (payload.orderId) {
    try {
      await suppressReviewRequestsForRefund(payload.orderId, rmaNumber)
    } catch (err) {
      log.error({ err, refundId: payload.refundId }, 'review-request suppression after a refund failed')
    }
  }
}

/** POST /fulfillment/returns/:id/refund. `actor` is the x-user-id the page sent (a tool: its user). */
export async function issueRefund(id: string, body: RefundBody, actor: string | null, who: ReturnWho, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  try {
    // Resolve the Return so we know channel + currency.
    const ret = await prisma.return.findUnique({
      where: { id },
      select: {
        id: true, channel: true, currencyCode: true, refundCents: true, refundedAt: true, orderId: true, rmaNumber: true,
        items: { select: { id: true } },
      },
    })
    if (!ret) return reply.code(404).send({ error: 'Return not found' })

    // F1.1 — race guard: fail fast when a non-failed Refund already exists (the partial unique index is the bedrock).
    const existingActive = await prisma.refund.findFirst({
      where: {
        returnId: id,
        channelStatus: { in: [...ACTIVE_REFUND_STATUSES] },
      },
      select: { id: true, channelStatus: true },
    })
    if (existingActive) {
      return reply.code(409).send({
        error: 'A refund is already in progress or completed for this return',
        existingRefundId: existingActive.id,
        existingRefundStatus: existingActive.channelStatus,
      })
    }

    // The amount: the body's, else the one staged on Return.refundCents.
    const amountCents = typeof body.refundCents === 'number' && body.refundCents > 0
      ? body.refundCents
      : ret.refundCents
    if (!amountCents || amountCents <= 0) {
      return reply.code(400).send({ error: 'refundCents required (or stage on Return first)' })
    }

    // RX.3 — validate + normalise the per-line allocation. It is forwarded to the channel only when it sums exactly
    // to the net amount, so a channel push can never disagree with the total marked refunded.
    let perLineAmounts: Record<string, number> | null = null
    if (body.perLineAmounts && typeof body.perLineAmounts === 'object') {
      const validIds = new Set(ret.items.map((i) => i.id))
      const norm: Record<string, number> = {}
      for (const [k, v] of Object.entries(body.perLineAmounts)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue
        if (!validIds.has(k)) {
          return reply.code(400).send({ error: `perLineAmounts references unknown return item ${k}` })
        }
        norm[k] = Math.round(v)
      }
      if (Object.keys(norm).length) perLineAmounts = norm
    }
    const sumPerLine = perLineAmounts
      ? Object.values(perLineAmounts).reduce((a, b) => a + b, 0)
      : 0

    // A channel whose refund switch is off: a dry run moves no money, so nothing is recorded and the return stays as it
    // was (2026-10-02, 100 % honest UI). Recording one done elsewhere (skipChannelPush) is not a dry run.
    const dryRun = body.skipChannelPush ? null : (await import('./refund-publisher.service.js')).refundDryRunMessage(ret.channel)
    if (dryRun) {
      const unchanged = await prisma.return.findUnique({ where: { id } })
      return answered({ ...unchanged, refundId: null, channelOutcome: 'DRY_RUN', channelMessage: dryRun })
    }

    // RX.3 — fee breakdown note for the fiscal/audit trail. The net (amountCents) is authoritative.
    const feeParts: string[] = []
    const c = (cents: number) => `€${(cents / 100).toFixed(2)}`
    if (typeof body.grossCents === 'number' && body.grossCents > amountCents) feeParts.push(`gross ${c(body.grossCents)}`)
    if (typeof body.restockingFeeCents === 'number' && body.restockingFeeCents > 0) feeParts.push(`restocking −${c(body.restockingFeeCents)}`)
    if (typeof body.returnShippingFeeCents === 'number' && body.returnShippingFeeCents > 0) feeParts.push(`return shipping −${c(body.returnShippingFeeCents)}`)
    const feeNote = feeParts.length ? `Net ${c(amountCents)} (${feeParts.join(', ')})` : null

    // 07 O12 — the cap, the staged amount and the Refund row (PENDING) in ONE transaction that holds the order's row
    // lock: two refunds of two returns of one order at the same moment are taken one after the other, so the second
    // sees the first and what the order paid is never exceeded (2026-10-02; refund-cap-postgres.vitest.test.ts).
    // F1.1 — the partial unique index rejects a racing second insert for the SAME return with P2002: 409, not 500.
    let refund
    try {
      refund = await prisma.$transaction(async (tx) => {
        if (ret.orderId) {
          await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${ret.orderId} FOR UPDATE`
          const cap = await refundableOn(ret.orderId, tx)
          if (cap && amountCents > cap.leftCents) throw new OverRefundable(cap, amountCents)
        }
        // Stage the cache so the channel publisher (which reads ret.refundCents) sees the amount we intend to issue.
        if (ret.refundCents !== amountCents) {
          await tx.return.update({
            where: { id },
            data: { refundCents: amountCents },
          })
        }
        return tx.refund.create({
          data: {
            returnId: id,
            amountCents,
            currencyCode: ret.currencyCode || 'EUR',
            kind: (body.kind ?? 'CASH') as any,
            reason: body.reason ?? null,
            perLineAmounts: (perLineAmounts ?? undefined) as any,
            notes: feeNote,
            channel: ret.channel,
            channelStatus: 'PENDING',
            actor,
          },
        })
      })
    } catch (err: any) {
      if (err instanceof OverRefundable) {
        const { cap } = err
        return reply.code(400).send({
          error: `Refund of ${money(amountCents, cap.currencyCode)} is more than is still refundable on order ${cap.channelOrderId}: ${money(cap.leftCents, cap.currencyCode)} (paid ${money(cap.paidCents, cap.currencyCode)}, refunded ${money(cap.refundedCents, cap.currencyCode)}). Nothing was refunded.`,
          code: 'OVER_REFUNDABLE',
          refundableCents: cap.leftCents,
          paidCents: cap.paidCents,
          refundedCents: cap.refundedCents,
        })
      }
      if (err?.code === 'P2002') {
        return reply.code(409).send({
          error: 'A refund is already in progress for this return (concurrent attempt)',
        })
      }
      throw err
    }

    // 2) Skip-channel path: refunded in the channel's back office already. Refund POSTED, Return REFUNDED.
    if (body.skipChannelPush) {
      const now = new Date()
      await prisma.refundAttempt.create({
        data: { refundId: refund.id, outcome: 'SKIPPED' },
      })
      await prisma.refund.update({
        where: { id: refund.id },
        data: { channelStatus: 'POSTED', channelPostedAt: now },
      })
      const updated = await prisma.return.update({
        where: { id },
        data: {
          status: 'REFUNDED',
          refundStatus: 'REFUNDED',
          refundedAt: now,
          channelRefundError: null,
          version: { increment: 1 },
        },
      })
      void auditLogService.write({
        ...who,
        entityType: 'Return',
        entityId: id,
        action: 'refund',
        after: {
          status: updated.status,
          refundId: refund.id,
          refundCents: amountCents,
          channelOutcome: 'SKIPPED',
        },
      })
      await refundIssued(log, { refundId: refund.id, returnId: id, orderId: ret.orderId, channel: ret.channel, outcome: 'SKIPPED' }, ret.rmaNumber)
      // F1.4 — the Italian nota di credito number, allocated lazily when value actually moves. Errors don't block the
      // refund; the operator can retry via the assign endpoint.
      void (async () => {
        try {
          const { assignCreditNoteNumber } = await import('../credit-note.service.js')
          await assignCreditNoteNumber(refund.id)
        } catch (e: any) {
          log.error(
            { refundId: refund.id, err: e?.message },
            'credit-note auto-assign failed (skipChannelPush path)',
          )
        }
      })()
      return answered({ ...updated, refundId: refund.id, channelOutcome: 'SKIPPED' })
    }

    // 3) Channel publish. The publisher returns a structured outcome and never throws (a DRY_RUN is answered above).
    const t0 = Date.now()
    const { publishRefundToChannel } = await import('./refund-publisher.service.js')
    const publish = await publishRefundToChannel({
      returnId: id,
      reasonText: body.reason,
      // Only line-level amounts that reconcile to the net total.
      ...(perLineAmounts && sumPerLine === amountCents ? { itemAmountsCents: perLineAmounts } : {}),
    })
    const durationMs = Date.now() - t0

    // 4) Record the attempt whatever its outcome.
    await prisma.refundAttempt.create({
      data: {
        refundId: refund.id,
        outcome: publish.outcome,
        channelRefundId: publish.channelRefundId ?? null,
        errorMessage: publish.error ?? null,
        durationMs,
        rawResponse: {
          outcome: publish.outcome,
          channelRefundId: publish.channelRefundId ?? null,
          channelMessage: publish.channelMessage ?? null,
        } as any,
      },
    })

    // A dry run that slipped past the check above (its switch flipped meanwhile): nothing moved, nothing stays recorded.
    if (publish.outcome === 'DRY_RUN') {
      await prisma.refund.delete({ where: { id: refund.id } })
      if (ret.refundCents !== amountCents) await prisma.return.update({ where: { id }, data: { refundCents: ret.refundCents } })
      const unchanged = await prisma.return.findUnique({ where: { id } })
      return answered({ ...unchanged, refundId: null, channelOutcome: 'DRY_RUN', channelMessage: publish.channelMessage })
    }

    // 5) The Refund row from the publish result.
    const channelStatus =
      publish.outcome === 'FAILED' ? 'FAILED' :
      publish.outcome === 'NOT_IMPLEMENTED' ? 'NOT_IMPLEMENTED' :
      publish.outcome === 'OK_MANUAL_REQUIRED' ? 'MANUAL_REQUIRED' :
      'POSTED'
    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        channelStatus: channelStatus as any,
        channelRefundId: publish.channelRefundId ?? null,
        channelError: publish.outcome === 'FAILED' ? (publish.error ?? 'Unknown channel error') : null,
        channelPostedAt: publish.outcome === 'OK' ? new Date() : null,
      },
    })

    // 6) FAILED → the Return keeps its status so the operator can retry; refundStatus=CHANNEL_FAILED with the error.
    if (publish.outcome === 'FAILED') {
      const updated = await prisma.return.update({
        where: { id },
        data: {
          refundStatus: 'CHANNEL_FAILED',
          channelRefundError: publish.error ?? 'Unknown channel error',
          version: { increment: 1 },
        },
      })
      void auditLogService.write({
        ...who,
        entityType: 'Return',
        entityId: id,
        action: 'refund-failed',
        after: {
          refundId: refund.id,
          refundStatus: updated.refundStatus,
          channelError: publish.error,
          channelOutcome: 'FAILED',
        },
      })
      return reply.code(502).send({
        ...updated,
        refundId: refund.id,
        channelOutcome: 'FAILED',
        channelError: publish.error,
      })
    }

    // 7) OK / OK_MANUAL_REQUIRED / NOT_IMPLEMENTED → Return REFUNDED + the channel refund id on the cache.
    const updated = await prisma.return.update({
      where: { id },
      data: {
        status: 'REFUNDED',
        refundStatus: 'REFUNDED',
        refundedAt: new Date(),
        channelRefundId: publish.channelRefundId ?? null,
        channelRefundedAt: publish.outcome === 'OK' ? new Date() : null,
        channelRefundError: null,
        version: { increment: 1 },
      },
    })
    void auditLogService.write({
      ...who,
      entityType: 'Return',
      entityId: id,
      action: 'refund',
      after: {
        status: updated.status,
        refundId: refund.id,
        refundCents: amountCents,
        channelOutcome: publish.outcome,
        channelRefundId: publish.channelRefundId,
      },
    })
    await refundIssued(log, { refundId: refund.id, returnId: id, orderId: ret.orderId, channel: ret.channel, outcome: publish.outcome }, ret.rmaNumber)
    // F1.4 — the nota di credito number only when the channel refund landed cleanly (OK). OK_MANUAL_REQUIRED /
    // NOT_IMPLEMENTED are not yet posted value movements; the operator promotes them later.
    if (publish.outcome === 'OK') {
      void (async () => {
        try {
          const { assignCreditNoteNumber } = await import('../credit-note.service.js')
          await assignCreditNoteNumber(refund.id)
        } catch (e: any) {
          log.error(
            { refundId: refund.id, err: e?.message },
            'credit-note auto-assign failed (channel-publish path)',
          )
        }
      })()
    }
    return answered({
      ...updated,
      refundId: refund.id,
      channelOutcome: publish.outcome,
      channelMessage: publish.channelMessage,
      channelRefundId: publish.channelRefundId,
    })
  } catch (error: any) {
    return reply.code(500).send({ error: error?.message ?? String(error) })
  }
}
