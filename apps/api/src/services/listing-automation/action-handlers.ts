/**
 * OL.D.1 — Listings-domain action handlers for the AutomationRule engine.
 *
 * Mutates the exported ACTION_HANDLERS map at module load (same pattern
 * as advertising/automation-action-handlers.ts). Importing this file is
 * enough to register every listings action; no engine code is touched.
 * The side-effect import lives at the top of the listings rule routes +
 * the evaluator job, so registration fires before any rule evaluates.
 *
 * Actions:
 *   sync_price_to_marketplaces      — enqueue PRICE_UPDATE to a product's
 *                                     eligible listings (currency-guarded)
 *   sync_inventory_to_marketplaces  — enqueue QUANTITY_UPDATE
 *
 * Both go through OutboundSyncQueue with a 5-minute holdUntil grace
 * window (so the operator can cancel before it pushes) and honour the
 * engine's dryRun flag — a dry run reports exactly what it WOULD enqueue
 * without writing a single row. `notify` / `log_only` (engine built-ins)
 * cover the health-nudge rules.
 */

import { ACTION_HANDLERS, getFieldPath, type ActionResult } from '../automation-rule.service.js'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { currencyForMarket, marketLanguage } from './triggers.js'
import { translateProductCopy } from '../ai/translate.service.js'

const GRACE_MS = 5 * 60 * 1000 // 5-minute undo window before the worker pushes

interface EligibleListing {
  id: string
  channel: string
  marketplace: string
  region: string | null
  externalListingId: string | null
  productId: string | null
}

// Resolve the product id from context (evaluator-built) or action config.
function productIdFrom(action: Record<string, unknown>, context: unknown): string | null {
  return (
    (getFieldPath(context, 'product.id') as string | undefined) ??
    (action.productId as string | undefined) ??
    null
  )
}

// Load active+published listings for a product, optionally narrowed by the
// rule's channel / marketplace filters.
async function eligibleListings(
  productId: string,
  action: Record<string, unknown>,
): Promise<EligibleListing[]> {
  const channels = Array.isArray(action.channels) ? (action.channels as string[]).map((c) => c.toUpperCase()) : null
  const marketplaces = Array.isArray(action.marketplaces) ? (action.marketplaces as string[]).map((m) => m.toUpperCase()) : null
  const rows = await prisma.channelListing.findMany({
    where: {
      productId,
      isPublished: true,
      offerActive: true,
      ...(channels ? { channel: { in: channels } } : {}),
      ...(marketplaces ? { marketplace: { in: marketplaces } } : {}),
    },
    select: { id: true, channel: true, marketplace: true, region: true, externalListingId: true, productId: true },
  })
  return rows
}

/**
 * sync_price_to_marketplaces — push a reference price to a product's
 * listings. referencePrice: 'master' (default, = Product.basePrice) |
 * 'min' | 'max' (from the diverged-price context). Currency-guarded:
 * by default only same-currency-as-reference (EUR) coordinates receive
 * the push; non-EUR markets are skipped (copying €→£ is wrong).
 */
