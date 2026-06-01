/**
 * TD.2 — automatic keyword harvesting & pruning. Runs the harvest engine
 * (promote converting search terms to exact · auto-negative wasteful terms) on
 * a daily schedule, turning a manual "preview then apply" tool into a 24/7
 * search-term manager.
 *
 * Autonomy-gated: OFF/halt → skip · SUGGEST → propose-only (notify) · AUTO →
 * apply. Harvest writes are additive + reversible (new negatives / new exact
 * keywords) and bounded by previewHarvest's thresholds (negatives = spend ≥ €15
 * with 0 orders; graduations = ≥2 orders), so volume is naturally limited.
 */
import { logger } from '../../utils/logger.js'
import { previewHarvest, applyHarvest } from './ads-harvest.service.js'
import { getAutomationState } from './ads-automation-state.service.js'
import { notifyAutomation } from './ads-automation-notify.service.js'

export interface AutoHarvestResult {
  skipped?: string
  proposedNegatives: number
  proposedGraduations: number
  negativesAdded: number
  keywordsGraduated: number
  dryRun: boolean
}

export async function runAutoHarvestOnce(): Promise<AutoHarvestResult> {
  const state = await getAutomationState()
  if (state.effectivelyStopped) return { skipped: 'halted-or-off', proposedNegatives: 0, proposedGraduations: 0, negativesAdded: 0, keywordsGraduated: 0, dryRun: false }
  const forceDry = state.autonomy === 'SUGGEST'

  const preview = await previewHarvest({})
  const proposedNegatives = preview.negatives.length
  const proposedGraduations = preview.graduations.length
  if (proposedNegatives === 0 && proposedGraduations === 0) {
    return { proposedNegatives: 0, proposedGraduations: 0, negativesAdded: 0, keywordsGraduated: 0, dryRun: forceDry }
  }

  if (forceDry) {
    await notifyAutomation({
      type: 'ads-auto-harvest', severity: 'info',
      title: `Harvest: ${proposedNegatives} negatives + ${proposedGraduations} graduations proposed`,
      body: 'SUGGEST mode — review in the Automation › Harvest view.',
      href: '/marketing/trading-desk/automation',
    }).catch(() => {})
    return { proposedNegatives, proposedGraduations, negativesAdded: 0, keywordsGraduated: 0, dryRun: true }
  }

  const res = await applyHarvest({ negatives: preview.negatives, graduations: preview.graduations, userId: 'automation:auto-harvest' })
  logger.info('[ads-auto-harvest] run', { proposedNegatives, proposedGraduations, ...res })
  await notifyAutomation({
    type: 'ads-auto-harvest', severity: res.errors.length ? 'warn' : 'success',
    title: `Harvest: +${res.negativesAdded} negatives, +${res.keywordsGraduated} graduated keywords`,
    body: `Auto-pruned wasted spend + promoted converters.${res.errors.length ? ` ${res.errors.length} errors.` : ''}`,
    href: '/marketing/trading-desk/automation',
  }).catch(() => {})
  return { proposedNegatives, proposedGraduations, negativesAdded: res.negativesAdded, keywordsGraduated: res.keywordsGraduated, dryRun: false }
}
