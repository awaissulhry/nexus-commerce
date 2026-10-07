/**
 * R17 (MCP full control, part 06 §3) — save-price-rule: Claude creates or edits a repricing rule (the min/max range,
 * strategy and hours the repricer prices a listing inside), through the routes' own code (repricing-rule.service.ts).
 *
 *   · born disabled: a rule Claude creates is OFF; turn-up-automation (N1) switches it on, with a person.
 *   · its range must sit inside the product's own pricing floor and ceiling (price-bounds.service.ts; plan part 08's
 *     request): refused, never clamped. The bounds are in the master currency, so they are compared only with a rule
 *     for a market in that currency, never converted; a rule for every market of a channel must name its market when
 *     the product has bounds.
 *   · the preview never applies: it shows the price the draft would pick now (pickPrice, pure), writes no decision row.
 *   · an edit keeps the rule's switch where it is; channel, market and product never change (delete and create in Nexus).
 */
import prisma from '../db.js'
import { isRefused } from './automation/service-outcome.js'
import { repricingRuleBasis } from './automation/row-basis.js'
import { VALID_STRATEGIES, createRepricingRule, patchRepricingRule } from './repricing-rule.service.js'
import { boundsApply, type PriceBounds } from './price-bounds.service.js'

export const PRICE_RULE_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
export const PRICE_RULE_FIELDS = ['minPrice', 'maxPrice', 'strategy', 'beatPct', 'beatAmount', 'activeFromHour', 'activeToHour', 'activeDays', 'notes'] as const

export interface PriceRuleInput {
  priceRuleId?: string
  productId?: string
  channel?: string
  marketplace?: string | null
  minPrice?: number
  maxPrice?: number
  strategy?: string
  beatPct?: number | null
  beatAmount?: number | null
  activeFromHour?: number | null
  activeToHour?: number | null
  activeDays?: number[]
  notes?: string | null
}

/** A rule as save-price-rule records it (before / after) and its undo puts back. */
export interface PriceRuleConfig {
  priceRuleId: string | null
  productId: string
  sku: string
  channel: string
  marketplace: string | null
  enabled: boolean
  minPrice: number
  maxPrice: number
  strategy: string
  beatPct: number | null
  beatAmount: number | null
  activeFromHour: number | null
  activeToHour: number | null
  activeDays: number[]
  notes: string | null
}

export interface PriceRulePlan {
  action: 'save-price-rule'
  rule: { id: string | null; sku: string; channel: string; marketplace: string | null; enabled: boolean }
  changes: Record<string, { from: unknown; to: unknown }>
  /** The product's own floor and ceiling the range was checked against (master currency), or why they do not apply. */
  bounds: { minPrice: number | null; maxPrice: number | null; applied: boolean; note: string }
  /** What the draft would pick now on its listing; nothing is applied. Null when no listing matches. */
  wouldPick: { listingId: string; price: number; reason: string; capped: string | null } | null
  basis: string | null
  effect: string
}

const num = (value: unknown): number | null => (value == null ? null : Number(value))
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const where = (c: { channel: string; marketplace: string | null }) => `${c.channel}${c.marketplace ? ` ${c.marketplace}` : ' (every market)'}`

async function configOf(id: string): Promise<{ config: PriceRuleConfig; basis: string; bounds: PriceBounds } | null> {
  const r = await prisma.repricingRule.findUnique({ where: { id }, include: { product: { select: { sku: true, minPrice: true, maxPrice: true, deletedAt: true } } } })
  // A rule of a deleted product is as gone as its product (MCP.12).
  if (!r || r.product.deletedAt) return null
  return {
    // The rule's settings, never the repricing engine's last-run snapshot, which moves updatedAt on every evaluation.
    basis: repricingRuleBasis(r),
    bounds: { minPrice: num(r.product.minPrice), maxPrice: num(r.product.maxPrice) },
    config: {
      priceRuleId: r.id, productId: r.productId, sku: r.product.sku, channel: r.channel, marketplace: r.marketplace, enabled: r.enabled,
      minPrice: Number(r.minPrice), maxPrice: Number(r.maxPrice), strategy: r.strategy, beatPct: num(r.beatPct), beatAmount: num(r.beatAmount),
      activeFromHour: r.activeFromHour, activeToHour: r.activeToHour, activeDays: r.activeDays, notes: r.notes,
    },
  }
}

/** The rule as it is stored now (undo compares it with `after`). */
export async function priceRuleNow(id: string): Promise<PriceRuleConfig | null> {
  return (await configOf(id))?.config ?? null
}