ACTION_HANDLERS.sync_price_to_marketplaces = async (action, context, meta): Promise<ActionResult> => {
  const productId = productIdFrom(action as Record<string, unknown>, context)
  if (!productId) return { type: action.type, ok: false, error: 'No product.id in context' }

  const ref = (action.referencePrice as string | undefined) ?? 'master'
  let price: number | null = null
  if (ref === 'master') price = getFieldPath(context, 'product.basePrice') as number | null
  else if (ref === 'min') price = getFieldPath(context, 'price.min') as number | null
  else if (ref === 'max') price = getFieldPath(context, 'price.max') as number | null
  if (price == null || !(price > 0)) {
    return { type: action.type, ok: false, error: `No usable reference price (${ref})` }
  }

  const onlySameCurrency = action.onlySameCurrency !== false // default true
  const refCurrency = 'EUR' // master price is EUR
  const listings = await eligibleListings(productId, action as Record<string, unknown>)
  const targets = listings.filter((l) => !onlySameCurrency || currencyForMarket(l.marketplace) === refCurrency)
  const skippedCurrency = listings.length - targets.length

  if (targets.length === 0) {
    return { type: action.type, ok: true, output: { enqueued: 0, skippedCurrency, note: 'no eligible coordinates' } }
  }

  const coordinates = targets.map((l) => `${l.channel}:${l.marketplace}`)
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, wouldEnqueue: targets.length, price, skippedCurrency, coordinates } }
  }

  await prisma.outboundSyncQueue.createMany({
    data: targets.map((l) => ({
      productId: l.productId ?? productId,
      channelListingId: l.id,
      targetChannel: l.channel as never,
      targetRegion: l.region ?? l.marketplace ?? undefined,
      syncType: 'PRICE_UPDATE' as const,
      syncStatus: 'PENDING' as const,
      payload: { price, source: `AUTOMATION:${meta.ruleId}` } as never,
      externalListingId: l.externalListingId ?? undefined,
      retryCount: 0,
      maxRetries: 3,
      holdUntil: new Date(Date.now() + GRACE_MS),
    })) as never,
    skipDuplicates: true,
  })
  logger.info('[listing-automation] sync_price enqueued', { ruleId: meta.ruleId, productId, count: targets.length, price })
  return { type: action.type, ok: true, output: { enqueued: targets.length, price, skippedCurrency, coordinates } }
}

/**
 * sync_inventory_to_marketplaces — push a quantity to a product's
 * listings. quantity comes from action.quantity or the inventory_low
 * context (inventory.available). Enqueues QUANTITY_UPDATE.
 */
ACTION_HANDLERS.sync_inventory_to_marketplaces = async (action, context, meta): Promise<ActionResult> => {
  const productId = productIdFrom(action as Record<string, unknown>, context)
  if (!productId) return { type: action.type, ok: false, error: 'No product.id in context' }

  const quantity =
    (action.quantity as number | undefined) ??
    (getFieldPath(context, 'inventory.available') as number | undefined) ??
    null
  if (quantity == null || quantity < 0) {
    return { type: action.type, ok: false, error: 'No usable quantity (set action.quantity or inventory.available)' }
  }

  const listings = await eligibleListings(productId, action as Record<string, unknown>)
  if (listings.length === 0) {
    return { type: action.type, ok: true, output: { enqueued: 0, note: 'no eligible coordinates' } }
  }
  const coordinates = listings.map((l) => `${l.channel}:${l.marketplace}`)
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, wouldEnqueue: listings.length, quantity, coordinates } }
  }

  await prisma.outboundSyncQueue.createMany({
    data: listings.map((l) => ({
      productId: l.productId ?? productId,
      channelListingId: l.id,
      targetChannel: l.channel as never,
      targetRegion: l.region ?? l.marketplace ?? undefined,
      syncType: 'QUANTITY_UPDATE' as const,
      syncStatus: 'PENDING' as const,
      payload: { quantity, source: `AUTOMATION:${meta.ruleId}` } as never,
      externalListingId: l.externalListingId ?? undefined,
      retryCount: 0,
      maxRetries: 3,
      holdUntil: new Date(Date.now() + GRACE_MS),
    })) as never,
    skipDuplicates: true,
  })
  logger.info('[listing-automation] sync_inventory enqueued', { ruleId: meta.ruleId, productId, count: listings.length, quantity })
  return { type: action.type, ok: true, output: { enqueued: listings.length, quantity, coordinates } }
}

// Cap distinct target languages per cascade so a runaway rule can't burn
// AI budget (mirrors the field-links MAX_TRANSLATE_LANGS guard).
const MAX_CASCADE_LANGS = 8

/**
 * cascade_translate_content — translate the master title/description into
 * each target listing's market language and enqueue a FULL_SYNC behind
 * the grace window (the operator's undo/approval window). Same-language
 * targets get the master copy verbatim. Honours the house glossary
 * (TerminologyPreference, brand-scoped + global) so machine translation
 * keeps motorcycle-gear terms right. Dry-run reports the plan WITHOUT
 * calling AI or writing anything. sourceLanguage defaults to 'en'
 * (operator-facing master copy); set action.sourceLanguage to override.
 */
