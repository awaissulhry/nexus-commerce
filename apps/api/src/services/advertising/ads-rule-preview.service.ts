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
 *
 * ── PLC-P2 (2026-08-22) — the SECOND consumer, and why the pipeline was extracted ─────────────
 *
 * The Placement builder's preview was the same browser arithmetic, with the same five defects,
 * measured live on prod before this change: a draft reading `IF Campaign ACOS > 9999%` listed
 * **70 of 70** campaigns as changing, and the same draft scoped to **Germany** still listed every
 * Italian and French campaign.
 *
 * Rather than copy `previewBudgetRule` and let two five-stage pipelines drift, the five stages are
 * now `runDraftPreview` and both rule types call it. The types differ ONLY in which handler runs
 * and how its `wouldChange` sentence is parsed — everything about context building, scope,
 * translation and first-matching-block selection is one implementation. That is the same rule the
 * preview itself exists to enforce: one producer of the number.
 *
 * 🔴 Placement carries an honesty problem Budget does not, and the result type carries the answer.
 * `placement_apply` reads the current multiplier from `Campaign.dynamicBidding.placementBidding`
 * at execution time, and for a campaign an `AdSchedule` governs, that field is a CLOCK READING —
 * `ad-rank-defend` rewrote placement lanes 7,818 times across 34 campaigns in seven days
 * (measured 2026-08-22). So every placement row states whether the rank engine governs it and
 * when that engine last touched that lane, and the result states the hour it was read. A
 * "current → proposed" row with neither is a number that will be false within the hour.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { ruleMatchesScope } from '../automation-rule-scope.js'
import { maybeTranslateAdsRule, builderBudgetCampaignIds, builderDraftCampaignIds } from './ads-rule-adapter.service.js'
import { PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT } from './ads-placement-math.js'

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

/**
 * ── The five stages, once ─────────────────────────────────────────────────────────────────────
 *
 * Real contexts → real scope → real translation → real conditions (first matching block) → the
 * real handler in `dryRun`. Everything a draft preview needs that is NOT specific to what is being
 * changed. `previewBudgetRule` and `previewPlacementRule` both run through here, so the two can
 * differ in how they READ the handler's answer and in nothing else.
 *
 * Returns the census plus one settled entry per campaign whose criteria matched — `res` is the
 * handler's own ActionResult, unparsed, because parsing is the caller's contract with ITS handler.
 */
interface DraftPreviewCensus {
  windowDays: number
  selected: number
  measurable: number
  inScope: number
  matched: number
}
interface DraftPreviewSettled<C> {
  ctx: C
  action: Record<string, unknown>
  res: { ok: boolean; output?: Record<string, unknown>; error?: string } | null
}
interface DraftPreviewRun<C> {
  ok: boolean
  error?: string
  untranslatable?: string[]
  census: DraftPreviewCensus
  settled: Array<DraftPreviewSettled<C>>
}

interface CampaignCtx {
  marketplace: string | null
  campaign: { id: string; name: string; [k: string]: unknown }
}

/**
 */
/**
 * SOV-P2 (2026-08-22) — EXPORTED, and given two optional hooks, additively.
 *
 * Budget and Placement both read campaign-grain contexts and write through `campaignId`. Share of
 * Voice and Keyword Tracker need the IDENTICAL five stages at the AD-TARGET grain, through
 * `bid_apply`, which wants `adTargetId`. That is the whole difference — two parameters, not a
 * second pipeline. A parallel implementation would drift from this one exactly the way the
 * client-side previews drifted from the engine ([[reference_preview_must_run_the_engine]]), which
 * is the defect this function exists to end.
 *
 * `buildContexts` and `entityId` both DEFAULT to the campaign behaviour, so the `previewBudgetRule`
 * and `previewPlacementRule` call sites below are byte-identical and cannot change meaning.
 */
