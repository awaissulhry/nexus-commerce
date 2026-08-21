/**
 * ── BUD-PP (2026-08-21) — an HONEST budget preview for a rule that does not exist yet ─────────
 *
 * The builder's "Preview" used to be arithmetic in the browser: it took every campaign in the
 * picker, applied `groups[0]`'s THEN op to the campaign's CURRENT daily budget, clamped it, and
 * showed the result. Measured against a real armed rule, that was wrong five ways at once:
 *
 *   1. **criteria ignored** — every selected campaign was listed as if it matched, so a rule that
 *      can only ever touch 2 campaigns advertised 86 budget changes;
 *   2. **marketplace scope ignored** — a DE-scoped rule listed `ES_Phrase_3_Keywords` and
 *      `FR_Phrase_8_Keywords`, which it can never reach;
 *   3. **multi-block ignored** — only `groups[0]`'s action was ever applied, while the engine
 *      picks the FIRST BLOCK whose conditions match this campaign (BP.P4b);
 *   4. 🔴 **the wrong anchor** — the preview applied the op to the current daily budget, but
 *      `budget_apply` anchors every RELATIVE op to `budgetBaselineCents` when one is captured
 *      (BUD.2, which is what makes the rule idempotent rather than compounding). 28 campaigns
 *      carry a baseline, so the preview's *number* was wrong wherever baseline ≠ current;
 *   5. **the context floor ignored** — a campaign with no ad spend in the settled window emits no
 *      context at all, so no budget rule can ever act on it; the preview showed it anyway.
 *
 * The fix is not better arithmetic in the browser. A second implementation of "what will this rule
 * do" is exactly the trap that produced two disagreeing Criteria formatters on this same page
 * (`reference_shared_rule_column_cells`). So this runs the ENGINE:
 *
 *   real contexts (`buildCampaignBudgetContexts`, the rule's own lookback)
 *     → real scope (`ruleMatchesScope`, plus the picker list the handler enforces)
 *       → real translation (`maybeTranslateAdsRule`)
 *         → real condition evaluation (`evaluateConditions`, first-matching block)
 *           → real action (`ACTION_HANDLERS.budget_apply` with `dryRun`, which returns
 *             `wouldChange` and writes nothing)
 *
 * Every number the operator sees is therefore produced by the code that will produce the change.
 * Nothing here computes a budget itself.
 */
import { logger } from '../../utils/logger.js'
import { ruleMatchesScope } from '../automation-rule-scope.js'
import { maybeTranslateAdsRule, builderBudgetCampaignIds } from './ads-rule-adapter.service.js'

export interface BudgetPreviewRow {
  campaignId: string
  campaign: string
  marketplace: string | null
  currentEur: number
  proposedEur: number
  /** Signed change; 0 when the guardrail floor/ceiling absorbs the whole move. */
  deltaEur: number
  /** True when floor/ceiling clamped the result to no change — an honest "this does nothing". */
  clamped: boolean
  budgetUtilizationPct: number | null
  spendEur: number
}

export interface BudgetPreviewResult {
  ok: boolean
  error?: string
  windowDays: number
  /** Campaigns the operator picked. */
  selected: number
  /** Of those, how many produced a context at all (enabled ∧ ad spend inside the window). */
  measurable: number
  /** Of the measurable, how many the rule's marketplace scope admits. */
  inScope: number
  /** Of those, how many match the criteria right now. */
  matched: number
  /** Matched campaigns whose proposed budget equals the current one (floor/ceiling absorbed it). */
  noChange: number
  rows: BudgetPreviewRow[]
  untranslatable?: string[]
}

/** The draft the builder is holding — the same payload it would POST to create the rule. */
export interface BudgetPreviewDraft {
  actions?: unknown
  conditions?: unknown
  scopeMarketplace?: string | null
}

const PREVIEW_RULE_ID = 'draft-preview'

