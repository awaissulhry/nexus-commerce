/**
 * MCP full control 08 S12 — pricing records Claude asks for: a pricing rule, a promotion, a master price change for
 * later.
 *
 * Every tool here is a change: its handler is a dry run, and `execute` runs only after a person approved it in Nexus,
 * through the services the pricing pages use (services/pricing/*). Each preview says plainly whether anything would
 * reach a channel, from the same switches the engines read: a pricing rule never sends anything (it is a suggestion);
 * a promotion is applied only while the pricing cron runs; a scheduled change is applied by the scheduled-changes job at
 * its time, through the master price (every listing that follows it moves too).
 *
 * 08 S13 — an eBay price promotion (markdown or volume pricing; sent by the eBay marketing publisher, dry run unless its
 * switch is on, with the primary eBay account only) and a product's B2B tier prices.
 */

import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import prisma from '../../../db.js'
import {
  createPricingRule,
  deactivatePricingRule,
  PRICING_RULE_TYPES,
  PricingRuleError,
  updatePricingRule,
  type PricingRuleInput,
} from '../../pricing/pricing-rule.service.js'
import { createPromotion, endPromotion, PromotionError } from '../../pricing/promotion.service.js'
import { cancelScheduledChange, createScheduledChange, resolveUnknownChange, ScheduledChangeError } from '../../pricing/scheduled-price.service.js'
import { promotionSales } from '../../promotion-scheduler.service.js'
import { priceBoundsOf, storedPriceReason } from '../../price-bounds.service.js'
import { masterCurrency } from '../../fx-rate.service.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'
import { accountRefusal, draftMarkdown, draftVolumePromotion, EbayPromotionRefusal, markdownLive, promotionAccount, volumeLive } from '../../pricing/ebay-price-promotion.service.js'
import { ebayMarkdownBenefit } from '../../ebay-markdown-benefit.js'
import { validateVolumeTiers } from '../../ebay-volume-pricing.service.js'

const DAY_MS = 86_400_000
const PREVIEW_LINES = 20
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null)
const money = (value: unknown) => (value == null ? null : Number(value))
const NOT_YET = 'Nothing changes until a person approves this in Nexus.'
const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]

type Refusal = { error: string }
const refused = (r: unknown): r is Refusal => !!r && typeof r === 'object' && 'error' in r

/** Whether the engines that would act on these records run in this process (the same switches they read). */
const switches = () => ({
  pricingCron: process.env.NEXUS_ENABLE_PRICING_CRON === '1',
  scheduledChanges: process.env.NEXUS_ENABLE_SCHEDULED_CHANGES !== '0',
})

// ── set-pricing-rule ──────────────────────────────────────────────────────────────────────────────────

const RULE_ACTIONS = ['update', 'create', 'deactivate', 'activate'] as const
type RuleAction = (typeof RULE_ACTIONS)[number]
const RULE_FIELDS = ['name', 'type', 'description', 'priority', 'minMarginPercent', 'maxMarginPercent', 'parameters'] as const
type RuleField = (typeof RULE_FIELDS)[number]
const SENDS_NOTHING = 'A pricing rule only suggests a price in the pricing engine: nothing is sent to any channel because of it.'
const RULE_MAX_PRODUCTS = 250

export const PRICING_RULE_LIMITS = z.object({
  maxProducts: z.number().int().min(0).max(RULE_MAX_PRODUCTS).default(50).describe('the most products one rule change links'),
})
export function pricingRuleWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const products = (preview as { totals?: { products?: unknown } } | null)?.totals?.products
  if (typeof products !== 'number') return 'the request does not say how many products it links'
  return products > Number(limits.maxProducts) ? `it links ${products} products, more than the ${limits.maxProducts} allowed without a person` : null
}

interface RuleRow { id: string; name: string; type: string; description: string | null; priority: number; minMarginPercent: unknown; maxMarginPercent: unknown; parameters: unknown; isActive: boolean }
const ruleFields = (r: RuleRow): Record<RuleField, unknown> => ({
  name: r.name, type: r.type, description: r.description, priority: r.priority,
  minMarginPercent: money(r.minMarginPercent), maxMarginPercent: money(r.maxMarginPercent), parameters: r.parameters,
})
const linkedProducts = async (ruleId: string) =>
  (await prisma.pricingRuleProduct.findMany({ where: { ruleId }, select: { productId: true } })).map((l) => l.productId).sort()

interface RulePlan {
  action: RuleAction
  rule: RuleRow | null
  fields: Partial<Record<RuleField, unknown>>
  changes: Partial<Record<RuleField, { from: unknown; to: unknown }>>
  productsBefore: string[] | null
  productsAfter: string[] | null
  skus: string[]
}

async function planRule(args: Record<string, unknown>): Promise<RulePlan | Refusal> {
  const action = args.action as RuleAction
  const named = Object.fromEntries(RULE_FIELDS.filter((f) => args[f] !== undefined).map((f) => [f, args[f]])) as Partial<Record<RuleField, unknown>>
  const productIds = Array.isArray(args.productIds) ? [...new Set(args.productIds as string[])].sort() : null
  let skus: string[] = []
  if (productIds) {
    const found = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true, sku: true } })
    if (found.length !== productIds.length) return { error: PRODUCT_NOT_FOUND }
    skus = found.map((p) => p.sku).sort()
  }
  if (action === 'create') {
    if (!named.name || !named.type) return { error: 'name and type are required to create a pricing rule' }
    const changes = Object.fromEntries(Object.entries(named).map(([k, v]) => [k, { from: null, to: v }]))
    return { action, rule: null, fields: named, changes, productsBefore: null, productsAfter: productIds ?? [], skus }
  }
  const ruleId = args.ruleId as string | undefined
  if (!ruleId) return { error: 'ruleId is required (pricing-rules lists them)' }
  const rule = await prisma.pricingRule.findUnique({ where: { id: ruleId } })
  if (!rule) return { error: 'Pricing rule not found' }
  if (action === 'deactivate' || action === 'activate') {
    if (rule.isActive === (action === 'activate')) return { error: `Pricing rule "${rule.name}" is already ${rule.isActive ? 'on' : 'off'}.` }
    return { action, rule, fields: {}, changes: {}, productsBefore: null, productsAfter: null, skus }
  }
  const current = ruleFields(rule)
  const changes: RulePlan['changes'] = {}
  for (const [field, value] of Object.entries(named) as Array<[RuleField, unknown]>) {
    if (JSON.stringify(current[field] ?? null) !== JSON.stringify(value ?? null)) changes[field] = { from: current[field], to: value }
  }
  const productsBefore = productIds ? await linkedProducts(rule.id) : null
  const productsChange = productIds && JSON.stringify(productsBefore) !== JSON.stringify(productIds)
  if (!Object.keys(changes).length && !productsChange) return { error: `Nothing to change on pricing rule "${rule.name}": name a field with a new value, or the products it applies to.` }
  return { action, rule, fields: Object.fromEntries(Object.keys(changes).map((k) => [k, named[k as RuleField]])), changes, productsBefore: productsChange ? productsBefore : null, productsAfter: productsChange ? productIds : null, skus }
}

