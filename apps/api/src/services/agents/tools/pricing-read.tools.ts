/**
 * MCP full control 08 S5 — pricing reads for Claude: a product's prices everywhere (with currency, sale window, bounds
 * and held prices), the pricing rules and the repricer's switches, the promotions, and the scheduled price changes.
 *
 * Read-only and low risk: this business's own database. The reads are the pricing pages' own (services/pricing/,
 * moved out of the routes) plus the listing rows. Nothing here sends a price: whether a promotion, the repricer or a
 * scheduled change would ever run is said from the same switches the scheduler reads.
 */

import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  cursorScope,
  decodeCursor,
  encodeCursor,
  pageSize,
} from '../../../lib/pagination/cursor.js'
import { masterCurrency } from '../../fx-rate.service.js'
import { marketCurrency, type MarketCurrencyRow } from '../../pim/market-currency.js'
import { HELD_DRAFT_CODE, HELD_PRICE_ROWS } from '../../pim/follower-price.js'
import { readSaleWindows } from '../../pim/sale-window.js'
import { listActivePricingRules, readRepricerStatus } from '../../pricing/pricing-rule.service.js'
import { listPromotions } from '../../pricing/promotion.service.js'
import { listScheduledChanges } from '../../pricing/scheduled-price.service.js'
import { readPriceHistory } from '../../pricing/pricing-read.service.js'
import { isPriceRefusal, resolvePrice } from '../../pricing-engine.service.js'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { isLiveProduct, liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

const NESTED_CAP = 20
const TEXT_CAP = 200
const clip = (text: string | null | undefined, cap = TEXT_CAP) => (text == null ? null : text.length > cap ? `${text.slice(0, cap - 1)}…` : text)
const iso = (at: Date | string | null | undefined) => (at == null ? null : at instanceof Date ? at.toISOString() : at)
const money = (value: Prisma.Decimal | number | string | null | undefined) => (value == null ? null : Number(value))
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const capped = <T>(list: T[], cap = NESTED_CAP) => ({ shown: list.slice(0, cap), more: Math.max(0, list.length - cap) })

/** Whether the pricing cron (promotions, the repricer) and the scheduled-changes job run in this process. */
const switches = () => ({
  pricingCron: process.env.NEXUS_ENABLE_PRICING_CRON === '1',
  repricerLive: process.env.NEXUS_REPRICER_LIVE === '1',
  scheduledChanges: process.env.NEXUS_ENABLE_SCHEDULED_CHANGES !== '0',
  ebayMarkdownsLive: process.env.NEXUS_EBAY_MARKDOWN_LIVE === '1',
  ebayVolumePricingLive: process.env.NEXUS_EBAY_VOLUME_LIVE === '1',
})

/** The market's configured currency (the one the price door checks), or null when none is set. */
function currencyOf(channel: string, market: string, rows: MarketCurrencyRow[]): string | null {
  try {
    return marketCurrency(channel, market, rows)
  } catch {
    return null
  }
}

/** What a scheduled PRICE change sets: an absolute master price, or a percent move. */
function priceChangeOf(payload: unknown): { newPrice: number | null; adjustPercent: number | null } {
  const p = (payload ?? {}) as Record<string, unknown>
  return {
    newPrice: typeof p.basePrice === 'number' ? p.basePrice : null,
    adjustPercent: typeof p.adjustPercent === 'number' ? p.adjustPercent : null,
  }
}

// ── price-status (changed) ────────────────────────────────────────────────────────────────────────────

const priceStatus: AgentTool = {
  name: 'price-status',
  title: 'Price status',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.pricingView],
  category: 'pricing',
  riskTier: 'low',
  readOnly: true,
  description:
    'One product\'s prices: the master price and master currency, its price bounds (min and max: prices outside are '
    + 'refused, never clamped), and per channel listing the listed price and sale price with the sale window, the '
    + 'market\'s currency (a listing whose currency is not the master currency, or has none set, is never sent the '
    + 'master price), whether it follows the master price and by which rule, its own override, whether it is outside '
    + 'the bounds, and a held price: one kept in Nexus while the listing is paused or still a draft, sent when it '
    + 'resumes or is published. Also the pending scheduled price changes.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findFirst({
      where: liveProduct(id),
      select: {
        sku: true, name: true, basePrice: true, minPrice: true, maxPrice: true,
        channelListings: {
          orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { id: 'asc' }],
          select: {
            id: true, channel: true, marketplace: true, listingStatus: true, price: true, salePrice: true, priceOverride: true,
            followMasterPrice: true, pricingRule: true, priceAdjustmentPercent: true, syncPaused: true,
          },
        },
      },
    })
    if (!p) return { ok: false, error: PRODUCT_NOT_FOUND }
    const listingIds = p.channelListings.map((l) => l.id)
    const [currencies, windows, held, scheduled] = await Promise.all([
      prisma.marketplace.findMany({ select: { channel: true, code: true, currency: true } }) as Promise<MarketCurrencyRow[]>,
      readSaleWindows(prisma as never, listingIds),
      listingIds.length
        ? prisma.outboundSyncQueue.findMany({
            where: { ...HELD_PRICE_ROWS, channelListingId: { in: listingIds } },
            orderBy: { createdAt: 'desc' },
            select: { channelListingId: true, errorCode: true, payload: true, createdAt: true },
          })
        : Promise.resolve([]),
      listScheduledChanges(id),
    ])
    const heldOf = new Map<string, (typeof held)[number]>()
    for (const row of held) if (row.channelListingId && !heldOf.has(row.channelListingId)) heldOf.set(row.channelListingId, row)
    const min = money(p.minPrice)
    const max = money(p.maxPrice)
    const master = masterCurrency()
    const listings = capped(p.channelListings)
    return {
      ok: true,
      data: {
        sku: p.sku,
        name: p.name,
        masterPrice: money(p.basePrice),
        masterCurrency: master,
        bounds: min == null && max == null ? null : { min, max },
        channels: listings.shown.map((l) => {
          const price = money(l.price)
          const window = windows.get(l.id)
          const h = heldOf.get(l.id)
          const hp = (h?.payload ?? {}) as Record<string, unknown>
          const currency = currencyOf(l.channel, l.marketplace, currencies)
          return {
            listingId: l.id,
            channel: l.channel,
            marketplace: l.marketplace,
            status: l.listingStatus,
            currency,
            price,
            salePrice: money(l.salePrice),
            saleWindow: window && (window.start || window.end) ? window : null,
            followsMaster: l.followMasterPrice,
            rule: l.pricingRule,
            ...(l.pricingRule === 'PERCENT_OF_MASTER' ? { adjustPercent: money(l.priceAdjustmentPercent) } : {}),
            override: money(l.priceOverride),
            takesMasterPrice: currency === master,
            outsideBounds: price == null ? null : min != null && price < min ? 'below-min' : max != null && price > max ? 'above-max' : null,
            syncPaused: l.syncPaused,
            held: h
              ? {
                  why: h.errorCode === HELD_DRAFT_CODE ? 'draft: sent when published' : 'sync paused: sent when the listing resumes',
                  price: typeof hp.price === 'number' ? hp.price : null,
                  ...(hp.salePrice !== undefined ? { salePrice: hp.salePrice } : {}),
                  since: iso(h.createdAt),
                }
              : null,
          }
        }),
        ...(listings.more ? { moreChannels: listings.more } : {}),
        scheduledPriceChanges: scheduled.filter((c) => c.kind === 'PRICE' && c.status === 'PENDING').map((c) => ({
          id: c.id, ...priceChangeOf(c.payload), at: iso(c.scheduledFor), createdBy: c.createdBy,
        })),
      },
    }
  },
}