/** The draft's range against the product's floor and ceiling: a sentence when it is refused. */
async function boundsCheck(draft: PriceRuleConfig, bounds: PriceBounds): Promise<{ refusal: string | null; note: string; applied: boolean }> {
  if (bounds.minPrice == null && bounds.maxPrice == null) return { refusal: null, note: 'The product has no pricing floor or ceiling.', applied: false }
  if (!draft.marketplace) {
    return { refusal: `the product has a pricing ${bounds.minPrice != null ? `floor of ${bounds.minPrice.toFixed(2)}` : ''}${bounds.minPrice != null && bounds.maxPrice != null ? ' and a ' : ''}${bounds.maxPrice != null ? `ceiling of ${bounds.maxPrice.toFixed(2)}` : ''} in the master currency: name the market (marketplace) so the rule's range can be checked against them`, note: '', applied: false }
  }
  const { masterCurrency } = await import('./fx-rate.service.js')
  const { marketCurrency } = await import('./pim/market-currency.js')
  let currency: string
  try { currency = await marketCurrency(draft.channel, draft.marketplace) } catch (e) { return { refusal: (e as Error).message, note: '', applied: false } }
  const master = masterCurrency()
  if (!boundsApply(currency, master)) return { refusal: null, note: `${draft.channel} ${draft.marketplace} prices in ${currency}; the product's floor and ceiling are in ${master}, so they are not compared (never converted).`, applied: false }
  const { minPrice, maxPrice } = bounds
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) return { refusal: `the product's pricing floor (${minPrice.toFixed(2)}) is above its ceiling (${maxPrice.toFixed(2)}): fix the two on the product first`, note: '', applied: true }
  if (minPrice != null && draft.minPrice < minPrice) return { refusal: `its minimum ${draft.minPrice.toFixed(2)} is below the product's pricing floor of ${minPrice.toFixed(2)}: refused, never clamped`, note: '', applied: true }
  if (maxPrice != null && draft.maxPrice > maxPrice) return { refusal: `its maximum ${draft.maxPrice.toFixed(2)} is above the product's pricing ceiling of ${maxPrice.toFixed(2)}: refused, never clamped`, note: '', applied: true }
  return { refusal: null, note: `Inside the product's ${minPrice != null ? `floor ${minPrice.toFixed(2)}` : 'no floor'} and ${maxPrice != null ? `ceiling ${maxPrice.toFixed(2)}` : 'no ceiling'} (${master}).`, applied: true }
}

/** What the draft rule would pick now on its listing (pure; no decision row, never applied). */
async function wouldPick(draft: PriceRuleConfig): Promise<PriceRulePlan['wouldPick']> {
  const { repricingMarketFor, repricingWindows } = await import('../jobs/repricing-evaluator.job.js')
  const { pickPrice } = await import('./repricing-engine.service.js')
  const found = await repricingMarketFor({ productId: draft.productId, channel: draft.channel, marketplace: draft.marketplace, strategy: draft.strategy }, repricingWindows())
  if (!found) return null
  const pick = pickPrice({
    strategy: draft.strategy as never, minPrice: draft.minPrice, maxPrice: draft.maxPrice, beatPct: draft.beatPct, beatAmount: draft.beatAmount,
    activeFromHour: draft.activeFromHour, activeToHour: draft.activeToHour, activeDays: draft.activeDays,
  }, found.market)
  return { listingId: found.listingId, price: pick.price, reason: pick.reason, capped: pick.capped }
}

type Planned = { ok: true; plan: PriceRulePlan; before: PriceRuleConfig | null; after: PriceRuleConfig } | { ok: false; error: string }

export async function planPriceRuleSave(input: PriceRuleInput): Promise<Planned> {
  let before: PriceRuleConfig | null = null
  let basis: string | null = null
  let bounds: PriceBounds
  if (input.priceRuleId) {
    const found = await configOf(input.priceRuleId)
    if (!found) return { ok: false, error: `There is no repricing rule ${input.priceRuleId} in this business (not found).` }
    before = found.config
    basis = found.basis
    bounds = found.bounds
    const at = `${before.sku} on ${where(before)}`
    if (input.productId && input.productId !== before.productId) return { ok: false, error: `${at}: a rule's product never changes — create a rule for the other product.` }
    if (input.channel && input.channel.toUpperCase() !== before.channel) return { ok: false, error: `${at}: a rule's channel never changes — delete it in Nexus and create one.` }
    if (input.marketplace !== undefined && (input.marketplace?.toUpperCase() || null) !== before.marketplace) return { ok: false, error: `${at}: a rule's market never changes — delete it in Nexus and create one.` }
  } else {
    if (!input.productId) return { ok: false, error: 'Name the product (productId) for a new rule, or the rule to edit (priceRuleId).' }
    // A deleted product (soft delete) is not found (MCP.12).
    const product = await prisma.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: { id: true, sku: true, minPrice: true, maxPrice: true } })
    if (!product) return { ok: false, error: `There is no product ${input.productId} in this business (not found).` }
    if (!input.channel) return { ok: false, error: `${product.sku}: name the channel (AMAZON, EBAY or SHOPIFY).` }
    const channel = input.channel.toUpperCase()
    const marketplace = input.marketplace?.toUpperCase() || null
    const existing = await prisma.repricingRule.findFirst({ where: { productId: product.id, channel, marketplace }, select: { id: true } })
    if (existing) return { ok: false, error: `${product.sku} already has a rule on ${where({ channel, marketplace })}: edit it (priceRuleId ${existing.id}).` }
    bounds = { minPrice: num(product.minPrice), maxPrice: num(product.maxPrice) }
    before = null
    // What a new rule starts from: born disabled, every field as the route defaults it.
    input = { ...input, channel, marketplace }
    const draftBase: PriceRuleConfig = {
      priceRuleId: null, productId: product.id, sku: product.sku, channel, marketplace, enabled: false,
      minPrice: NaN, maxPrice: NaN, strategy: '', beatPct: null, beatAmount: null, activeFromHour: null, activeToHour: null, activeDays: [], notes: null,
    }
    return finish(input, null, draftBase, bounds, null)
  }
  return finish(input, before, before, bounds, basis)
}