const RULE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { ruleId?: string; isActive?: boolean; fields?: Record<string, unknown>; productIds?: string[] }
    if (!after.ruleId) return null
    const rule = await prisma.pricingRule.findUnique({ where: { id: after.ruleId } })
    if (!rule) return null
    if ('isActive' in after) return { ruleId: after.ruleId, isActive: rule.isActive }
    const now = ruleFields(rule)
    return {
      ruleId: after.ruleId,
      fields: Object.fromEntries(Object.keys(after.fields ?? {}).map((k) => [k, now[k as RuleField] ?? null])),
      ...(after.productIds ? { productIds: await linkedProducts(after.ruleId) } : {}),
    }
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: RuleAction; ruleId?: string; fields?: Record<string, unknown>; productIds?: string[] }
    const after = (change.after ?? {}) as { ruleId?: string }
    const ruleId = before.ruleId ?? after.ruleId
    if (!ruleId) return { refusal: 'This change does not name its pricing rule.' }
    if (before.action === 'create' || before.action === 'activate') return { tool: 'set-pricing-rule', args: { action: 'deactivate', ruleId } }
    if (before.action === 'deactivate') return { tool: 'set-pricing-rule', args: { action: 'activate', ruleId } }
    const fields = Object.fromEntries(Object.entries(before.fields ?? {}).filter(([, v]) => v !== null))
    const cleared = Object.entries(before.fields ?? {}).filter(([, v]) => v === null).map(([k]) => k)
    if (cleared.length) return { refusal: `The rule had no ${cleared.join(', ')} before, and a value cannot be taken back to none here: change it in Nexus.` }
    return { tool: 'set-pricing-rule', args: { action: 'update', ruleId, ...fields, ...(before.productIds ? { productIds: before.productIds } : {}) } }
  },
}