// ── pricing-rules ─────────────────────────────────────────────────────────────────────────────────────

const pricingRules: AgentTool = {
  name: 'pricing-rules',
  title: 'Pricing rules',
  input: z.object({
    productId: z.string().trim().min(1).max(64).optional().describe('only the rules linked to this product'),
  }),
  requires: [F.pricingView],
  category: 'pricing',
  riskTier: 'low',
  readOnly: true,
  description:
    'The active pricing rules, by priority: name, type (MATCH_LOW, PERCENTAGE_BELOW, COST_PLUS_MARGIN, FIXED_PRICE, '
    + 'DYNAMIC_MARGIN), parameters, margin floor and ceiling (shown only to a person who may see margins) and the '
    + 'products they apply to. A pricing rule gives the pricing engine a suggested price: it sends nothing by itself. '
    + 'Also the repricer\'s switches (is the pricing cron on, is the repricer live) and its latest runs. Repricing '
    + 'rules (the automatic repricer\'s min/max per listing) are an automation and are read elsewhere.',
  async handler(args) {
    const productId = args.productId as string | undefined
    if (productId && !(await isLiveProduct(productId))) return { ok: false, error: PRODUCT_NOT_FOUND }
    const [rules, status] = await Promise.all([listActivePricingRules(), readRepricerStatus()])
    const links = rules.length
      ? await prisma.pricingRuleProduct.findMany({
          where: { ruleId: { in: rules.map((r) => r.id) }, product: { deletedAt: null } },
          select: { ruleId: true, productId: true, product: { select: { sku: true } } },
        })
      : []
    const shown = productId ? rules.filter((r) => links.some((l) => l.ruleId === r.id && l.productId === productId)) : rules
    return {
      ok: true,
      data: {
        rules: shown.map((r) => {
          const mine = links.filter((l) => l.ruleId === r.id)
          return {
            id: r.id,
            name: r.name,
            type: r.type,
            priority: r.priority,
            description: clip(r.description),
            parameters: r.parameters,
            minMarginPercent: money(r.minMarginPercent),
            maxMarginPercent: money(r.maxMarginPercent),
            products: mine.length,
            skus: mine.slice(0, NESTED_CAP).map((l) => l.product.sku),
            updatedAt: iso(r.updatedAt),
          }
        }),
        sendsNothing: 'A pricing rule suggests a price in the pricing engine; nothing is sent to a channel because of it.',
        repricer: {
          pricingCron: status.config.cronEnabled,
          live: status.config.liveMode,
          thresholdPct: status.config.thresholdPct,
          recentRuns: status.ticks.map((t) => ({ ...t, occurredAt: iso(t.occurredAt) })),
        },
      },
    }
  },
}

