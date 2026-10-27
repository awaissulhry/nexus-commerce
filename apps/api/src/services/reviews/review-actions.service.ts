/**
 * RX.5 — Close the SR.3 loop.
 *
 * SR.3 already drafts spike-driven fixes (improved bullets, an A+ module)
 * via the AutomationRule engine, but the output only ever lived in
 * execution logs. This service runs the same handlers on demand for a
 * spike and PERSISTS the results as ReviewActionItem rows an operator can
 * apply or dismiss — plus a recall-assessment flag for SAFETY spikes
 * (helmets / protective gear, GPSR-relevant).
 *
 * Dedup: one OPEN item per (spikeId, type) — regenerating refreshes the
 * payload instead of piling up duplicates.
 */

import prisma from '../../db.js'
import { ACTION_HANDLERS } from '../automation-rule.service.js'
import { logger } from '../../utils/logger.js'
import { visibleReviewWhere } from './review-visibility.js'
import { AMAZON_TOPIC_MARKETS, parseTopicRows } from './review-insights-math.js'
// Side-effect import: registers update_product_bullets_from_review +
// create_aplus_module_from_review on ACTION_HANDLERS.
import './review-action-handlers.js'

interface PersistInput {
  spikeId: string | null
  productId: string | null
  marketplace: string | null
  category: string | null
  type: 'BULLETS' | 'APLUS' | 'RECALL_FLAG' | 'TASK'
  title: string
  detail: string | null
  payload: unknown
  source: string
  actor: string
}

async function persistItem(input: PersistInput) {
  // One open fix per alert and kind; a product's own suggestions (no alert): one per product, theme and kind.
  const existing = await prisma.reviewActionItem.findFirst({
    where: input.spikeId
      ? { spikeId: input.spikeId, type: input.type, status: 'OPEN' }
      : { spikeId: null, productId: input.productId, category: input.category, type: input.type, status: 'OPEN' },
    select: { id: true },
  })
  const data = {
    spikeId: input.spikeId,
    productId: input.productId,
    marketplace: input.marketplace,
    category: input.category,
    type: input.type,
    title: input.title,
    detail: input.detail,
    payload: (input.payload as object | null) ?? undefined,
    source: input.source,
    createdBy: input.actor,
  }
  if (existing) {
    return prisma.reviewActionItem.update({ where: { id: existing.id }, data })
  }
  return prisma.reviewActionItem.create({ data })
}