const setPricingRule: AgentTool = {
  name: 'set-pricing-rule',
  title: 'Set a pricing rule',
  input: z.object({
    action: z.preprocess(lower, z.enum(RULE_ACTIONS)).describe('update, create, deactivate (switch off) or activate'),
    ruleId: z.string().trim().min(1).max(64).optional().describe('the rule (pricing-rules lists them); every action but create'),
    name: z.string().trim().min(1).max(100).optional().describe('the rule\'s name'),
    type: z.preprocess(upper, z.enum(PRICING_RULE_TYPES)).optional().describe('MATCH_LOW, PERCENTAGE_BELOW, COST_PLUS_MARGIN, FIXED_PRICE or DYNAMIC_MARGIN'),
    description: z.string().trim().min(1).max(500).optional().describe('what the rule is for'),
    priority: z.coerce.number().int().min(1).max(1000).optional().describe('lower runs first (default 100)'),
    minMarginPercent: z.coerce.number().min(0).max(100).optional().describe('the margin floor, in percent'),
    maxMarginPercent: z.coerce.number().min(0).max(1000).optional().describe('the margin ceiling, in percent'),
    parameters: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.union([z.number(), z.string().max(100), z.boolean()])).optional()
      .describe('the rule type\'s settings, e.g. { "offset": 0.5 } or { "percent": 3 }'),
    productIds: z.array(z.string().trim().min(1).max(64)).max(RULE_MAX_PRODUCTS).optional()
      .describe(`create and update: the products it applies to (0 to ${RULE_MAX_PRODUCTS}); update replaces the list`),
  }),
  requires: [F.pricingRulesManage],
  category: 'pricing',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: PRICING_RULE_LIMITS,
  withinLimits: pricingRuleWithinLimits,
  undo: RULE_UNDO,
  description:
    'Create, change, switch off or back on a pricing rule (the pricing engine\'s suggestion rules), and the products '
    + 'it applies to. A pricing rule sends nothing to any channel: it only suggests a price. Repricing rules (the '
    + 'automatic repricer) are not these. Waits for a person to approve it in Nexus unless the business lets Claude do '
    + 'it itself.',
  async handler(args): Promise<ToolResult> {
    const plan = await planRule(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const products = plan.productsAfter ?? []
    return {
      ok: true,
      preview: {
        action: plan.action,
        rule: plan.rule ? { id: plan.rule.id, name: plan.rule.name, type: plan.rule.type, isActive: plan.rule.isActive } : { name: plan.fields.name, type: plan.fields.type },
        changes: plan.action === 'deactivate' || plan.action === 'activate' ? { active: { from: plan.action === 'activate' ? false : true, to: plan.action === 'activate' } } : plan.changes,
        products: plan.productsAfter ? { count: products.length, skus: plan.skus.slice(0, PREVIEW_LINES), ...(plan.productsBefore ? { before: plan.productsBefore.length } : {}) } : null,
        totals: { products: products.length },
        sendsNothing: SENDS_NOTHING,
        note: `${NOT_YET} ${SENDS_NOTHING}`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planRule(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    try {
      if (plan.action === 'create') {
        const rule = await createPricingRule({ ...(plan.fields as PricingRuleInput), productIds: plan.productsAfter ?? [] })
        return { ok: true, data: { ruleId: rule.id }, change: { before: { action: 'create' }, after: { ruleId: rule.id, isActive: true } } }
      }
      const id = plan.rule!.id
      if (plan.action === 'deactivate') {
        await deactivatePricingRule(id)
        return { ok: true, data: { ruleId: id, isActive: false }, change: { before: { action: 'deactivate', ruleId: id }, after: { ruleId: id, isActive: false } } }
      }
      if (plan.action === 'activate') {
        await updatePricingRule(id, { isActive: true })
        return { ok: true, data: { ruleId: id, isActive: true }, change: { before: { action: 'activate', ruleId: id }, after: { ruleId: id, isActive: true } } }
      }
      if (Object.keys(plan.fields).length) await updatePricingRule(id, plan.fields as PricingRuleInput)
      if (plan.productsAfter) {
        await prisma.$transaction([
          prisma.pricingRuleProduct.deleteMany({ where: { ruleId: id, productId: { notIn: plan.productsAfter } } }),
          prisma.pricingRuleProduct.createMany({ data: plan.productsAfter.filter((p) => !plan.productsBefore?.includes(p)).map((productId) => ({ ruleId: id, productId })) }),
        ])
      }
      const before = Object.fromEntries(Object.entries(plan.changes).map(([k, c]) => [k, c!.from ?? null]))
      const after = Object.fromEntries(Object.entries(plan.changes).map(([k, c]) => [k, c!.to ?? null]))
      return {
        ok: true,
        data: { ruleId: id, changed: Object.keys(plan.changes), products: plan.productsAfter?.length ?? null },
        change: {
          before: { action: 'update', ruleId: id, fields: before, ...(plan.productsBefore ? { productIds: plan.productsBefore } : {}) },
          after: { ruleId: id, fields: after, ...(plan.productsAfter ? { productIds: plan.productsAfter } : {}) },
        },
      }
    } catch (error) {
      if (error instanceof PricingRuleError) return { ok: false, error: error.message }
      throw error
    }
  },
}

// ── set-promotion ─────────────────────────────────────────────────────────────────────────────────────

const PROMOTION_ACTIONS = ['end', 'create'] as const
const NO_SALE: Record<string, string> = {
  EBAY: 'eBay listings carry no sale price',
  ETSY: 'Etsy listings carry no sale price',
  SHOPIFY: "Shopify's price sender does not send a sale price",
  WOOCOMMERCE: "WooCommerce's price sender does not send a sale price",
}

export const PROMOTION_LIMITS = z.object({
  maxListings: z.number().int().min(0).max(100_000).default(250).describe('the most listings one promotion puts on sale'),
  maxPercentOff: z.number().min(0).max(99).default(30).describe('the deepest percent off'),
  maxDays: z.number().int().min(1).max(366).default(31).describe('the longest promotion, in days'),
})
export function promotionWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { action?: string; promotion?: { days?: unknown; discount?: { type?: string; value?: unknown } | null }; scope?: { onSale?: unknown } } | null
  if (p?.action === 'end') return null
  const onSale = p?.scope?.onSale
  if (typeof onSale !== 'number') return 'the request does not say how many listings it puts on sale'
  if (onSale > Number(limits.maxListings)) return `${onSale} listings go on sale, more than the ${limits.maxListings} allowed without a person`
  const discount = p?.promotion?.discount
  if (discount?.type === 'PERCENT_OFF' && Number(discount.value) > Number(limits.maxPercentOff)) return `${discount.value} % off is more than the ${limits.maxPercentOff} % allowed without a person`
  if (Number(p?.promotion?.days) > Number(limits.maxDays)) return `${p?.promotion?.days} days is longer than the ${limits.maxDays} allowed without a person`
  return null
}

interface PromotionPlan {
  action: 'end' | 'create'
  event: { id: string; name: string; startDate: Date; endDate: Date; isActive: boolean } | null
  body: { name: string; startDate: string; endDate: string; channel: string | null; marketplace: string | null; productType: string | null; action?: { type: 'PERCENT_OFF' | 'FIXED_PRICE'; value: number } }
  days: number
  listings: number
  onSale: number
  noSale: Record<string, number>
  salesToEnd: number
}

async function planPromotion(args: Record<string, unknown>): Promise<PromotionPlan | Refusal> {
  if (args.action === 'end') {
    const id = args.promotionId as string | undefined
    if (!id) return { error: 'promotionId is required to end a promotion (price-promotions lists them)' }
    const event = await prisma.retailEvent.findUnique({ where: { id }, select: { id: true, name: true, startDate: true, endDate: true, isActive: true } })
    if (!event) return { error: 'Promotion not found' }
    if (!event.isActive) return { error: `Promotion "${event.name}" has already ended.` }
    const candidates = await prisma.channelListing.findMany({ where: { salePrice: { not: null } }, select: { id: true, lastOverrideBy: true } })
    const salesToEnd = (await promotionSales(prisma as never, event.id, candidates)).length
    return {
      action: 'end', event, body: { name: event.name, startDate: event.startDate.toISOString().slice(0, 10), endDate: event.endDate.toISOString().slice(0, 10), channel: null, marketplace: null, productType: null },
      days: 0, listings: 0, onSale: 0, noSale: {}, salesToEnd,
    }
  }
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const from = String(args.startDate ?? '')
  const until = String(args.endDate ?? '')
  if (!name || !from || !until) return { error: 'name, startDate and endDate (YYYY-MM-DD) are required to create a promotion' }
  const start = new Date(from)
  const end = new Date(until)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { error: 'startDate and endDate must be dates (YYYY-MM-DD)' }
  if (end < start) return { error: 'endDate must be on or after startDate' }
  if (end.getTime() < Date.now() - DAY_MS) return { error: 'This promotion would already be over.' }
  const discount = args.discount as { type: 'PERCENT_OFF' | 'FIXED_PRICE'; value: number } | undefined
  if (!discount) return { error: 'discount is required: { type: PERCENT_OFF or FIXED_PRICE, value }' }
  if (discount.type === 'PERCENT_OFF' && !(discount.value > 0 && discount.value < 100)) return { error: 'A percent off is above 0 and below 100.' }
  if (discount.type === 'FIXED_PRICE' && !(discount.value > 0)) return { error: 'A fixed sale price is above 0.' }
  const channel = (args.channel as string | undefined) ?? null
  const marketplace = (args.marketplace as string | undefined) ?? null
  const productType = (args.productType as string | undefined) ?? null
  const scope = await prisma.channelListing.findMany({
    where: { product: { deletedAt: null, ...(productType ? { productType } : {}) }, ...(channel ? { channel } : {}), ...(marketplace ? { marketplace } : {}) },
    select: { channel: true },
  })
  const noSale: Record<string, number> = {}
  for (const l of scope) if (NO_SALE[l.channel]) noSale[l.channel] = (noSale[l.channel] ?? 0) + 1
  const skipped = Object.values(noSale).reduce((s, n) => s + n, 0)
  return {
    action: 'create', event: null,
    body: { name, startDate: from, endDate: until, channel, marketplace, productType, action: discount },
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1,
    listings: scope.length, onSale: scope.length - skipped, noSale, salesToEnd: 0,
  }
}

const PROMOTION_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { promotionId?: string }
    if (!after.promotionId) return null
    const event = await prisma.retailEvent.findUnique({ where: { id: after.promotionId }, select: { isActive: true } })
    return { promotionId: after.promotionId, isActive: event?.isActive ?? false }
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: string }
    const after = (change.after ?? {}) as { promotionId?: string }
    if (before.action === 'create' && after.promotionId) return { tool: 'set-promotion', args: { action: 'end', promotionId: after.promotionId } }
    return { refusal: 'An ended promotion is not started again: its sales ended on the channels. Create a new one if it should run again.' }
  },
}

