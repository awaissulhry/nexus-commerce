/**
 * MCP full control 08 S5 — the promotion reads, out of the routes, so the pricing pages and Claude's pricing tools read the same
 * thing. Each function is the body of its route, moved as it was (pricing-read.vitest.test.ts holds the routes'
 * answers): the route keeps its error handling and returns what the function returns.
 *
 *   listPromotions  GET /api/pricing/promotions
 *   createPromotion POST /api/pricing/promotions        (08 S12)
 *   endPromotion    DELETE /api/pricing/promotions/:id  (and every sale it set ends through the price door)
 * A refusal is a PromotionError carrying the status and the sentence the route answers with.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { endPromotionSales } from '../promotion-scheduler.service.js'

/** GET /api/pricing/promotions — retail events with their active price actions: active, the next 25, the last 25 ended. */
export async function listPromotions() {
  const now = new Date()
  const events = await prisma.retailEvent.findMany({
    orderBy: [{ startDate: 'asc' }],
    include: {
      priceActions: {
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  const buckets = {
    active: [] as typeof events,
    upcoming: [] as typeof events,
    ended: [] as typeof events,
  }
  for (const e of events) {
    if (e.startDate <= now && e.endDate >= now) buckets.active.push(e)
    else if (e.startDate > now) buckets.upcoming.push(e)
    else buckets.ended.push(e)
  }
  return {
    counts: {
      active: buckets.active.length,
      upcoming: buckets.upcoming.length,
      ended: buckets.ended.length,
      total: events.length,
    },
    active: buckets.active,
    // Cap upcoming at next 25 — calendar view fits ~3 months ahead
    // without overwhelming the operator.
    upcoming: buckets.upcoming.slice(0, 25),
    // Last 25 ended for "did the lift land" lookback.
    ended: buckets.ended.slice(-25).reverse(),
  }
}

// ── 08 S12 — the writes ─────────────────────────────────────────────────────────────────────────────────

export class PromotionError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message)
    this.name = 'PromotionError'
  }
}

export interface PromotionInput {
  name?: string
  startDate?: string
  endDate?: string
  channel?: string | null
  marketplace?: string | null
  productType?: string | null
  description?: string | null
  expectedLift?: number
  action?: {
    type: 'PERCENT_OFF' | 'FIXED_PRICE'
    value: number
  }
}

/** A sale event with (optionally) its price action, in one transaction. The pricing cron applies it while it runs. */
export async function createPromotion(body: PromotionInput) {
  if (!body.name?.trim()) throw new PromotionError(400, 'name is required')
  if (!body.startDate || !body.endDate) throw new PromotionError(400, 'startDate and endDate are required (YYYY-MM-DD)')
  const start = new Date(body.startDate)
  const end = new Date(body.endDate)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new PromotionError(400, 'invalid date')
  if (end < start) throw new PromotionError(400, 'endDate must be ≥ startDate')
  if (body.action) {
    if (!['PERCENT_OFF', 'FIXED_PRICE'].includes(body.action.type)) {
      throw new PromotionError(400, 'action.type must be PERCENT_OFF or FIXED_PRICE')
    }
    if (
      !Number.isFinite(body.action.value) ||
      body.action.value <= 0 ||
      (body.action.type === 'PERCENT_OFF' && body.action.value >= 100)
    ) {
      throw new PromotionError(400, 'action.value must be > 0 (and < 100 for PERCENT_OFF)')
    }
  }

  return prisma.$transaction(async (tx) => {
    const event = await tx.retailEvent.create({
      data: {
        name: body.name!,
        startDate: start,
        endDate: end,
        channel: body.channel ?? null,
        marketplace: body.marketplace ?? null,
        productType: body.productType ?? null,
        description: body.description ?? null,
        expectedLift:
          body.expectedLift != null
            ? new Prisma.Decimal(body.expectedLift)
            : new Prisma.Decimal(1),
        source: 'CUSTOM',
        isActive: true,
      },
    })
    if (body.action) {
      await tx.retailEventPriceAction.create({
        data: {
          eventId: event.id,
          channel: body.channel ?? null,
          marketplace: body.marketplace ?? null,
          productType: body.productType ?? null,
          action: body.action.type,
          value: new Prisma.Decimal(body.action.value),
          isActive: true,
        },
      })
    }
    return tx.retailEvent.findUnique({
      where: { id: event.id },
      include: { priceActions: true },
    })
  })
}

/** End a promotion: the event and its actions off, and every sale it set ended through the channel price door. */
export async function endPromotion(id: string): Promise<{ ok: true; salesEnded: number }> {
  let eventName = ''
  await prisma.$transaction(async (tx) => {
    const event = await tx.retailEvent.findUnique({
      where: { id },
      select: { id: true, name: true },
    })
    if (!event) throw new PromotionError(404, 'event not found')
    await tx.retailEvent.update({
      where: { id: event.id },
      data: { isActive: false },
    })
    await tx.retailEventPriceAction.updateMany({
      where: { eventId: event.id },
      data: { isActive: false },
    })
    eventName = event.name
  })
  // 2026-10-01 — every sale this promotion set ends through the channel price door (cleared and queued; on Amazon
  // with `saleRemoved`). It was a raw `updateMany` of `salePrice` to null: nothing queued, the channels kept the sale.
  const salesEnded = await endPromotionSales(prisma as never, id, eventName)
  return { ok: true, salesEnded }
}