export async function generateActionItemsForSpike(
  spikeId: string,
  actor = 'user:anonymous',
  source = 'manual',
) {
  const spike = await prisma.reviewSpike.findUnique({
    where: { id: spikeId },
    include: { product: { select: { id: true, sku: true, name: true, productType: true } } },
  })
  if (!spike) throw new Error('spike not found')

  const context = {
    trigger: 'REVIEW_SPIKE_DETECTED',
    marketplace: spike.marketplace,
    spike: {
      id: spike.id,
      category: spike.category,
      spikeMultiplier: spike.spikeMultiplier,
      sampleTopPhrases: spike.sampleTopPhrases,
    },
    product: spike.product
      ? {
          id: spike.product.id,
          sku: spike.product.sku,
          name: spike.product.name,
          productType: spike.product.productType,
        }
      : null,
  }
  const meta = { dryRun: false, ruleId: 'manual' }
  const base = {
    spikeId: spike.id,
    productId: spike.productId ?? null,
    marketplace: spike.marketplace,
    category: spike.category,
    source,
    actor,
  }
  const created: unknown[] = []

  // Improved bullets.
  try {
    const res = await ACTION_HANDLERS.update_product_bullets_from_review?.(
      { type: 'update_product_bullets_from_review' },
      context,
      meta,
    )
    if (res?.ok) {
      const out = res.output as { bullets?: string[]; category?: string }
      created.push(
        await persistItem({
          ...base,
          type: 'BULLETS',
          title: `Improved bullets — ${out.category ?? spike.category}`,
          detail: 'AI-drafted listing bullets that proactively address this complaint spike.',
          payload: { bullets: out.bullets ?? [] },
        }),
      )
    }
  } catch (err) {
    logger.warn('[review-actions] bullets failed', { spikeId, error: String(err) })
  }

  // A+ module.
  try {
    const res = await ACTION_HANDLERS.create_aplus_module_from_review?.(
      { type: 'create_aplus_module_from_review' },
      context,
      meta,
    )
    if (res?.ok) {
      const out = res.output as { module?: { headline: string; body: string }; category?: string }
      created.push(
        await persistItem({
          ...base,
          type: 'APLUS',
          title: `A+ module — ${out.category ?? spike.category}`,
          detail: 'AI-drafted A+ content module addressing the concern proactively.',
          payload: { module: out.module ?? null },
        }),
      )
    }
  } catch (err) {
    logger.warn('[review-actions] aplus failed', { spikeId, error: String(err) })
  }

  // Reviews Insights (PR E) — a shipping complaint is fixed by people, not by listing text: a task (no approval).
  const task = taskFor(spike.category, spike.marketplace)
  if (task) created.push(await persistItem({ ...base, type: 'TASK', title: task.title, detail: task.detail, payload: { task: null } }))

  // Recall assessment for SAFETY spikes (helmets / protective gear).
  if (spike.category === 'SAFETY') {
    created.push(
      await persistItem({
        ...base,
        type: 'RECALL_FLAG',
        title: 'Safety spike — assess for recall',
        detail:
          'A surge in SAFETY-category complaints. Review against GPSR / recall criteria and open a recall if warranted.',
        payload: { recallsHref: '/fulfillment/stock/recalls' },
      }),
    )
  }

  return { created }
}

/** A task for a complaint that people fix rather than listing text (Reviews Insights, PR E); null when none fits. */
export function taskFor(category: string | null, marketplace: string | null): { title: string; detail: string } | null {
  if (category === 'SHIPPING') {
    return {
      title: `Check the carrier and packaging${marketplace ? ` for ${marketplace}` : ''}`,
      detail: 'Buyers complain about delivery: compare the carrier’s delivery times for the last 30 days and check the packaging. A task changes nothing on a channel.',
    }
  }
  return null
}

export class SuggestNotFoundError extends Error {
  readonly statusCode = 404
}

const SUGGEST_DAYS = 30

/**
 * Reviews Insights › product pop-up "Suggest a fix": fixes for one product (and its variants) from its top complaint of
 * the last 30 days — its reviews' negative themes, or with none, Amazon's negative topics — through the same AI
 * handlers as an alert's. Nothing is changed anywhere: the fixes wait on the Fixes page.
 */