export async function runDraftPreview<C extends CampaignCtx>(
  draft: BudgetPreviewDraft,
  opts: {
    slug: string
    handler: string
    defaultWindowDays: number
    /** Defaults to the campaign-budget contexts — the grain Budget and Placement both read. */
    buildContexts?: (windowDays: number) => Promise<unknown[]>
    /** The id key + value the handler is called with. Defaults to `campaignId` = the campaign's id. */
    entityId?: (ctx: C) => { key: string; value: string }
  },
): Promise<DraftPreviewRun<C>> {
  const blank = (windowDays: number): DraftPreviewRun<C> => ({
    ok: true, census: { windowDays, selected: 0, measurable: 0, inScope: 0, matched: 0 }, settled: [],
  })

  const a0 = Array.isArray(draft.actions) ? (draft.actions[0] as Record<string, unknown> | undefined) : undefined
  if (!a0 || String(a0.type ?? '') !== opts.slug) {
    return { ...blank(opts.defaultWindowDays), ok: false, error: `not_a_${opts.slug}_draft` }
  }

  // The rule's own lookback, clamped exactly as the adapter and the evaluator clamp it.
  const raw = typeof a0.windowDays === 'number' && Number.isFinite(a0.windowDays) ? a0.windowDays : opts.defaultWindowDays
  const windowDays = Math.max(7, Math.min(90, Math.round(raw)))

  const picked = builderDraftCampaignIds(draft.actions, opts.slug) ?? []
  if (picked.length === 0) return blank(windowDays)

  // ── the engine's own translation, so the conditions and the action are the real ones ──
  const translated = maybeTranslateAdsRule({ id: PREVIEW_RULE_ID, actions: draft.actions, conditions: draft.conditions })
  if (!translated) return { ...blank(windowDays), ok: false, error: 'untranslatable_draft' }
  if (translated.untranslatable?.length) {
    // A metric with no engine signal cannot be previewed OR run — say so rather than showing a
    // preview computed from the conditions that happened to map.
    return { ...blank(windowDays), ok: false, error: 'untranslatable_conditions', untranslatable: translated.untranslatable }
  }

  const { buildCampaignBudgetContexts } = await import('../../jobs/advertising-rule-evaluator.job.js')
  const { evaluateConditions } = await import('../automation/conditions-tree.js')
  const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
  await import('./automation-action-handlers.js') // registers budget_apply / placement_apply / bid_apply

  const contexts = (opts.buildContexts
    ? await opts.buildContexts(windowDays)
    : await buildCampaignBudgetContexts(windowDays)) as unknown as C[]
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

  // Criteria first (pure, no I/O), so only genuine matches cost a handler call.
  const hits: Array<{ ctx: C; action: Record<string, unknown> }> = []
  for (const ctx of scoped) {
    // BP.P4b — first block whose conditions match THIS campaign acts, its action, not block 1's.
    const block = blocks.find((b) => evaluateConditions((b.conditions ?? null) as never, ctx as never))
    if (!block) continue
    hits.push({ ctx, action: (block.actions?.[0] ?? {}) as Record<string, unknown> })
  }

  // …then the REAL handler, in dryRun, which reads the anchor and applies the guardrails.
  const handler = ACTION_HANDLERS[opts.handler] as
    ((a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Record<string, unknown>; error?: string }>) | undefined
  if (!handler) return { ...blank(windowDays), ok: false, error: `no_handler_${opts.handler}` }

  const settled = await Promise.all(hits.map(async ({ ctx, action }) => {
    try {
      const ent = opts.entityId ? opts.entityId(ctx) : { key: 'campaignId', value: ctx.campaign.id }
      const res = await handler({ ...action, [ent.key]: ent.value }, ctx, { dryRun: true, ruleId: PREVIEW_RULE_ID })
      return { ctx, action, res }
    } catch (e) {
      logger.warn('[ADS-RULE-PREVIEW] handler dryRun threw', { handler: opts.handler, entity: opts.entityId ? opts.entityId(ctx).value : ctx.campaign?.id, error: String(e) })
      return { ctx, action, res: null }
    }
  }))

  return {
    ok: true,
    census: { windowDays, selected: picked.length, measurable: mine.length, inScope: scoped.length, matched: hits.length },
    settled,
  }
}