// ── promotions ────────────────────────────────────────────────────────────────────────────────────────

const promotions: AgentTool = {
  name: 'price-promotions',
  title: 'Promotions',
  input: z.object({
    productId: z.string().trim().min(1).max(64).optional().describe('only this product\'s eBay markdowns'),
  }),
  requires: [F.pricingView, F.listingsView],
  category: 'pricing',
  riskTier: 'low',
  readOnly: true,
  description:
    'Promotions: the sale events (active, the next 25, the last 25 ended) with their price actions (a percent or an '
    + 'amount off, by channel, market or product type, and the sale dates they set); eBay markdowns (per listing: '
    + 'original and markdown price, currency, dates, status, last sync); and eBay volume pricing (tiers, SKUs, dates, '
    + 'status). Says whether each would act: sale events apply only while the pricing cron runs, and eBay sends only '
    + 'when its live switch is on (otherwise a dry run).',
  async handler(args) {
    const productId = args.productId as string | undefined
    if (productId && !(await isLiveProduct(productId))) return { ok: false, error: PRODUCT_NOT_FOUND }
    const [events, markdowns, volume] = await Promise.all([
      listPromotions(),
      prisma.ebayMarkdown.findMany({
        where: { channelListing: { product: { deletedAt: null }, ...(productId ? { productId } : {}) } },
        orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
        take: NESTED_CAP,
        select: {
          id: true, discountType: true, discountValue: true, originalPrice: true, markdownPrice: true, currency: true, status: true,
          startDate: true, endDate: true, lastSyncStatus: true, lastSyncError: true,
          channelListing: { select: { id: true, marketplace: true, product: { select: { id: true, sku: true } } } },
        },
      }),
      productId
        ? Promise.resolve([])
        : prisma.ebayVolumePromotion.findMany({
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: NESTED_CAP,
            select: { id: true, name: true, marketplace: true, tiers: true, skus: true, status: true, startDate: true, endDate: true, lastSyncStatus: true, lastSyncError: true },
          }),
    ])
    const event = (e: (typeof events.active)[number]) => ({
      id: e.id,
      name: e.name,
      from: iso(e.startDate),
      until: iso(e.endDate),
      channel: e.channel,
      marketplace: e.marketplace,
      productType: e.productType,
      priceActions: e.priceActions.map((a) => ({
        action: a.action, value: money(a.value), channel: a.channel, marketplace: a.marketplace, productType: a.productType,
        saleFrom: iso(a.setSalePriceFrom), saleUntil: iso(a.setSalePriceUntil),
      })),
    })
    const s = switches()
    return {
      ok: true,
      data: {
        saleEvents: {
          counts: events.counts,
          active: events.active.map(event),
          upcoming: events.upcoming.map(event),
          ended: events.ended.map(event),
          applies: s.pricingCron
            ? 'Price actions are applied by the pricing cron while an event runs.'
            : 'The pricing cron is off here (NEXUS_ENABLE_PRICING_CRON): no price action is applied while it is off.',
        },
        ebayMarkdowns: markdowns.map((m) => ({
          id: m.id, listingId: m.channelListing.id, productId: m.channelListing.product.id, sku: m.channelListing.product.sku,
          marketplace: m.channelListing.marketplace, discount: { type: m.discountType, value: money(m.discountValue) },
          originalPrice: money(m.originalPrice), markdownPrice: money(m.markdownPrice), currency: m.currency, status: m.status,
          from: iso(m.startDate), until: iso(m.endDate), lastSync: m.lastSyncStatus, lastSyncError: clip(m.lastSyncError),
        })),
        ebayVolumePricing: volume.map((v) => ({
          id: v.id, name: v.name, marketplace: v.marketplace, tiers: v.tiers, skus: v.skus, status: v.status,
          from: iso(v.startDate), until: iso(v.endDate), lastSync: v.lastSyncStatus, lastSyncError: clip(v.lastSyncError),
        })),
        ebaySends: { markdowns: s.ebayMarkdownsLive ? 'live' : 'dry run', volumePricing: s.ebayVolumePricingLive ? 'live' : 'dry run' },
      },
    }
  },
}