export async function suggestFixesForProduct(productId: string, actor: string, now = new Date()): Promise<{ created: unknown[]; theme: string | null; market: string | null; words: string | null }> {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, sku: true, name: true, productType: true, children: { where: { deletedAt: null }, select: { id: true } } },
  })
  if (!product) throw new SuggestNotFoundError('No product with this id in this business.')
  const ids = [product.id, ...product.children.map((c) => c.id)]
  const since = new Date(now.getTime() - SUGGEST_DAYS * 86_400_000)
  const [reviews, insights] = await Promise.all([
    prisma.review.findMany({
      where: visibleReviewWhere({ productId: { in: ids }, postedAt: { gte: since, lte: now }, sentiment: { is: { label: 'NEGATIVE' } } }),
      orderBy: { postedAt: 'desc' },
      select: { marketplace: true, sentiment: { select: { categories: true, topPhrases: true } } },
    }),
    prisma.amazonReviewInsight.findMany({ where: { productId: { in: ids }, accessStatus: 'OK', marketplace: { in: [...AMAZON_TOPIC_MARKETS] } }, select: { marketplace: true, productId: true, fetchedAt: true, positiveTopics: true, negativeTopics: true } }),
  ])
  const counts = new Map<string, { n: number; markets: Map<string, number>; phrases: string[] }>()
  for (const r of reviews) {
    for (const c of new Set(r.sentiment?.categories ?? [])) {
      if (c === 'OTHER') continue
      const slot = counts.get(c) ?? { n: 0, markets: new Map(), phrases: [] }
      slot.n += 1
      if (r.marketplace) slot.markets.set(r.marketplace, (slot.markets.get(r.marketplace) ?? 0) + 1)
      for (const p of r.sentiment?.topPhrases ?? []) if (slot.phrases.length < 3) slot.phrases.push(p)
      counts.set(c, slot)
    }
  }
  if (counts.size === 0) {
    for (const t of parseTopicRows(insights)) {
      if (t.polarity !== 'negative' || t.theme === 'OTHER') continue
      const slot = counts.get(t.theme) ?? { n: 0, markets: new Map(), phrases: [] }
      slot.n += t.mentions
      slot.markets.set(t.market, (slot.markets.get(t.market) ?? 0) + t.mentions)
      if (slot.phrases.length < 3) slot.phrases.push(t.topic)
      counts.set(t.theme, slot)
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))[0]
  if (!top) return { created: [], theme: null, market: null, words: 'No complaints about this product in the last 30 days: nothing to fix.' }
  const [category, slot] = top
  const marketplace = [...slot.markets.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  const context = {
    trigger: 'REVIEW_SPIKE_DETECTED',
    marketplace,
    // The handlers name their output after an alert; a product's own suggestion has none, so it is named after the product.
    spike: { id: `product:${product.id}`, category, spikeMultiplier: null, sampleTopPhrases: slot.phrases },
    product: { id: product.id, sku: product.sku, name: product.name, productType: product.productType },
  }
  const meta = { dryRun: false, ruleId: 'manual' }
  const base = { spikeId: null, productId: product.id, marketplace, category, source: 'manual', actor }
  const created: unknown[] = []
  try {
    const res = await ACTION_HANDLERS.update_product_bullets_from_review?.({ type: 'update_product_bullets_from_review' }, context, meta)
    if (res?.ok) {
      const out = res.output as { bullets?: string[]; category?: string }
      created.push(await persistItem({ ...base, type: 'BULLETS', title: `Improved bullets — ${out.category ?? category}`, detail: `AI-drafted listing bullets that answer the ${slot.n} complaints about it.`, payload: { bullets: out.bullets ?? [], language: 'en' } }))
    }
  } catch (err) {
    logger.warn('[review-actions] product bullets failed', { productId, error: String(err) })
  }
  if (marketplace && AMAZON_TOPIC_MARKETS.includes(marketplace)) {
    try {
      const res = await ACTION_HANDLERS.create_aplus_module_from_review?.({ type: 'create_aplus_module_from_review' }, context, meta)
      if (res?.ok) {
        const out = res.output as { module?: { headline: string; body: string }; category?: string }
        created.push(await persistItem({ ...base, type: 'APLUS', title: `A+ module — ${out.category ?? category}`, detail: 'AI-drafted A+ content module addressing the concern.', payload: { module: out.module ?? null, language: 'en' } }))
      }
    } catch (err) {
      logger.warn('[review-actions] product aplus failed', { productId, error: String(err) })
    }
  }
  const task = taskFor(category, marketplace)
  if (task) created.push(await persistItem({ ...base, type: 'TASK', title: task.title, detail: task.detail, payload: { task: null } }))
  if (category === 'SAFETY') {
    created.push(await persistItem({ ...base, type: 'RECALL_FLAG', title: 'Safety complaints — check before selling more', detail: 'Buyers mention safety: hold the units in your own warehouses for a check. Amazon FBA stock is never held from here.', payload: { recallsHref: '/fulfillment/stock/recalls' } }))
  }
  return { created, theme: category, market: marketplace, words: null }
}