export async function previewBudgetRule(draft: BudgetPreviewDraft): Promise<BudgetPreviewResult> {
  const empty = (extra: Partial<BudgetPreviewResult> = {}): BudgetPreviewResult => ({
    ok: true, windowDays: 7, selected: 0, measurable: 0, inScope: 0, matched: 0, noChange: 0, rows: [], ...extra,
  })

  interface BudgetCtx {
    marketplace: string | null
    campaign: { id: string; name: string; spendCents: number; budgetUtilization: number | null; [k: string]: unknown }
  }
  const run = await runDraftPreview<BudgetCtx>(draft, { slug: 'budget', handler: 'budget_apply', defaultWindowDays: 7 })
  const c = run.census
  if (!run.ok) {
    return {
      ...empty({ windowDays: c.windowDays }),
      ok: false,
      // `not_a_budget_draft` is preserved verbatim: it is this function's documented refusal and
      // its own test asserts the string.
      error: run.error === 'not_a_budget_draft' ? 'not_a_budget_draft' : run.error,
      ...(run.untranslatable ? { untranslatable: run.untranslatable } : {}),
    }
  }

  const rows: BudgetPreviewRow[] = []
  let noChange = 0

  for (const { ctx, res } of run.settled) {
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
    windowDays: c.windowDays,
    selected: c.selected,
    measurable: c.measurable,
    inScope: c.inScope,
    matched: c.matched,
    noChange,
    rows,
  }
}

/**
 * ── PLC-P2 — the honest Placement preview ─────────────────────────────────────────────────────
 *
 * Same five stages, `placement_apply` in `dryRun`. Its dryRun branch already returns
 * `wouldChange: "30% → 50%"` and writes nothing, so — exactly as with Budget — **nothing here
 * computes a multiplier**.
 *
 * What Budget does not need, and this does:
 *
 * 🔴 **the hour**, and **who else writes this lane**. `placement_apply` reads the current
 * multiplier from `Campaign.dynamicBidding.placementBidding`. On the reachable campaigns an
 * `AdSchedule` governs, that field is a clock reading: `ad-rank-defend` pins each lane to whatever
 * `RankTarget` the hour resolves to and zeroes it when the target is `pause`. Measured 2026-08-22,
 * it made 7,818 lane writes across 34 campaigns in seven days against 6 human ones in thirty.
 *
 * So a bare "30% → 50%" row is true at the instant it is drawn and can be false an hour later —
 * not because the preview is wrong about the RULE, but because it is quoting a number somebody
 * else owns. Every row therefore carries `governed` and `lastEngineWriteAt`, and the result
 * carries `readAt`. The modal states all three. See
 * [[reference_placement_multiplier_is_hour_dependent]].
 */
const PLACEMENT_LABEL: Record<string, string> = {
  [PLACEMENT_TOP]: 'Top of Search',
  [PLACEMENT_REST]: 'Rest of Search',
  [PLACEMENT_PRODUCT]: 'Product Pages',
}

export interface PlacementPreviewRow {
  campaignId: string
  campaign: string
  marketplace: string | null
  /** Amazon's lane enum — carried so a caller can key on it; never rendered raw. */
  placement: string
  /** What the operator called it in the builder. The lane IS the rule's identity on this tab. */
  placementLabel: string
  currentPct: number
  proposedPct: number
  deltaPct: number
  /** True when floor/ceiling absorbed the whole move — an honest "this does nothing". */
  clamped: boolean
  /** 🔴 An enabled AdSchedule governs this campaign: `currentPct` is a reading, not a setting. */
  governed: boolean
  /** When an automation last rewrote THIS lane on THIS campaign (7-day look-back), else null. */
  lastEngineWriteAt: string | null
}

export interface PlacementPreviewResult {
  ok: boolean
  error?: string
  windowDays: number
  selected: number
  measurable: number
  inScope: number
  matched: number
  noChange: number
  /** Of the matched, how many the rank engine governs. The headline caveat, as a number. */
  governedMatched: number
  /** 🔴 When the current multipliers were read. A multiplier is a time-of-day fact. */
  readAt: string
  rows: PlacementPreviewRow[]
  untranslatable?: string[]
}

