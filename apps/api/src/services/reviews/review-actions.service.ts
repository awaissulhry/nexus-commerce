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
// Side-effect import: registers update_product_bullets_from_review +
// create_aplus_module_from_review on ACTION_HANDLERS.
import './review-action-handlers.js'

interface PersistInput {
  spikeId: string
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
  const existing = await prisma.reviewActionItem.findFirst({
    where: { spikeId: input.spikeId, type: input.type, status: 'OPEN' },
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