const setPromotion: AgentTool = {
  name: 'set-promotion',
  title: 'Create or end a promotion',
  input: z.object({
    action: z.preprocess(lower, z.enum(PROMOTION_ACTIONS)).describe('end (an active promotion, and every sale it set) or create'),
    promotionId: z.string().trim().min(1).max(64).optional().describe('end: the promotion (price-promotions lists them)'),
    name: z.string().trim().min(1).max(100).optional().describe('create: its name'),
    startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('create: the first day, YYYY-MM-DD'),
    endDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('create: the last day, YYYY-MM-DD (inclusive)'),
    channel: z.preprocess(upper, z.enum(CHANNELS)).optional().describe('create: only this channel (default every channel)'),
    marketplace: z.string().trim().toUpperCase().min(2).max(20).optional().describe('create: only this market, e.g. IT'),
    productType: z.string().trim().min(1).max(100).optional().describe('create: only products of this product type'),
    discount: z.object({
      type: z.preprocess(upper, z.enum(['PERCENT_OFF', 'FIXED_PRICE'])).describe('PERCENT_OFF or FIXED_PRICE'),
      value: z.coerce.number().positive().max(100_000).describe('the percent off (below 100), or the sale price'),
    }).optional().describe('create: the sale each listing in scope gets'),
  }),
  requires: [F.pricingEdit, F.productsPriceEdit],
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  limits: PROMOTION_LIMITS,
  withinLimits: promotionWithinLimits,
  undo: PROMOTION_UNDO,
  description:
    'Create a promotion (a percent or a fixed sale price on every listing in scope — a channel, a market, a product '
    + 'type — between two days) or end one (every sale it set ends through the price door). The pricing cron applies a '
    + 'promotion: while it is off, nothing reaches a channel, and the preview says so. eBay, Etsy and Shopify listings '
    + 'carry no sale from a promotion. Always waits for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planPromotion(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const s = switches()
    const applies = s.pricingCron
      ? 'The pricing cron runs here: it applies the sales when the promotion starts and ends them when it is over.'
      : 'The pricing cron is off here (NEXUS_ENABLE_PRICING_CRON): no sale of this promotion reaches a channel while it is off.'
    return {
      ok: true,
      preview: {
        action: plan.action,
        promotion: plan.action === 'end'
          ? { id: plan.event!.id, name: plan.event!.name, from: iso(plan.event!.startDate), until: iso(plan.event!.endDate) }
          : { name: plan.body.name, from: plan.body.startDate, until: plan.body.endDate, days: plan.days, channel: plan.body.channel, marketplace: plan.body.marketplace, productType: plan.body.productType, discount: plan.body.action ?? null },
        scope: plan.action === 'end'
          ? { salesToEnd: plan.salesToEnd }
          : { listings: plan.listings, onSale: plan.onSale, noSale: Object.fromEntries(Object.entries(plan.noSale).map(([c, n]) => [c, `${n} (${NO_SALE[c]})`])) },
        applies: plan.action === 'end' ? 'Ending runs now: every sale it set is cleared through the price door and queued to its channel.' : applies,
        note: `${NOT_YET} ${plan.action === 'end' ? 'Ending cannot be undone: a new promotion is needed to sell at the sale price again.' : 'Undo ends it.'}`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planPromotion(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    try {
      if (plan.action === 'end') {
        const ended = await endPromotion(plan.event!.id)
        return { ok: true, data: { promotionId: plan.event!.id, salesEnded: ended.salesEnded }, change: { before: { action: 'end', promotionId: plan.event!.id, name: plan.event!.name }, after: { promotionId: plan.event!.id, isActive: false } } }
      }
      const created = await createPromotion({ ...plan.body, description: null })
      return { ok: true, data: { promotionId: created!.id }, change: { before: { action: 'create', name: plan.body.name }, after: { promotionId: created!.id, isActive: true } } }
    } catch (error) {
      if (error instanceof PromotionError) return { ok: false, error: error.message }
      throw error
    }
  },
}

// ── schedule-price-change ─────────────────────────────────────────────────────────────────────────────

export const SCHEDULE_LIMITS = z.object({
  maxChangePercent: z.number().positive().max(100).default(10).describe('the most the master price may move, in percent'),
  maxDaysAhead: z.number().int().min(1).max(365).default(90).describe('the furthest ahead a change may be set, in days'),
})
export function scheduleWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { action?: string; change?: { changePercent?: unknown; daysAhead?: unknown } } | null
  if (!p?.change) return 'the request does not say what it changes'
  if (p.action === 'cancel') return null
  const pct = p.change.changePercent
  if (typeof pct !== 'number') return 'the product has no master price to compare with'
  if (Math.abs(pct) > Number(limits.maxChangePercent)) return `the master price moves ${Math.abs(pct)} %, more than the ${limits.maxChangePercent} % allowed without a person`
  if (Number(p.change.daysAhead) > Number(limits.maxDaysAhead)) return `it is ${p.change.daysAhead} days ahead, more than the ${limits.maxDaysAhead} allowed without a person`
  return null
}

interface SchedulePlan {
  action: 'cancel' | 'create' | 'resolve'
  outcome?: 'applied' | 'retry'
  product: { id: string; sku: string; name: string; basePrice: number | null; minPrice: unknown; maxPrice: unknown }
  scheduledChangeId: string | null
  price: number | null
  adjustPercent: number | null
  at: Date
  status: string
  following: number
}

async function planSchedule(args: Record<string, unknown>): Promise<SchedulePlan | Refusal> {
  const product = await prisma.product.findFirst({ where: liveProduct(String(args.productId ?? '')), select: { id: true, sku: true, name: true, basePrice: true, minPrice: true, maxPrice: true } })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const p = { ...product, basePrice: money(product.basePrice) }
  const following = await prisma.channelListing.count({ where: { productId: product.id, followMasterPrice: true } })
  if (args.action === 'cancel' || args.action === 'resolve') {
    const id = args.scheduledChangeId as string | undefined
    if (!id) return { error: `scheduledChangeId is required to ${args.action} (scheduled-price-changes lists them)` }
    const row = await prisma.scheduledProductChange.findUnique({ where: { id } })
    if (!row || row.productId !== product.id || row.kind !== 'PRICE') return { error: 'Scheduled price change not found for this product' }
    const payload = (row.payload ?? {}) as { basePrice?: number; adjustPercent?: number }
    const base = { product: p, scheduledChangeId: row.id, price: payload.basePrice ?? null, adjustPercent: payload.adjustPercent ?? null, at: row.scheduledFor, status: row.status, following }
    if (args.action === 'cancel') {
      if (row.status !== 'PENDING') return { error: `${product.sku}: this change is ${row.status}, so it cannot be cancelled.` }
      return { action: 'cancel', ...base }
    }
    if (row.status !== 'UNKNOWN') return { error: `${product.sku}: this change is ${row.status}; only a change whose run died (UNKNOWN) is resolved.` }
    const outcome = args.outcome
    if (outcome !== 'applied' && outcome !== 'retry') return { error: `${product.sku}: outcome is applied (it went out: close it) or retry (run it again on the next sweep)` }
    return { action: 'resolve', outcome, ...base }
  }
  const price = args.price != null ? Number(args.price) : null
  const adjustPercent = args.adjustPercent != null ? Number(args.adjustPercent) : null
  if ((price == null) === (adjustPercent == null)) return { error: `${product.sku}: give either price or adjustPercent` }
  const at = new Date(String(args.at ?? ''))
  if (Number.isNaN(at.getTime())) return { error: `${product.sku}: at must be a date and time (ISO), e.g. 2026-11-01T06:00:00Z` }
  if (at.getTime() <= Date.now()) return { error: `${product.sku}: at must be in the future (set-price changes the price now)` }
  if (at.getTime() > Date.now() + 365 * DAY_MS) return { error: `${product.sku}: at most a year ahead` }
  const target = price ?? (p.basePrice != null ? Math.round(p.basePrice * (1 + adjustPercent! / 100) * 100) / 100 : null)
  if (target == null) return { error: `${product.sku} has no master price for a percent to move` }
  const outside = storedPriceReason(target, priceBoundsOf(product))
  if (outside) return { error: `${product.sku}: not scheduled — ${outside}` }
  return { action: 'create', product: p, scheduledChangeId: null, price, adjustPercent, at, status: 'PENDING', following }
}

const SCHEDULE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { scheduledChangeId?: string }
    if (!after.scheduledChangeId) return null
    const row = await prisma.scheduledProductChange.findUnique({ where: { id: after.scheduledChangeId }, select: { status: true } })
    return { scheduledChangeId: after.scheduledChangeId, status: row?.status ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: string; productId?: string; price?: number | null; adjustPercent?: number | null; at?: string }
    const after = (change.after ?? {}) as { scheduledChangeId?: string }
    if (!before.productId) return { refusal: 'This change does not name its product.' }
    if ((before.action === 'create' || (before.action === 'resolve' && (before as { outcome?: string }).outcome === 'retry')) && after.scheduledChangeId) {
      return { tool: 'schedule-price-change', args: { action: 'cancel', productId: before.productId, scheduledChangeId: after.scheduledChangeId } }
    }
    if (before.action === 'resolve') return { refusal: 'A change closed as applied stays applied: set the price with set-price if it is wrong.' }
    if (before.action === 'cancel' && before.at) {
      if (new Date(before.at).getTime() <= Date.now()) return { refusal: 'Its time has passed: set the price now with set-price, or schedule a new change.' }
      return { tool: 'schedule-price-change', args: { action: 'create', productId: before.productId, at: before.at, ...(before.price != null ? { price: before.price } : { adjustPercent: before.adjustPercent }) } }
    }
    return { refusal: 'This change does not say what to put back.' }
  },
}