export async function previewBudgetRule(draft: BudgetPreviewDraft): Promise<BudgetPreviewResult> {
  const empty = (extra: Partial<BudgetPreviewResult> = {}): BudgetPreviewResult => ({
    ok: true, windowDays: 7, selected: 0, measurable: 0, inScope: 0, matched: 0, noChange: 0, rows: [], ...extra,
  })

  const a0 = Array.isArray(draft.actions) ? (draft.actions[0] as Record<string, unknown> | undefined) : undefined
  if (!a0 || String(a0.type ?? '') !== 'budget') {
    return { ...empty(), ok: false, error: 'not_a_budget_draft' }
  }

  // The rule's own lookback, clamped exactly as the adapter and the evaluator clamp it.
  const raw = typeof a0.windowDays === 'number' && Number.isFinite(a0.windowDays) ? a0.windowDays : 7
  const windowDays = Math.max(7, Math.min(90, Math.round(raw)))

  const picked = builderBudgetCampaignIds(draft.actions) ?? []
  if (picked.length === 0) return empty({ windowDays })

  // ── the engine's own translation, so the conditions and the action are the real ones ──
  const translated = maybeTranslateAdsRule({
    id: PREVIEW_RULE_ID,
    actions: draft.actions,
    conditions: draft.conditions,
  })
  if (!translated) return { ...empty({ windowDays }), ok: false, error: 'untranslatable_draft' }
  if (translated.untranslatable?.length) {
    // A metric with no engine signal cannot be previewed OR run — say so rather than showing a
    // preview computed from the conditions that happened to map.
    return { ...empty({ windowDays }), ok: false, error: 'untranslatable_conditions', untranslatable: translated.untranslatable }
  }

  const { buildCampaignBudgetContexts } = await import('../../jobs/advertising-rule-evaluator.job.js')
  const { evaluateConditions } = await import('../automation/conditions-tree.js')
  const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
  await import('./automation-action-handlers.js') // registers budget_apply

  const contexts = await buildCampaignBudgetContexts(windowDays)
  const pickedSet = new Set(picked)

  // Only the picked campaigns can be touched — the same restriction `campaignAllowed` applies
  // inside the handler, and (since BUD-P2) the same list that governs the rule's assignment.
  const mine = contexts.filter((c) => c.campaign?.id != null && pickedSet.has(c.campaign.id))

  /**
   * The rule's marketplace scope, enforced by the same pure matcher the tick uses.
   *
   * 🔴 `'all'` is the builder's word for UNSCOPED and must become `null` here. Passed through
   * literally, `ruleMatchesScope` compares `'all' !== 'DE'` and drops EVERY context — the preview
   * then reports "0 of 70 match" with total confidence, which is the worst possible failure for a
   * widget whose whole job is to say what will happen. Measured on the live rig before ship.
   */
  const mkt = draft.scopeMarketplace && draft.scopeMarketplace !== 'all' ? draft.scopeMarketplace : null
  const scoped = mine.filter((c) => ruleMatchesScope(
    { scopeMarketplace: mkt, scopePortfolioId: null, scopeCampaignId: null, scopeProductIds: null },
    { marketplace: c.marketplace, campaignId: c.campaign.id, portfolioId: null },
  ))

  const blocks = translated.blocks?.length ? translated.blocks : [{ conditions: translated.conditions, actions: translated.actions }]

  const rows: BudgetPreviewRow[] = []
  let matched = 0
  let noChange = 0

  // Criteria first (pure, no I/O), so only genuine matches cost a handler call.
  const hits: Array<{ ctx: typeof scoped[number]; action: Record<string, unknown> }> = []
  for (const ctx of scoped) {
    // BP.P4b — first block whose conditions match THIS campaign acts, its action, not block 1's.
    const block = blocks.find((b) => evaluateConditions((b.conditions ?? null) as never, ctx as never))
    if (!block) continue
    matched++
    hits.push({ ctx, action: (block.actions?.[0] ?? {}) as Record<string, unknown> })
  }

  // …then the REAL handler, in dryRun, which reads the baseline anchor and applies the guardrails.
  const settled = await Promise.all(hits.map(async ({ ctx, action }) => {
    try {
      const res = await (ACTION_HANDLERS.budget_apply as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Record<string, unknown>; error?: string }>)(
        { ...action, campaignId: ctx.campaign.id },
        ctx,
        { dryRun: true, ruleId: PREVIEW_RULE_ID },
      )
      return { ctx, res }
    } catch (e) {
      logger.warn('[ADS-RULE-PREVIEW] budget_apply dryRun threw', { campaignId: ctx.campaign.id, error: String(e) })
      return { ctx, res: null }
    }
  }))

  for (const { ctx, res } of settled) {
    // `wouldChange` is the handler's own sentence: "€12.00 → €9.00". Parsing our own output back
    // is deliberate — it keeps ONE producer of the number, and the format is this file's contract
    // with the handler (asserted in ads-rule-preview.vitest.test.ts).
    const wc = String(res?.output?.wouldChange ?? '')
    const m = /^€([\d.]+)\s*→\s*€([\d.]+)$/.exec(wc)
    if (!res?.ok || !m) continue
    const currentEur = Number(m[1])
    const proposedEur = Number(m[2])
    const delta = Math.round((proposedEur - currentEur) * 100) / 100
    if (delta === 0) noChange++
    rows.push({
      campaignId: ctx.campaign.id,
      campaign: ctx.campaign.name,
      marketplace: ctx.marketplace,
      currentEur,
      proposedEur,
      deltaEur: delta,
      clamped: delta === 0,
      budgetUtilizationPct: ctx.campaign.budgetUtilization != null ? Math.round(ctx.campaign.budgetUtilization * 1000) / 10 : null,
      spendEur: Math.round(ctx.campaign.spendCents) / 100,
    })
  }

  rows.sort((a, b) => Math.abs(b.deltaEur) - Math.abs(a.deltaEur) || a.campaign.localeCompare(b.campaign))

  return {
    ok: true,
    windowDays,
    selected: picked.length,
    measurable: mine.length,
    inScope: scoped.length,
    matched,
    noChange,
    rows,
  }
}
