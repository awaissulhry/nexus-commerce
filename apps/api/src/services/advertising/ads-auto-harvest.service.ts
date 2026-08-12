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
 *
 * ── 🔴 HV.0 — ARMED DOWN, 2026-08-12 ─────────────────────────────────────────────────────────
 *
 * This engine is **propose-only by default**. It applies nothing unless
 * `NEXUS_ADS_AUTO_HARVEST_ARMED` is explicitly set. Read this before you set it.
 *
 * What it was doing, measured on prod 2026-08-11 and again 2026-08-12
 * (`apps/api/scripts/_hv-page-engine.mts`, `_hv-1-candidates.mts`):
 *
 *   getAutomationState() → { autonomy: "AUTO", halted: false, effectivelyStopped: false }
 *   ads-auto-harvest — 72 runs, nightly 06:30
 *     2026-08-11T06:30 SUCCESS  neg=8/8 grad=14/14 dryRun=false      …and six more, identical
 *
 * The ONLY gate it had was the global automation state — a switch on another page, shared with
 * `ad-rank-defend`, `budget-manager-cron` and every other engine. It is `AUTO`, so `applyHarvest`
 * ran for real every night: no per-actor ceiling, no scope, no proposal, no approval, and no row
 * on any surface in the product.
 *
 * Now read `ads-graduation.ts:47-67`, which lists BOTH of the actions this engine performs —
 * `promote_to_exact` and `harvest_and_negate` — among the STRUCTURAL_ACTIONS, with the comment:
 *
 *     "Actions that CREATE or DESTROY something. Each needs a retirement path designed
 *      alongside it, and none has one yet, so none may run unattended."
 *
 * Every *rule* carrying those actions is therefore capped at PROPOSE. The engine doing the
 * identical thing was capped at nothing. That asymmetry is the whole reason for this change.
 *
 * 🔴 It has been harmless mostly by accident, and the accident runs deeper than the study found:
 *
 *   · 0 of the 14 nightly graduations are genuinely new — all 14 already exist as EXACT keywords
 *     in their source ad group, so `createKeywordLocal`'s H.1 idempotence check
 *     (`ads-create.service.ts:206`) returns the existing row and nothing is written. It does not
 *     even write an audit row, so the run leaves no trace except the `CronRun` summary.
 *   · The negations are the same. All 8 negative candidates ALREADY carry a campaign-scope
 *     negative, and `createNegative` is idempotent too. `AdvertisingActionLog` rows written by
 *     `automation:auto-harvest` in the last 30 days: **6**, across 5 days, against ~12 nights
 *     that each reported `neg=8/8 grad=14/14`.
 *
 * So `negativesAdded` / `keywordsGraduated` count candidates PROCESSED, not writes MADE, and the
 * cron line has been overstating this engine's activity by roughly two orders of magnitude. What
 * remains real is the shape: an unattended structural write path that fires whenever a genuinely
 * new term crosses the threshold — about one or two rows a week — with nothing watching.
 *
 * ⚠ Consequence, stated plainly: **an engine on PROPOSE cannot queue a suggestion.**
 * `AdsRuleSuggestion` requires a `ruleId` and `ads-auto-harvest` has none, so propose-only means
 * **notify-only** until HV.7 gives engines a queue row. In practice automatic harvesting stops.
 * That is intended and accepted: the graduations were all no-ops, and the negations are the write
 * path we are deliberately pausing.
 *
 * To re-arm: set `NEXUS_ADS_AUTO_HARVEST_ARMED=1` in Railway. Do not do it before the harvest
 * candidate list has a retirement path (HV.4) and a queue (HV.7).
 */
import { logger } from '../../utils/logger.js'
import { previewHarvest, applyHarvest } from './ads-harvest.service.js'
import { getAutomationState } from './ads-automation-state.service.js'
import { notifyAutomation } from './ads-automation-notify.service.js'
import { envEnabled } from '../../utils/env-flag.js'

/**
 * The one thing that re-arms this engine. Unset (the default) = propose-only.
 *
 * Named into the existing `NEXUS_ADS_AUTO_HARVEST_*` family (`…_SCHEDULE` is read by
 * `ads-sync.job.ts:719` and `ads-foresight.service.ts:108`) and read HERE, by `envEnabled`, on
 * the line below — one reader, greppable. That matters: `NEXUS_ENABLE_SQP_INGEST_CRON` still sits
 * in Railway with NO code reading it, where it reads as proof that feed is deliberately on. A
 * flag nobody reads is worse than no flag.
 *
 * 🔴 HV.6 — exported, and it is the reason to export it. The Actors panel has to name the flag that
 * holds this engine at Propose, and a second surface spelling the string itself would be two
 * sources of truth for one flag: a rename would move the engine and leave the page naming a flag
 * nobody reads, which is the exact defect the paragraph above describes. One literal, two readers.
 */
export const ARMED_FLAG = 'NEXUS_ADS_AUTO_HARVEST_ARMED'

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
  // HV.0 — not armed ⇒ propose-only, whatever the global dial says. The global `autonomy` is
  // deliberately NOT changed: every other engine reads it, and this must not touch them.
  const armed = envEnabled(ARMED_FLAG)
  const forceDry = !armed || state.autonomy === 'SUGGEST'

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
      // Two different reasons reach this branch and they are not the same fact — one is an
      // account-wide dial someone can move, the other is this engine being held down on purpose.
      // A notification that said "SUGGEST mode" while the account was on AUTO would send the
      // reader to the wrong control.
      body: armed
        ? 'SUGGEST mode — review in the Automation › Harvest view.'
        : `Propose-only: ${ARMED_FLAG} is not set (HV.0, 2026-08-12). Nothing was written. These actions create keywords and negatives and have no retirement path yet — see the Keyword Harvest page.`,
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
