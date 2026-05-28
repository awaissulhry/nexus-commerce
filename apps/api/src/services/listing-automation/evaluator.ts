/**
 * OL.D.2 — Listing-automation evaluator (cron sweep).
 *
 * Each tick: for every listings-domain trigger that has at least one
 * ENABLED rule, scan the catalog, build a per-product context, and fan
 * it through the shared engine (evaluateAllRulesForTrigger). If a trigger
 * has no enabled rules, its scan is skipped entirely — so a catalog with
 * no listing rules pays almost nothing.
 *
 * Triggers handled here (cron-pollable):
 *   price_diverged — within a currency, a product's active listings'
 *                    prices spread beyond what the rule's condition allows
 *                    (context: price.{min,max,spreadPct})
 *   inventory_low  — the lowest published quantity across a product's
 *                    active listings (context: inventory.available)
 *
 * listing_health_low (OL.D.5) and master_content_changed (OL.D.6) plug
 * in here later. price/inventory keep this self-contained.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { evaluateAllRulesForTrigger } from '../automation-rule.service.js'
import './action-handlers.js' // side-effect: register listings actions
import { currencyForMarket, type ListingCoord, type ListingRuleContext } from './triggers.js'

const MAX_PRODUCTS = 2000 // safety cap per tick

async function hasEnabledRules(trigger: string): Promise<boolean> {
  const n = await prisma.automationRule.count({
    where: { domain: 'listings', trigger, enabled: true },
  })
  return n > 0
}

interface ProductWithListings {
  id: string
  sku: string | null
  name: string | null
  basePrice: unknown
  productType: string | null
  channelListings: Array<{
    channel: string
    marketplace: string
    price: unknown
    quantity: number | null
    listingStatus: string | null
    isPublished: boolean
    offerActive: boolean
    title: string | null
    masterTitle: string | null
    description: string | null
    masterDescription: string | null
    platformAttributes: unknown
  }>
}

// OL.D.5 — per-product health, identical "ready" rule to OL.C
// (title + positive price; Amazon also needs a productType; ERROR =
// unhealthy) so the grid health column and health-nudge rules agree.
function computeHealth(p: ProductWithListings): { score: number; ready: number; total: number; blocked: number } | null {
  const ls = p.channelListings
  if (ls.length === 0) return null
  let ready = 0
  for (const l of ls) {
    const pa = (l.platformAttributes as Record<string, unknown> | null) ?? {}
    const title = l.title ?? l.masterTitle ?? p.name ?? null
    const price = toNum(l.price) ?? toNum(p.basePrice)
    const productType = (pa.productType as string | undefined) ?? p.productType ?? null
    const ch = l.channel.toUpperCase()
    const missing =
      !title || String(title).trim() === '' ||
      price == null || price <= 0 ||
      (ch === 'AMAZON' && (!productType || String(productType).trim() === ''))
    if (!missing && l.listingStatus !== 'ERROR') ready++
  }
  const total = ls.length
  return { score: Math.round((ready / total) * 100), ready, total, blocked: total - ready }
}

function toNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return Number.isFinite(n) ? n : null
}

function buildCoords(p: ProductWithListings): ListingCoord[] {
  return p.channelListings.map((l) => ({
    channel: l.channel,
    marketplace: l.marketplace,
    price: toNum(l.price),
    quantity: l.quantity,
    currency: currencyForMarket(l.marketplace),
    listingStatus: l.listingStatus,
    listed: l.isPublished,
  }))
}

export interface ListingAutomationRunResult {
  byTrigger: Record<string, { productsScanned: number; matched: number }>
  totalMatched: number
  forceDryRun: boolean
}

export async function runListingAutomationOnce(opts?: { forceDryRun?: boolean }): Promise<ListingAutomationRunResult> {
  const forceDryRun = !!opts?.forceDryRun
  const result: ListingAutomationRunResult = { byTrigger: {}, totalMatched: 0, forceDryRun }

  const wantPrice = await hasEnabledRules('price_diverged')
  const wantInv = await hasEnabledRules('inventory_low')
  const wantHealth = await hasEnabledRules('listing_health_low')
  if (!wantPrice && !wantInv && !wantHealth) return result // nothing to do — cheap exit

  const products = (await prisma.product.findMany({
    where: { channelListings: { some: { isPublished: true, offerActive: true } } },
    select: {
      id: true, sku: true, name: true, basePrice: true, productType: true,
      channelListings: {
        where: { isPublished: true, offerActive: true },
        select: {
          channel: true, marketplace: true, price: true, quantity: true, listingStatus: true,
          isPublished: true, offerActive: true,
          title: true, masterTitle: true, description: true, masterDescription: true, platformAttributes: true,
        },
      },
    },
    take: MAX_PRODUCTS,
  })) as unknown as ProductWithListings[]

  if (wantPrice) result.byTrigger.price_diverged = { productsScanned: 0, matched: 0 }
  if (wantInv) result.byTrigger.inventory_low = { productsScanned: 0, matched: 0 }
  if (wantHealth) result.byTrigger.listing_health_low = { productsScanned: 0, matched: 0 }

  for (const p of products) {
    const coords = buildCoords(p)
    const base = {
      product: { id: p.id, sku: p.sku, name: p.name, basePrice: toNum(p.basePrice) },
      listings: coords,
    }

    // price_diverged — within EUR, spread across priced coordinates.
    if (wantPrice) {
      const priced = coords.filter((c) => c.currency === 'EUR' && c.price != null && c.price > 0)
      if (priced.length >= 2) {
        const prices = priced.map((c) => c.price as number)
        const min = Math.min(...prices)
        const max = Math.max(...prices)
        const spreadPct = min > 0 ? ((max - min) / min) * 100 : 0
        const ctx: ListingRuleContext = {
          ...base,
          trigger: 'price_diverged',
          price: { min, max, spreadPct, currency: 'EUR' },
        }
        const stat = result.byTrigger.price_diverged
        stat.productsScanned++
        const res = await evaluateAllRulesForTrigger({ domain: 'listings', trigger: 'price_diverged', context: ctx, forceDryRun })
        stat.matched += res.filter((r) => r.matched).length
      }
    }

    // inventory_low — lowest published quantity across active coordinates.
    if (wantInv) {
      const qtys = coords.map((c) => c.quantity).filter((q): q is number => q != null)
      if (qtys.length > 0) {
        const available = Math.min(...qtys)
        const ctx: ListingRuleContext = { ...base, trigger: 'inventory_low', inventory: { available } }
        const stat = result.byTrigger.inventory_low
        stat.productsScanned++
        const res = await evaluateAllRulesForTrigger({ domain: 'listings', trigger: 'inventory_low', context: ctx, forceDryRun })
        stat.matched += res.filter((r) => r.matched).length
      }
    }

    // listing_health_low — marketplace-aware readiness (OL.C rule).
    if (wantHealth) {
      const health = computeHealth(p)
      if (health) {
        const ctx: ListingRuleContext = { ...base, trigger: 'listing_health_low', health }
        const stat = result.byTrigger.listing_health_low
        stat.productsScanned++
        const res = await evaluateAllRulesForTrigger({ domain: 'listings', trigger: 'listing_health_low', context: ctx, forceDryRun })
        stat.matched += res.filter((r) => r.matched).length
      }
    }
  }

  result.totalMatched = Object.values(result.byTrigger).reduce((s, t) => s + t.matched, 0)
  logger.info('[listing-automation] sweep complete', result as unknown as Record<string, unknown>)
  return result
}
