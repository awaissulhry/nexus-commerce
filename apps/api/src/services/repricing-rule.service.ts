/**
 * R17 (MCP full control, part 06) — a repricing rule's create and edit, moved unchanged out of
 * `POST /products/:id/repricing-rules` and `PATCH /repricing-rules/:id` (repricing-rules.routes.ts), so save-price-rule
 * saves through the same validation. The routes answer byte for byte as before
 * (automation-price-rule-route-parity.vitest.test.ts).
 */
import type { RepricingRule } from '@prisma/client'
import prisma from '../db.js'
import { done, refused, type ServiceOutcome } from './automation/service-outcome.js'

export const VALID_STRATEGIES = new Set([
  'match_buy_box',
  'beat_lowest_by_pct',
  'beat_lowest_by_amount',
  'fixed_to_buy_box_minus',
  'manual',
])

export interface RepricingRuleCreate {
  channel?: string
  marketplace?: string | null
  enabled?: boolean
  minPrice?: number | string
  maxPrice?: number | string
  strategy?: string
  beatPct?: number | string | null
  beatAmount?: number | string | null
  activeFromHour?: number | null
  activeToHour?: number | null
  activeDays?: number[]
  notes?: string | null
}

export type RepricingRulePatch = Omit<RepricingRuleCreate, 'channel' | 'marketplace'>

/** 201 with `{ rule }` on success, as the route answers. */
export async function createRepricingRule(productId: string, body: RepricingRuleCreate): Promise<ServiceOutcome<{ rule: RepricingRule }>> {
  if (!body.channel?.trim()) return refused(400, { error: 'channel is required' })
  const minPrice = Number(body.minPrice)
  const maxPrice = Number(body.maxPrice)
  if (!(minPrice >= 0)) return refused(400, { error: 'minPrice must be >= 0' })
  if (!(maxPrice >= minPrice)) return refused(400, { error: 'maxPrice must be >= minPrice' })
  if (!body.strategy || !VALID_STRATEGIES.has(body.strategy))
    return refused(400, { error: `strategy must be one of ${[...VALID_STRATEGIES].join(', ')}` })
  // Strategy-specific param presence checks. Server-side belt-
  // and-braces — the UI should already be enforcing these, but
  // direct API callers shouldn't be able to create a rule that
  // can never decide.
  if (body.strategy === 'beat_lowest_by_pct' && body.beatPct == null)
    return refused(400, { error: 'beatPct is required for beat_lowest_by_pct' })
  if ((body.strategy === 'beat_lowest_by_amount' || body.strategy === 'fixed_to_buy_box_minus') && body.beatAmount == null)
    return refused(400, { error: `beatAmount is required for ${body.strategy}` })

  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } })
  if (!product) return refused(404, { error: 'product not found' })

  try {
    const rule = await prisma.repricingRule.create({
      data: {
        productId,
        channel: body.channel.toUpperCase(),
        marketplace: body.marketplace?.toUpperCase() || null,
        enabled: body.enabled ?? true,
        minPrice,
        maxPrice,
        strategy: body.strategy,
        beatPct: body.beatPct == null ? null : Number(body.beatPct),
        beatAmount: body.beatAmount == null ? null : Number(body.beatAmount),
        activeFromHour: body.activeFromHour ?? null,
        activeToHour: body.activeToHour ?? null,
        activeDays: Array.isArray(body.activeDays) ? body.activeDays : [],
        notes: body.notes?.trim() || null,
      },
    })
    return done({ rule })
  } catch (err: any) {
    if (err?.code === 'P2002')
      return refused(409, { error: `a rule already exists for (channel=${body.channel}, marketplace=${body.marketplace ?? 'any'})` })
    throw err
  }
}

export async function patchRepricingRule(id: string, body: RepricingRulePatch): Promise<ServiceOutcome<{ rule: RepricingRule }>> {
  // productId, channel, marketplace are part of the @@unique key
  // — to "move" a rule, delete + create.
  const data: Record<string, unknown> = {}
  if (body.enabled !== undefined) data.enabled = !!body.enabled
  if (body.minPrice !== undefined) {
    const v = Number(body.minPrice)
    if (!(v >= 0)) return refused(400, { error: 'minPrice must be >= 0' })
    data.minPrice = v
  }
  if (body.maxPrice !== undefined) {
    const v = Number(body.maxPrice)
    if (!(v >= 0)) return refused(400, { error: 'maxPrice must be >= 0' })
    data.maxPrice = v
  }
  if (body.strategy !== undefined) {
    if (!VALID_STRATEGIES.has(body.strategy))
      return refused(400, { error: `strategy must be one of ${[...VALID_STRATEGIES].join(', ')}` })
    data.strategy = body.strategy
  }
  if (body.beatPct !== undefined) data.beatPct = body.beatPct == null ? null : Number(body.beatPct)
  if (body.beatAmount !== undefined) data.beatAmount = body.beatAmount == null ? null : Number(body.beatAmount)
  if (body.activeFromHour !== undefined) data.activeFromHour = body.activeFromHour
  if (body.activeToHour !== undefined) data.activeToHour = body.activeToHour
  if (body.activeDays !== undefined) data.activeDays = Array.isArray(body.activeDays) ? body.activeDays : []
  if (body.notes !== undefined) data.notes = body.notes?.trim() || null
  if (Object.keys(data).length === 0) return refused(400, { error: 'no mutable fields supplied' })
  try {
    const rule = await prisma.repricingRule.update({ where: { id }, data })
    return done({ rule })
  } catch (err: any) {
    if (err?.code === 'P2025') return refused(404, { error: 'repricing-rule not found' })
    throw err
  }
}