// ── scheduled-price-changes ───────────────────────────────────────────────────────────────────────────

const SCHEDULED = 'scheduled-price-changes'
const SCHEDULE_STATUSES = ['PENDING', 'UNKNOWN', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED', 'ALL'] as const

const scheduledPriceChanges: AgentTool = {
  name: SCHEDULED,
  title: 'Scheduled price changes',
  input: z.object({
    productId: z.string().trim().min(1).max(64).optional().describe('only this product\'s scheduled changes'),
    status: z.preprocess(upper, z.enum(SCHEDULE_STATUSES)).optional()
      .describe('PENDING (default), UNKNOWN (its run died: check it), APPLYING, APPLIED, FAILED, CANCELLED or ALL'),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
      .describe(`changes per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
      .describe('nextCursor from the previous page, with the same filters; omit it for the first page'),
  }),
  requires: [F.pricingView],
  category: 'pricing',
  riskTier: 'low',
  readOnly: true,
  description:
    'Master price changes scheduled for later, soonest first: the product, the new price (or a percent move) against '
    + 'today\'s master price and its bounds, when, the status (PENDING, APPLIED, FAILED with its error, CANCELLED) and '
    + 'who set it. A pending change is applied by the scheduled-changes job at its time (it says whether that job runs '
    + 'here), through the master price, so every listing that follows it moves too. UNKNOWN: the run died while '
    + 'applying it, so it may already have gone out; it is never run again by itself — check the price, then mark it '
    + 'applied or retry it (schedule-price-change, action resolve). Every answer counts the changes waiting for that '
    + 'check. Returns { items, nextCursor, needsCheck }.',
  handler: async (args): Promise<ToolResult> => {
    try {
      const productId = args.productId as string | undefined
      if (productId && !(await isLiveProduct(productId))) return { ok: false, error: PRODUCT_NOT_FOUND }
      const status = (args.status as string | undefined) ?? 'PENDING'
      const size = pageSize(args.limit as number | undefined)
      const { limit: _limit, cursor: _cursor, ...filters } = args
      const scope = cursorScope(SCHEDULED, { business: workspaceIdForQuery(), ...filters })
      const start = decodeCursor(scope, args.cursor as string | undefined)
      const after: Prisma.ScheduledProductChangeWhereInput = start
        ? { OR: [{ scheduledFor: { gt: new Date(String(start.values[0])) } }, { scheduledFor: new Date(String(start.values[0])), id: { gt: start.id } }] }
        : {}
      const rows = await prisma.scheduledProductChange.findMany({
        where: {
          AND: [
            { kind: 'PRICE', product: { deletedAt: null } },
            productId ? { productId } : {},
            status === 'ALL' ? {} : { status },
            after,
          ],
        },
        orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
        take: size + 1,
        select: {
          id: true, productId: true, payload: true, scheduledFor: true, status: true, appliedAt: true, error: true, createdBy: true, createdAt: true,
          product: { select: { sku: true, basePrice: true, minPrice: true, maxPrice: true } },
        },
      })
      const page = rows.slice(0, size)
      const last = page.at(-1)
      const needsCheck = await prisma.scheduledProductChange.count({ where: { status: 'UNKNOWN', product: { deletedAt: null }, ...(productId ? { productId } : {}) } })
      return {
        ok: true,
        data: {
          needsCheck,
          items: page.map((c) => {
            const change = priceChangeOf(c.payload)
            const now = money(c.product.basePrice)
            const target = change.newPrice ?? (change.adjustPercent != null && now != null ? Math.round(now * (1 + change.adjustPercent / 100) * 100) / 100 : null)
            const min = money(c.product.minPrice)
            const max = money(c.product.maxPrice)
            return {
              id: c.id, productId: c.productId, sku: c.product.sku, ...change, masterPriceNow: now, wouldBe: target,
              outsideBounds: target == null ? null : min != null && target < min ? 'below-min' : max != null && target > max ? 'above-max' : null,
              at: iso(c.scheduledFor), status: c.status, appliedAt: iso(c.appliedAt), error: clip(c.error), createdBy: c.createdBy, createdAt: iso(c.createdAt),
              ...(c.status === 'UNKNOWN' ? { check: 'Its run died while applying it: check the master price, then mark it applied or retry it.' } : {}),
            }
          }),
          nextCursor: rows.length > size && last ? encodeCursor(scope, { values: [last.scheduledFor.toISOString()], id: last.id }) : null,
          masterCurrency: masterCurrency(),
          scheduler: switches().scheduledChanges
            ? 'The scheduled-changes job runs every minute here and applies a pending change at its time.'
            : 'The scheduled-changes job is off here (NEXUS_ENABLE_SCHEDULED_CHANGES=0): nothing pending is applied.',
        },
      }
    } catch (error) {
      if (error instanceof InvalidCursorError) return { ok: false, error: `${SCHEDULED} was called wrongly — cursor: ${error.message}` }
      throw error
    }
  },
}

// ── price-explain ─────────────────────────────────────────────────────────────────────────────────────

const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]

const priceExplain: AgentTool = {
  name: 'price-explain',
  title: 'Explain a price',
  input: z.object({
    productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
    channel: z.preprocess(upper, z.enum(CHANNELS)).describe('the channel the price is for'),
    marketplace: z.string().trim().toUpperCase().min(2).max(20).describe('the marketplace code, e.g. IT or DE; GLOBAL for Shopify and Etsy'),
    fulfillment: z.preprocess(upper, z.enum(['FBA', 'FBM'])).optional().describe('Amazon only: FBA or FBM'),
    accountId: z.string().trim().min(1).max(64).optional()
      .describe('the channel account whose listing is meant, when the business has several (the answer names them when it needs one)'),
  }),
  requires: [F.pricingView],
  restrictedFields: {
    landedCost: FIELDS.financialsCostsView,
    effectiveCostBasis: FIELDS.financialsCostsView,
    referralFee: FIELDS.financialsFeesView,
  },
  category: 'pricing',
  riskTier: 'low',
  readOnly: true,
  description:
    'Why a listing has its price: the pricing engine\'s answer for one product on one channel and market — the price '
    + 'and currency, where it comes from (a scheduled sale, an override, the channel rule, a pricing rule, the master '
    + 'price, the listing\'s own price), the floor and ceiling and whether it was clamped, the steps of its reasoning '
    + 'and its warnings, and a pricing rule\'s suggestion (never sent by itself). With several accounts on the channel, '
    + 'name one (accountId) when the product is listed on more than one: the answer lists them. Also the last 20 price changes on '
    + 'that channel and market. Costs and fees in the breakdown are shown only to a person who may see them.',
  async handler(args, ctx) {
    const product = await prisma.product.findFirst({ where: liveProduct(String(args.productId ?? '')), select: { id: true, sku: true, name: true } })
    if (!product) return { ok: false, error: PRODUCT_NOT_FOUND }
    const channel = String(args.channel)
    const marketplace = String(args.marketplace)
    const accountId = args.accountId as string | undefined
    if (accountId && !(await prisma.channelConnection.findFirst({ where: { id: accountId, channelType: channel, isActive: true }, select: { id: true } }))) {
      return { ok: false, error: `accountId is not an active ${channel} account of this business.` }
    }
    let resolution
    try {
      resolution = await resolvePrice(prisma as never, {
        sku: product.sku, channel, marketplace, fulfillmentMethod: (args.fulfillment as 'FBA' | 'FBM' | undefined) ?? null,
        ...(accountId ? { channelConnectionId: accountId } : {}),
      })
    } catch (error) {
      if (isPriceRefusal(error)) return { ok: false, error: (error as Error).message }
      throw error
    }
    const history = await readPriceHistory({ productId: product.id, channel, marketplace, limit: '20' })
    const b = resolution.breakdown
    return {
      ok: true,
      data: {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        channel,
        marketplace,
        ...(accountId ? { accountId } : {}),
        price: resolution.price,
        currency: resolution.currency,
        source: resolution.source,
        constraints: resolution.constraints,
        breakdown: {
          masterPrice: b.masterPrice, fxRate: b.fxRate, appliedRule: b.appliedRule ?? null, vatRate: b.vatRate, taxInclusive: b.taxInclusive,
          fbaFee: b.fbaFee, referralFee: b.referralFee, costPrice: b.costPrice, landedCost: b.landedCost, effectiveCostBasis: b.effectiveCostBasis,
          minMarginPercent: b.minMarginPercent,
          ...(b.salePriceWindow ? { saleWindow: { from: iso(b.salePriceWindow.startsAt), until: iso(b.salePriceWindow.endsAt) } } : {}),
          ...(b.suggestion ? { suggestion: { ...b.suggestion, sent: false } } : {}),
        },
        reasoning: resolution.reasoning.slice(0, NESTED_CAP).map((r) => clip(r)),
        // The engine's "landed cost X > entered cost Y" names both costs in its text: only for a person who may see costs.
        warnings: resolution.warnings
          .filter((w) => ctx.can(FIELDS.financialsCostsView) || !/^Landed cost /.test(w))
          .slice(0, NESTED_CAP).map((w) => clip(w)),
        recentChanges: history.events.map((e) => ({
          at: iso(e.changedAt), oldPrice: e.oldPrice, newPrice: e.newPrice, currency: e.currency, source: e.source, reason: clip(e.reason), actor: e.actor,
        })),
      },
    }
  },
}

export const PRICING_READ_TOOLS: AgentTool[] = [priceStatus, pricingRules, promotions, scheduledPriceChanges, priceExplain]