const schedulePriceChange: AgentTool = {
  name: 'schedule-price-change',
  title: 'Schedule a price change',
  input: z.object({
    action: z.preprocess(lower, z.enum(['cancel', 'create', 'resolve'])).describe('create (a master price change for later), cancel one, or resolve one whose run died (UNKNOWN)'),
    productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
    scheduledChangeId: z.string().trim().min(1).max(64).optional().describe('cancel: the change (scheduled-price-changes lists them)'),
    price: z.coerce.number().positive().max(1_000_000).optional().describe('create: the new master price, in the master currency (or give adjustPercent)'),
    adjustPercent: z.coerce.number().min(-90).max(500).optional().describe('create: move the master price by this percent when it runs (or give price)'),
    at: z.string().trim().min(10).max(40).optional().describe('create: when, as an ISO date and time, e.g. 2026-11-01T06:00:00Z'),
    outcome: z.preprocess(lower, z.enum(['applied', 'retry'])).optional()
      .describe('resolve: applied (the price went out: close it) or retry (run it again on the next sweep) — after checking the master price'),
  }),
  requires: [F.productsPriceEdit],
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  limits: SCHEDULE_LIMITS,
  withinLimits: scheduleWithinLimits,
  undo: SCHEDULE_UNDO,
  description:
    'Schedule a master price change for a later time, or cancel one that has not run. At its time the scheduled-changes '
    + 'job sets the master price (inside the product\'s price bounds), and every listing that follows the master price '
    + 'moves and is sent to its channel. A cancelled change never runs. A change whose run died while applying it '
    + '(UNKNOWN in scheduled-price-changes) is resolved after a check of the price: applied, or retry on the next sweep. '
    + 'Waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s authenticator code when the business set it so.',
  async handler(args): Promise<ToolResult> {
    const plan = await planSchedule(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const now = plan.product.basePrice
    const target = plan.price ?? (now != null && plan.adjustPercent != null ? Math.round(now * (1 + plan.adjustPercent / 100) * 100) / 100 : null)
    const runs = switches().scheduledChanges
      ? 'The scheduled-changes job runs every minute here and applies it at its time.'
      : 'The scheduled-changes job is off here (NEXUS_ENABLE_SCHEDULED_CHANGES=0): it would not run while that stays off.'
    return {
      ok: true,
      preview: {
        action: plan.action,
        change: {
          sku: plan.product.sku, name: plan.product.name, masterPriceNow: now, newPrice: plan.price, adjustPercent: plan.adjustPercent, wouldBe: target,
          changePercent: now && target != null ? Math.round(((target - now) / now) * 1000) / 10 : null,
          at: plan.at.toISOString(), daysAhead: Math.ceil((plan.at.getTime() - Date.now()) / DAY_MS), currency: masterCurrency(),
          ...(plan.scheduledChangeId ? { scheduledChangeId: plan.scheduledChangeId, status: plan.status } : {}),
        },
        bounds: { min: money(plan.product.minPrice), max: money(plan.product.maxPrice) },
        listingsFollowingMaster: plan.following,
        applies: plan.action === 'cancel' ? 'Cancelled now: it will not run.'
          : plan.action === 'resolve' ? (plan.outcome === 'retry' ? `Back to PENDING: the next sweep sets the master price. ${runs}` : 'Closed as applied: nothing runs.')
            : runs,
        note: `${NOT_YET} ${plan.action === 'cancel' ? 'Undo schedules it again (while its time is still ahead).' : plan.action === 'resolve' ? 'Check the master price first: its run died while applying it.' : 'Undo cancels it before it runs.'}`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planSchedule(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    try {
      if (plan.action === 'resolve') {
        await resolveUnknownChange(plan.scheduledChangeId!, plan.outcome!, ctx.userId ?? 'an approved request')
        const status = plan.outcome === 'retry' ? 'PENDING' : 'APPLIED'
        return {
          ok: true,
          data: { scheduledChangeId: plan.scheduledChangeId, status },
          change: { before: { action: 'resolve', productId: plan.product.id, sku: plan.product.sku, scheduledChangeId: plan.scheduledChangeId, outcome: plan.outcome }, after: { scheduledChangeId: plan.scheduledChangeId, status } },
        }
      }
      if (plan.action === 'cancel') {
        await cancelScheduledChange(plan.scheduledChangeId!)
        return {
          ok: true,
          data: { scheduledChangeId: plan.scheduledChangeId, status: 'CANCELLED' },
          change: {
            before: { action: 'cancel', productId: plan.product.id, sku: plan.product.sku, scheduledChangeId: plan.scheduledChangeId, price: plan.price, adjustPercent: plan.adjustPercent, at: plan.at.toISOString() },
            after: { scheduledChangeId: plan.scheduledChangeId, status: 'CANCELLED' },
          },
        }
      }
      const created = await createScheduledChange(plan.product.id, {
        kind: 'PRICE', payload: plan.price != null ? { basePrice: plan.price } : { adjustPercent: plan.adjustPercent }, scheduledFor: plan.at.toISOString(),
      }, ctx.userId ?? 'agent:schedule-price-change')
      return {
        ok: true,
        data: { scheduledChangeId: created.id, at: plan.at.toISOString() },
        change: { before: { action: 'create', productId: plan.product.id, sku: plan.product.sku }, after: { scheduledChangeId: created.id, status: 'PENDING' } },
      }
    } catch (error) {
      if (error instanceof ScheduledChangeError) return { ok: false, error: error.message }
      throw error
    }
  },
}

// ── set-ebay-price-promotion (08 S13) ─────────────────────────────────────────────────────────────────

const PROMO_KINDS = ['markdown', 'volume'] as const
const PROMO_MAX = 250
const ymd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/)

interface EbayPromoPlan {
  kind: (typeof PROMO_KINDS)[number]
  live: boolean
  start: Date
  end: Date | null
  listings: Array<{ id: string; sku: string; marketplace: string; price: number | null; markdownPrice: number | null }>
  volume: { name: string; marketplace: string; tiers: Array<{ minQty: number; percentOff: number }>; skus: string[] } | null
  discount: { type: string; value: number } | null
}

async function planEbayPromotion(args: Record<string, unknown>): Promise<EbayPromoPlan | Refusal> {
  const kind = (args.kind ?? 'markdown') as EbayPromoPlan['kind']
  const today = new Date(new Date().toISOString().slice(0, 10))
  const start = args.startDate ? new Date(String(args.startDate)) : today
  const end = args.endDate ? new Date(String(args.endDate)) : null
  if (start < today) return { error: 'startDate is in the past' }
  if (end && end <= start) return { error: 'endDate must be after startDate' }
  let primary: string | null
  try {
    primary = await promotionAccount()
  } catch (error) {
    if (error instanceof EbayPromotionRefusal) return { error: error.message }
    throw error
  }
  if (kind === 'markdown') {
    const ids = [...new Set((args.listingIds ?? []) as string[])]
    if (!ids.length) return { error: 'listingIds are required for a markdown (channel-price-stock shows each eBay listing)' }
    const rows = await prisma.channelListing.findMany({
      where: { id: { in: ids }, product: { deletedAt: null } },
      select: { id: true, channel: true, marketplace: true, price: true, channelConnectionId: true, externalListingId: true, product: { select: { sku: true } } },
    })
    if (rows.length !== ids.length) return { error: 'Listing not found' }
    const type = String(args.discountType ?? 'PERCENTAGE')
    const value = Number(args.discountValue)
    if (!(value > 0)) return { error: `Not queued: give discountValue (the percent off, or the new price) for ${rows.map((r) => r.product.sku).join(', ')}` }
    const problems: string[] = []
    const listings: EbayPromoPlan['listings'] = []
    for (const row of rows) {
      const sku = row.product.sku
      if (row.channel !== 'EBAY') { problems.push(`${sku} (${row.channel} ${row.marketplace}) is not an eBay listing`); continue }
      const other = accountRefusal(sku, row.channelConnectionId, primary)
      if (other) { problems.push(other); continue }
      if (!row.externalListingId) { problems.push(`${sku} on eBay ${row.marketplace} is not live on eBay yet`); continue }
      if (row.price == null) { problems.push(`${sku} on eBay ${row.marketplace} has no price`); continue }
      const price = Number(row.price)
      // The same check the push makes: only a discount eBay takes is queued (currency is not needed for the check).
      const discount = ebayMarkdownBenefit({ discountType: type === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED_PRICE', discountValue: value, price, currency: '' })
      if (!discount.ok) { problems.push(`${sku} on eBay ${row.marketplace}: ${discount.reason}`); continue }
      listings.push({ id: row.id, sku, marketplace: row.marketplace, price, markdownPrice: discount.markdownPrice })
    }
    if (problems.length) return { error: `Not queued: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}` }
    return { kind, live: markdownLive(), start, end, listings, volume: null, discount: { type, value } }
  }
  const marketplace = typeof args.marketplace === 'string' ? args.marketplace.toUpperCase() : ''
  const productIds = [...new Set((args.productIds ?? []) as string[])]
  if (!marketplace || !productIds.length) return { error: 'marketplace and productIds are required for a volume promotion' }
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true, sku: true } })
  if (products.length !== productIds.length) return { error: PRODUCT_NOT_FOUND }
  const listed = await prisma.channelListing.findMany({ where: { productId: { in: productIds }, channel: 'EBAY', marketplace }, select: { productId: true, channelConnectionId: true, externalListingId: true } })
  const problems: string[] = []
  for (const product of products) {
    const own = listed.filter((l) => l.productId === product.id)
    if (!own.some((l) => l.externalListingId)) { problems.push(`${product.sku} is not live on eBay ${marketplace}`); continue }
    for (const l of own) { const other = accountRefusal(product.sku, l.channelConnectionId, primary); if (other) { problems.push(other); break } }
  }
  if (problems.length) return { error: `Not queued: ${problems.slice(0, 5).join('; ')}` }
  const tiers = ((args.tiers ?? []) as Array<{ minQty: number; percentOff: number }>).map((t) => ({ minQty: t.minQty, percentOff: t.percentOff }))
  const checked = validateVolumeTiers(tiers)
  if (!checked.ok) return { error: `Not queued: the tiers — ${checked.errors.join('; ')}` }
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : `Volume pricing ${marketplace} ${start.toISOString().slice(0, 10)}`
  return { kind, live: volumeLive(), start, end, listings: [], volume: { name, marketplace, tiers, skus: products.map((p) => p.sku) }, discount: null }
}

const setEbayPricePromotion: AgentTool = {
  name: 'set-ebay-price-promotion',
  title: 'eBay price promotion',
  input: z.object({
    kind: z.preprocess(lower, z.enum(PROMO_KINDS)).default('markdown').describe('markdown (default: a price cut on eBay listings) or volume (buy more, pay less per unit)'),
    listingIds: z.array(z.string().trim().min(1).max(64)).min(1).max(PROMO_MAX).optional().describe(`markdown: the eBay listings, 1 to ${PROMO_MAX} (channel-price-stock shows them)`),
    discountType: z.preprocess(upper, z.enum(['PERCENTAGE', 'FIXED_PRICE'])).default('PERCENTAGE').describe('markdown: PERCENTAGE off (default) or FIXED_PRICE (the new price)'),
    discountValue: z.coerce.number().positive().max(1_000_000).optional().describe('markdown: the percent off (a whole number, 5 to 80), or the new price in the market\'s currency (the amount off it makes must be 5 to 100 in steps of 1, 105 to 1000 in steps of 5, or 1100 to 15000 in steps of 100: eBay\'s list)'),
    marketplace: z.string().trim().min(2).max(20).optional().describe('volume: the eBay market, e.g. IT'),
    productIds: z.array(z.string().trim().min(1).max(64)).min(1).max(PROMO_MAX).optional().describe(`volume: the products (their eBay listings in that market), 1 to ${PROMO_MAX}`),
    tiers: z.array(z.object({
      minQty: z.coerce.number().int().min(2).max(4).describe('units that unlock the tier: 2, 3 or 4'),
      percentOff: z.coerce.number().gt(0).lt(100).describe('percent off each unit at that tier'),
    })).min(1).max(3).optional().describe('volume: 1 to 3 tiers, discounts rising with quantity'),
    name: z.string().trim().max(80).optional().describe('volume: its name'),
    startDate: ymd.optional().describe('when it starts (YYYY-MM-DD, default today)'),
    endDate: ymd.optional().describe('when it ends (YYYY-MM-DD)'),
  }),
  requires: [F.listingsEdit, F.pricingEdit],
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // Irreversible from Nexus: no service ends a markdown or volume promotion on eBay (the pages' "end" only marks the
  // Nexus row), so there is no undo and Claude never goes beyond asking.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Start an eBay price promotion: a markdown (a price cut on chosen eBay listings, as a percentage or a new price) or '
    + 'volume pricing (2-4 quantity tiers on products of one eBay market). Sent with the business\'s primary eBay account '
    + 'through the eBay marketing publisher; while that publisher is in dry run (the preview says so) the promotion is '
    + 'recorded and logged, not sent. Nexus cannot end a promotion on eBay: it is ended in eBay Seller Hub. Always waits '
    + 'for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planEbayPromotion(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return {
      ok: true,
      preview: {
        kind: plan.kind,
        live: plan.live,
        dates: { start: iso(plan.start), end: iso(plan.end) },
        ...(plan.discount ? { discount: plan.discount } : {}),
        ...(plan.listings.length ? { listings: plan.listings.slice(0, PREVIEW_LINES).map((l) => ({ sku: l.sku, marketplace: l.marketplace, price: l.price, markdownPrice: l.markdownPrice })), ...(plan.listings.length > PREVIEW_LINES ? { moreListings: plan.listings.length - PREVIEW_LINES } : {}) } : {}),
        ...(plan.volume ? { products: plan.volume.skus.slice(0, PREVIEW_LINES), tiers: plan.volume.tiers, marketplace: plan.volume.marketplace, name: plan.volume.name } : {}),
        totals: { listings: plan.listings.length, products: plan.volume?.skus.length ?? 0 },
        note: `${NOT_YET} ${plan.live ? 'It is sent to eBay with the primary eBay account and cannot be ended from Nexus (end it in eBay Seller Hub).' : 'The eBay publisher is in dry run here: the promotion is recorded and logged, NOT sent to eBay.'}`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planEbayPromotion(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    if (plan.kind === 'volume') {
      const promo = await draftVolumePromotion({ ...plan.volume!, startDate: plan.start, endDate: plan.end })
      // Loaded when sending, as the eBay pages load them: the publishers pull in the eBay account service.
      const { pushVolumePromotion } = await import('../../ebay-volume-pricing-push.service.js')
      const pushed = await pushVolumePromotion(prisma as never, promo.id)
      if (!pushed.ok) return { ok: false, error: `The volume promotion is recorded in Nexus (DRAFT) but was not sent: ${pushed.error}` }
      return { ok: true, data: { volumePromotionId: promo.id, live: pushed.liveMode, externalPromotionId: pushed.externalPromotionId ?? null, warnings: pushed.warnings }, change: { before: { kind: 'volume' }, after: { volumePromotionId: promo.id, live: pushed.liveMode } } }
    }
    const results: Array<{ sku: string; markdownId: string; ok: boolean; live: boolean; error?: string }> = []
    const { pushMarkdownToEbay } = await import('../../ebay-markdown.service.js')
    for (const listing of plan.listings) {
      const markdown = await draftMarkdown({ channelListingId: listing.id, discountType: plan.discount!.type as 'PERCENTAGE' | 'FIXED_PRICE', discountValue: plan.discount!.value, startDate: plan.start, endDate: plan.end })
      const pushed = await pushMarkdownToEbay(prisma as never, markdown.id)
      results.push({ sku: listing.sku, markdownId: markdown.id, ok: pushed.ok, live: pushed.liveMode, ...(pushed.error ? { error: pushed.error } : {}) })
    }
    const sent = results.filter((r) => r.ok)
    if (!sent.length) return { ok: false, error: `Nothing was sent: ${results.slice(0, 5).map((r) => `${r.sku}: ${r.error}`).join('; ')}` }
    return { ok: true, data: { markdowns: results, live: plan.live }, change: { before: { kind: 'markdown' }, after: { markdowns: results.map((r) => ({ markdownId: r.markdownId, ok: r.ok })), live: plan.live } } }
  },
}

// ── set-tier-prices (08 S13) ──────────────────────────────────────────────────────────────────────────

const TIER_MAX = 50

interface TierPlan {
  product: { id: string; sku: string; basePrice: number | null }
  tiers: Array<{ minQty: number; groupId: string | null; group: string | null; from: number | null; to: number | null }>
}

async function planTiers(args: Record<string, unknown>): Promise<TierPlan | Refusal> {
  const product = await prisma.product.findFirst({ where: { id: String(args.productId ?? ''), deletedAt: null }, select: { id: true, sku: true, basePrice: true } })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const asked = (args.tiers ?? []) as Array<{ minQty: number; price: number | null; customerGroup?: string }>
  if (!asked.length) return { error: `${product.sku}: give tiers (from how many units, at what price) to set.` }
  const keys = asked.map((t) => `${t.minQty}@${t.customerGroup ?? ''}`)
  if (new Set(keys).size !== keys.length) return { error: `${product.sku}: a tier is named twice (same quantity and customer group)` }
  const codes = [...new Set(asked.map((t) => t.customerGroup).filter((c): c is string => !!c))]
  const groups = new Map((await prisma.customerGroup.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map((g) => [g.code, g.id]))
  const unknown = codes.filter((c) => !groups.has(c))
  if (unknown.length) return { error: `${product.sku}: no customer group ${unknown.join(', ')} in this business` }
  const current = await prisma.productTierPrice.findMany({ where: { productId: product.id }, select: { minQty: true, customerGroupId: true, price: true } })
  const tiers: TierPlan['tiers'] = []
  for (const t of asked) {
    const groupId = t.customerGroup ? groups.get(t.customerGroup)! : null
    const row = current.find((c) => c.minQty === t.minQty && c.customerGroupId === groupId)
    const from = row ? Number(row.price) : null
    const to = t.price == null ? null : Math.round(t.price * 100) / 100
    if (from !== to) tiers.push({ minQty: t.minQty, groupId, group: t.customerGroup ?? null, from, to })
  }
  if (!tiers.length) return { error: `${product.sku}: every tier is already that. Nothing to change.` }
  return { product: { id: product.id, sku: product.sku, basePrice: money(product.basePrice) }, tiers }
}

const TIER_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { productId?: string; tiers?: Array<{ minQty: number; customerGroup: string | null }> }
    if (!after.productId) return null
    const rows = await prisma.productTierPrice.findMany({ where: { productId: after.productId }, select: { minQty: true, price: true, customerGroup: { select: { code: true } } } })
    return { productId: after.productId, tiers: (after.tiers ?? []).map((t) => { const row = rows.find((r) => r.minQty === t.minQty && (r.customerGroup?.code ?? null) === t.customerGroup); return { minQty: t.minQty, customerGroup: t.customerGroup, price: row ? Number(row.price) : null } }) }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: string; tiers?: Array<{ minQty: number; customerGroup: string | null; price: number | null }> }
    if (!before.productId || !before.tiers?.length) return { refusal: 'This change does not name the tiers it replaced.' }
    return { tool: 'set-tier-prices', args: { productId: before.productId, tiers: before.tiers.map((t) => ({ minQty: t.minQty, price: t.price, ...(t.customerGroup ? { customerGroup: t.customerGroup } : {}) })) } }
  },
}

const setTierPrices: AgentTool = {
  name: 'set-tier-prices',
  title: 'Set tier prices',
  input: z.object({
    productId: z.string().trim().min(1).max(64).describe('the product'),
    tiers: z.array(z.object({
      minQty: z.coerce.number().int().min(1).max(100_000).describe('from this many units'),
      price: z.coerce.number().min(0).max(1_000_000).nullable().describe('the unit price from that quantity, in the master currency; null removes the tier'),
      customerGroup: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/).optional().describe('only for this customer group (its code); default: every customer'),
    })).min(1).max(TIER_MAX).optional().describe(`the tiers to set, 1 to ${TIER_MAX}`),
  }),
  requires: [F.pricingTiersManage, FIELDS.financialsSuppliersView],
  category: 'pricing',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'confirm',
  undo: TIER_UNDO,
  description:
    'Set a product\'s quantity (B2B) tier prices: from N units the unit price is X, for every customer or one customer '
    + 'group; a null price removes a tier. They price quotes and B2B orders in Nexus; nothing is sent to a marketplace. '
    + 'Undo puts the old tiers back. Waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s '
    + 'authenticator code when the business set it so.',
  async handler(args): Promise<ToolResult> {
    const plan = await planTiers(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return {
      ok: true,
      preview: {
        product: { sku: plan.product.sku, basePrice: plan.product.basePrice, currency: masterCurrency() },
        tiers: plan.tiers.map((t) => ({ minQty: t.minQty, customerGroup: t.group, from: t.from, to: t.to, change: t.from == null ? 'add' : t.to == null ? 'remove' : 'update' })),
        note: `${NOT_YET} Tier prices are used in Nexus (quotes, B2B orders); nothing is sent to a marketplace.`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planTiers(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    await prisma.$transaction(async (tx) => {
      for (const t of plan.tiers) {
        const where = { productId: plan.product.id, minQty: t.minQty, customerGroupId: t.groupId }
        if (t.to == null) await tx.productTierPrice.deleteMany({ where })
        else if (t.from == null) await tx.productTierPrice.create({ data: { ...where, price: t.to } })
        else await tx.productTierPrice.updateMany({ where, data: { price: t.to } })
      }
    })
    return {
      ok: true,
      data: { sku: plan.product.sku, changed: plan.tiers.length },
      change: {
        before: { productId: plan.product.id, sku: plan.product.sku, tiers: plan.tiers.map((t) => ({ minQty: t.minQty, customerGroup: t.group, price: t.from })) },
        after: { productId: plan.product.id, tiers: plan.tiers.map((t) => ({ minQty: t.minQty, customerGroup: t.group, price: t.to })) },
      },
    }
  },
}

export const PRICING_CHANGE_TOOLS: AgentTool[] = [setPricingRule, setPromotion, schedulePriceChange, setEbayPricePromotion, setTierPrices]