ACTION_HANDLERS.cascade_translate_content = async (action, context, meta): Promise<ActionResult> => {
  const productId = productIdFrom(action as Record<string, unknown>, context)
  if (!productId) return { type: action.type, ok: false, error: 'No product.id in context' }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { name: true, description: true, brand: true },
  })
  const sourceName = product?.name ?? (getFieldPath(context, 'product.name') as string | null)
  const sourceDescription = product?.description ?? null
  if (!sourceName && !sourceDescription) {
    return { type: action.type, ok: false, error: 'Master has no name/description to cascade' }
  }
  const sourceLang = ((action.sourceLanguage as string | undefined) ?? 'en').toLowerCase()

  const listings = await eligibleListings(productId, action as Record<string, unknown>)
  if (listings.length === 0) {
    return { type: action.type, ok: true, output: { enqueued: 0, note: 'no eligible coordinates' } }
  }

  // Group targets by language (one translate call per distinct language).
  const byLang = new Map<string, EligibleListing[]>()
  for (const l of listings) {
    const lang = marketLanguage(l.marketplace)
    const arr = byLang.get(lang) ?? []
    arr.push(l)
    byLang.set(lang, arr)
  }

  const plan = Array.from(byLang.keys()).map((lang) => ({ lang, verbatim: lang === sourceLang }))
  if (meta.dryRun) {
    return {
      type: action.type, ok: true,
      output: { dryRun: true, wouldEnqueue: listings.length, languages: plan, coordinates: listings.map((l) => `${l.channel}:${l.marketplace}`) },
    }
  }

  // Resolve translations per language (capped), with glossary.
  const translated = new Map<string, { title: string | null; description: string | null }>()
  let langCalls = 0
  let budgetHit = false
  for (const [lang, group] of byLang) {
    void group
    if (lang === sourceLang) {
      translated.set(lang, { title: sourceName ?? null, description: sourceDescription })
      continue
    }
    if (langCalls >= MAX_CASCADE_LANGS) { budgetHit = true; continue }
    langCalls++
    let glossary: Array<{ preferred: string; avoid?: string[]; context?: string | null }> = []
    try {
      const terms = await prisma.terminologyPreference.findMany({
        where: { language: lang, OR: [{ brand: product?.brand ?? null }, { brand: null }] },
        select: { preferred: true, avoid: true, context: true },
      })
      glossary = terms.map((t) => ({ preferred: t.preferred, avoid: t.avoid, context: t.context }))
    } catch {
      /* glossary best-effort */
    }
    try {
      const res = await translateProductCopy({
        source: { name: sourceName, description: sourceDescription },
        targetLanguage: lang,
        fields: ['name', 'description'],
        productId,
        feature: 'listing-automation-cascade',
        brand: product?.brand ?? undefined,
        glossary: glossary.length > 0 ? glossary : undefined,
      })
      translated.set(lang, { title: res.name ?? null, description: res.description ?? null })
    } catch (err) {
      logger.warn('[listing-automation] cascade translate failed', { lang, err: err instanceof Error ? err.message : String(err) })
    }
  }

  const rows = listings
    .map((l) => {
      const t = translated.get(marketLanguage(l.marketplace))
      if (!t || (t.title == null && t.description == null)) return null
      return {
        productId: l.productId ?? productId,
        channelListingId: l.id,
        targetChannel: l.channel as never,
        targetRegion: l.region ?? l.marketplace ?? undefined,
        syncType: 'FULL_SYNC' as const,
        syncStatus: 'PENDING' as const,
        payload: { title: t.title, description: t.description, source: `AUTOMATION:${meta.ruleId}` } as never,
        externalListingId: l.externalListingId ?? undefined,
        retryCount: 0,
        maxRetries: 3,
        holdUntil: new Date(Date.now() + GRACE_MS),
      }
    })
    .filter((r): r is NonNullable<typeof r> => r != null)

  if (rows.length > 0) {
    await prisma.outboundSyncQueue.createMany({ data: rows as never, skipDuplicates: true })
  }
  logger.info('[listing-automation] cascade_translate enqueued', { ruleId: meta.ruleId, productId, count: rows.length, langCalls })
  return { type: action.type, ok: true, output: { enqueued: rows.length, languages: plan, budgetHit } }
}

export const LISTING_HANDLERS_REGISTERED = true