export async function previewPlacementRule(draft: BudgetPreviewDraft): Promise<PlacementPreviewResult> {
  const readAt = new Date().toISOString()
  const empty = (extra: Partial<PlacementPreviewResult> = {}): PlacementPreviewResult => ({
    ok: true, windowDays: 7, selected: 0, measurable: 0, inScope: 0, matched: 0, noChange: 0,
    governedMatched: 0, readAt, rows: [], ...extra,
  })

  interface PlacementCtx {
    marketplace: string | null
    campaign: { id: string; name: string; [k: string]: unknown }
  }
  const run = await runDraftPreview<PlacementCtx>(draft, { slug: 'placement', handler: 'placement_apply', defaultWindowDays: 7 })
  const c = run.census
  if (!run.ok) {
    return {
      ...empty({ windowDays: c.windowDays }),
      ok: false,
      error: run.error,
      ...(run.untranslatable ? { untranslatable: run.untranslatable } : {}),
    }
  }

  // ── parse the handler's own sentence; it is the ONLY source of the numbers ──
  interface Parsed { ctx: PlacementCtx; placement: string; currentPct: number; proposedPct: number }
  const parsed: Parsed[] = []
  for (const { ctx, action, res } of run.settled) {
    const wc = String(res?.output?.wouldChange ?? '')
    const m = /^([\d.]+)%\s*→\s*([\d.]+)%$/.exec(wc)
    if (!res?.ok || !m) continue
    // The lane comes from the handler's OWN output where it reported one — the block that matched
    // decides it, and on a multi-block rule that is not necessarily block 1's lane.
    const placement = String(res.output?.placement ?? action.placement ?? PLACEMENT_TOP)
    parsed.push({ ctx, placement, currentPct: Number(m[1]), proposedPct: Number(m[2]) })
  }

  // ── who else writes these lanes ──
  //
  // Both reads are scoped to the campaigns that actually matched, so a preview of one campaign
  // does not scan the account. `governed` is the PLAN (an enabled AdSchedule exists);
  // `lastEngineWriteAt` is the OBSERVATION (the ledger). Stating both is the point: a schedule
  // that has never fired and an engine that rewrote the lane an hour ago are different warnings.
  const ids = [...new Set(parsed.map((p) => p.ctx.campaign.id))]
  const [schedules, engineWrites] = ids.length
    ? await Promise.all([
      prisma.adSchedule.findMany({ where: { enabled: true, campaignId: { in: ids } }, select: { campaignId: true } }),
      prisma.campaignBidHistory.findMany({
        where: {
          campaignId: { in: ids },
          field: { startsWith: 'PLACEMENT' },
          changedBy: { startsWith: 'automation:' },
          changedAt: { gte: new Date(Date.now() - 7 * 864e5) },
        },
        select: { campaignId: true, field: true, changedAt: true },
        orderBy: { changedAt: 'desc' },
      }),
    ])
    : [[], []]
  const governedIds = new Set(schedules.map((s) => s.campaignId))
  // Rows arrive newest-first, so the FIRST sighting of a (campaign, lane) pair is the latest one.
  const lastWrite = new Map<string, Date>()
  for (const w of engineWrites) {
    const k = `${w.campaignId}|${w.field}`
    if (!lastWrite.has(k)) lastWrite.set(k, w.changedAt)
  }

  let noChange = 0
  const rows: PlacementPreviewRow[] = parsed.map((p) => {
    const delta = Math.round((p.proposedPct - p.currentPct) * 10) / 10
    if (delta === 0) noChange++
    const last = lastWrite.get(`${p.ctx.campaign.id}|${p.placement}`)
    return {
      campaignId: p.ctx.campaign.id,
      campaign: p.ctx.campaign.name,
      marketplace: p.ctx.marketplace,
      placement: p.placement,
      // Never the enum: `PLACEMENT_REST_OF_SEARCH` on screen is the raw-enum cell this programme
      // has fixed three times. Unknown lanes fall back to the enum rather than to a wrong label.
      placementLabel: PLACEMENT_LABEL[p.placement] ?? p.placement,
      currentPct: p.currentPct,
      proposedPct: p.proposedPct,
      deltaPct: delta,
      clamped: delta === 0,
      governed: governedIds.has(p.ctx.campaign.id),
      lastEngineWriteAt: last ? last.toISOString() : null,
    }
  })

  rows.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct) || a.campaign.localeCompare(b.campaign))

  return {
    ok: true,
    windowDays: c.windowDays,
    selected: c.selected,
    measurable: c.measurable,
    inScope: c.inScope,
    matched: c.matched,
    noChange,
    governedMatched: rows.filter((r) => r.governed).length,
    readAt,
    rows,
  }
}