async function finish(input: PriceRuleInput, before: PriceRuleConfig | null, base: PriceRuleConfig, bounds: PriceBounds, basis: string | null): Promise<Planned> {
  const after: PriceRuleConfig = { ...base }
  for (const field of PRICE_RULE_FIELDS) if (input[field] !== undefined) (after as unknown as Record<string, unknown>)[field] = input[field]
  if (typeof after.notes === 'string') after.notes = after.notes.trim() || null
  const at = `${after.sku} on ${where(after)}`
  const refuse = (why: string): Planned => ({ ok: false, error: `${at}: ${why}.` })
  if (!Number.isFinite(after.minPrice) || after.minPrice < 0) return refuse('minPrice: a price of 0 or more')
  if (!Number.isFinite(after.maxPrice) || after.maxPrice < after.minPrice) return refuse('maxPrice: at least minPrice')
  if (!VALID_STRATEGIES.has(after.strategy)) return refuse(`strategy: one of ${[...VALID_STRATEGIES].join(', ')}`)
  if (after.strategy === 'beat_lowest_by_pct' && after.beatPct == null) return refuse('beatPct is required for beat_lowest_by_pct')
  if ((after.strategy === 'beat_lowest_by_amount' || after.strategy === 'fixed_to_buy_box_minus') && after.beatAmount == null) return refuse(`beatAmount is required for ${after.strategy}`)
  const checked = await boundsCheck(after, bounds)
  if (checked.refusal) return refuse(checked.refusal)
  const changes: PriceRulePlan['changes'] = {}
  for (const field of PRICE_RULE_FIELDS) {
    const from = before ? (before as unknown as Record<string, unknown>)[field] : null
    const to = (after as unknown as Record<string, unknown>)[field]
    if (!before || !same(from, to)) changes[field] = { from: from ?? null, to: to ?? null }
  }
  if (before && Object.keys(changes).length === 0) return refuse('nothing to change')
  const pick = await wouldPick(after)
  return {
    ok: true, before, after,
    plan: {
      action: 'save-price-rule',
      rule: { id: before?.priceRuleId ?? null, sku: after.sku, channel: after.channel, marketplace: after.marketplace, enabled: after.enabled },
      changes, bounds: { ...bounds, applied: checked.applied, note: checked.note }, wouldPick: pick, basis,
      effect: before
        ? `The rule ${after.enabled ? 'prices with the new range from the repricer\'s next run' : 'is off: nothing prices until it is turned up (turn-up-automation N1, with a person)'}.`
        : 'A new rule, born OFF: nothing prices until it is turned up (turn-up-automation N1, with a person).',
    },
  }
}

export async function applyPriceRuleSave(input: PriceRuleInput, actorUserId: string | null): Promise<{ ok: true; plan: PriceRulePlan; before: PriceRuleConfig | { created: true; sku: string; channel: string; marketplace: string | null }; after: PriceRuleConfig } | { ok: false; error: string }> {
  const planned = await planPriceRuleSave(input)
  if ('error' in planned) return planned
  const { after } = planned
  const values = Object.fromEntries(PRICE_RULE_FIELDS.map((f) => [f, (after as unknown as Record<string, unknown>)[f]]))
  const out = planned.before
    ? await patchRepricingRule(planned.before.priceRuleId!, Object.fromEntries(Object.keys(planned.plan.changes).map((f) => [f, values[f]])))
    : await createRepricingRule(after.productId, { ...values, channel: after.channel, marketplace: after.marketplace, enabled: false } as never)
  if (isRefused(out)) return { ok: false, error: `${after.sku} on ${where(after)}: not saved — ${String(out.body.error ?? 'refused')}` }
  const saved = (await priceRuleNow(out.value.rule.id))!
  const { auditLogService } = await import('./audit-log.service.js')
  await auditLogService.write({ userId: actorUserId, entityType: 'RepricingRule', entityId: saved.priceRuleId!, action: planned.before ? 'update_rule' : 'create_rule', before: planned.before ?? undefined, after: saved }).catch(() => undefined)
  return { ok: true, plan: planned.plan, before: planned.before ?? { created: true, sku: after.sku, channel: after.channel, marketplace: after.marketplace }, after: saved }
}
