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
import { HIGH_ACOS_FLOOR } from '@nexus/shared/ads-rule-window'
import { logger } from '../../utils/logger.js'
import { ruleMatchesScope } from '../automation-rule-scope.js'
import { maybeTranslateAdsRule, builderBudgetCampaignIds, builderDraftCampaignIds } from './ads-rule-adapter.service.js'
import { PLACEMENT_TOP, PLACEMENT_REST, PLACEMENT_PRODUCT } from './ads-placement-math.js'
// KT-P2 — the ≤3¢ suppression convention has ONE declaration, in the KT.6 blast radius that
// already refuses on it. Restating the number here would let the preview and the guarded write
// path disagree about what "suppressed" means.
import { KT6_SUPPRESSION_CENTS as KT_SUPPRESSION_CENTS } from './kt6-bid-action.js'

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
/**
 * ── KT-P2 (2026-08-22) — the Keyword Tracker preview, and why it is the third consumer ─────────
 *
 * The Keyword Tracker builder's Preview was browser arithmetic with the same defects Budget and
 * Placement had, plus two of its own. Measured on prod before this change, with a draft reading
 * `IF Organic Rank > 50 THEN Set Bid to €0.80` over 70 campaigns, it rendered **100 rows, every one
 * with a green €0.80** — against a true match count of **zero**:
 *
 *   1. **criteria ignored** — it fetched targets and clamped all of them, filtering only by campaign;
 *   2. 🔴 **90 of the 100 rows were entity kinds this rule can never touch** — measured live:
 *      KEYWORD 10 · PRODUCT 65 · AUTO 15 · the rest audiences and categories. The context selects
 *      `kind: 'KEYWORD', isNegative: false`, so auto-targeting expressions and ASIN product targets
 *      are not candidates at all;
 *   3. 🔴 **deliberately suppressed targets were shown being RAISED**, with no warning and no count.
 *      Four €0.02 rows sat in the first screenful. Account-wide, 561 of the 1,004 positive keyword
 *      targets in write-enabled campaigns are suppressed and 141 of those carry no flag;
 *   4. **the feed was silently truncated** — `/advertising/targets?limit=1500` returns 1,500 of
 *      5,218 rows and reports `count` as the page size, so nothing downstream could detect it;
 *   5. 🔴 **the rank columns printed "—" on every row while the bid column stayed confident.** The
 *      rank feed is EMPTY (`KeywordRank`, 0 rows), so the honest answer was always "nothing".
 *
 * This runs the engine instead, through the same five stages as Budget and Placement — the only
 * differences are the ones `runDraftPreview` already takes as parameters: the context builder
 * (`buildKeywordRankBidContexts`, the rule's own producer) and `adTargetId` in place of `campaignId`.
 *
 * Two things it reports that the others do not, because they are this tab's honesty problem:
 *
 * · **`feed`** — the state of `KeywordRank` itself. When a rank rule matches nothing, "no keyword
 *   met your criteria" and "no rank has ever been ingested" are completely different facts, and
 *   only the second one is true today. The surface must be able to tell them apart.
 * · **`suppressedMatched` / `suppressedUnflaggedMatched`** — `bid_apply` carries no suppression
 *   guard and its floor is `max(0.05, minEur)`, so it CANNOT write ≤3¢: every op on a suppressed
 *   target un-suppresses it. The preview's job is to report what would really happen, so these are
 *   counted and surfaced rather than quietly filtered out — filtering would make the preview
 *   disagree with the engine, which is the defect this file exists to prevent. Refusing them is
 *   KT-P6's decision, in the handler, where the engine would honour it too.
 */
export interface KeywordTrackerPreviewRow {
  targetId: string
  /** the keyword text, as Amazon holds it */
  keyword: string
  campaignId: string
  marketplace: string | null
  /** null = never observed. NEVER 0 — a rank of 0 does not exist. */
  organicRank: number | null
  sponsoredRank: number | null
  rankDelta: number | null
  currentEur: number
  proposedEur: number
  /** 'flag' = carries `suppressedFromBidCents`; 'bid' = at or under 3¢ with no flag. */
  suppressed: 'flag' | 'bid' | null
  /** the campaign is bid-suppressed right now, so the next resume would overwrite this write */
  campaignSuppressed: boolean
  /** KT-P6 — the handler REFUSED this one, in its own words. A refusal is a row, not an omission. */
  refused?: string
}

export interface KeywordTrackerPreviewResult {
  ok: boolean
  error?: string
  untranslatable?: string[]
  windowDays: number
  selected: number
  measurable: number
  inScope: number
  matched: number
  noChange: number
  rows: KeywordTrackerPreviewRow[]
  suppressedMatched: number
  suppressedUnflaggedMatched: number
  campaignSuppressedMatched: number
  /** KT-P6 — of the matched, how many the engine REFUSED because they are switched off. */
  refusedSuppressed: number
  /** 🔴 The rank feed itself — the difference between "nothing matched" and "nothing was measured". */
  feed: {
    rows: number
    keywords: number
    markets: number
    newestCapturedAt: string | null
    /** positive keyword targets whose text+market appears in the feed at all */
    coveredTargets: number
    totalTargets: number
  }
  readAt: string
}

/** The rank feed's own census. Exported because the builder's banner states it before any draft exists. */
export async function keywordRankFeedHealth(): Promise<KeywordTrackerPreviewResult['feed']> {
  const [rows, totalTargets] = await Promise.all([
    prisma.keywordRank.count(),
    prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false } }),
  ])
  if (rows === 0) {
    return { rows: 0, keywords: 0, markets: 0, newestCapturedAt: null, coveredTargets: 0, totalTargets }
  }
  const [agg, distinct, covered] = await Promise.all([
    prisma.keywordRank.aggregate({ _max: { capturedAt: true } }),
    prisma.$queryRawUnsafe<Array<{ keywords: number; markets: number }>>(
      `SELECT count(DISTINCT lower(trim("keyword")))::int AS keywords, count(DISTINCT "marketplace")::int AS markets FROM "KeywordRank"`,
    ),
    prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n
         FROM "AdTarget" t
         JOIN "AdGroup" g ON g.id = t."adGroupId"
         JOIN "Campaign" c ON c.id = g."campaignId"
        WHERE t.kind = 'KEYWORD' AND t."isNegative" = false AND t."expressionValue" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "KeywordRank" k
                       WHERE lower(trim(k."keyword")) = lower(trim(t."expressionValue"))
                         AND k."marketplace" = c."marketplace")`,
    ),
  ])
  return {
    rows,
    keywords: distinct[0]?.keywords ?? 0,
    markets: distinct[0]?.markets ?? 0,
    newestCapturedAt: agg._max.capturedAt ? agg._max.capturedAt.toISOString() : null,
    coveredTargets: covered[0]?.n ?? 0,
    totalTargets,
  }
}

export async function previewKeywordTrackerRule(draft: BudgetPreviewDraft): Promise<KeywordTrackerPreviewResult> {
  const readAt = new Date().toISOString()
  const feed = await keywordRankFeedHealth()
  const empty = (extra: Partial<KeywordTrackerPreviewResult> = {}): KeywordTrackerPreviewResult => ({
    ok: true, windowDays: 30, selected: 0, measurable: 0, inScope: 0, matched: 0, noChange: 0,
    rows: [], suppressedMatched: 0, suppressedUnflaggedMatched: 0, campaignSuppressedMatched: 0, refusedSuppressed: 0,
    feed, readAt, ...extra,
  })

  interface RankCtx {
    marketplace: string | null
    campaign: { id: string; name: string; [k: string]: unknown }
    adTarget: { id: string; organicRank?: number; sponsoredRank?: number; rankDelta?: number; [k: string]: unknown }
  }

  const { buildKeywordRankBidContexts } = await import('../../jobs/advertising-rule-evaluator.job.js')
  const run = await runDraftPreview<RankCtx>(draft, {
    slug: 'keyword-tracker',
    handler: 'bid_apply',
    // KEYWORD_RANK_BID is a `snapshot` trigger: rank is the latest reading and the perf metrics
    // beside it cover 30 settled days. The builder offers no lookback, so this is not a choice.
    defaultWindowDays: 30,
    buildContexts: () => buildKeywordRankBidContexts() as unknown as Promise<unknown[]>,
    entityId: (ctx) => ({ key: 'adTargetId', value: ctx.adTarget.id }),
  })

  const c = run.census
  if (!run.ok) {
    return {
      ...empty({ windowDays: c.windowDays }),
      ok: false,
      error: run.error,
      ...(run.untranslatable ? { untranslatable: run.untranslatable } : {}),
    }
  }

  // ── the handler's own sentence is the only source of the numbers ──
  /**
   * 🔴 KT-P6 — a REFUSAL is a row, not an omission.
   *
   * Since KT-P6 `bid_apply` skips a deliberately suppressed target instead of raising it, and the
   * skip happens BEFORE the `dryRun` return — so it lands here as `output.skipped` with no
   * `wouldChange`. Dropping those would make the preview quietly list fewer keywords than matched
   * and never say why, which is the omission this whole path exists to remove. They are surfaced
   * as rows carrying their reason, exactly as the SOV preview surfaces its own refusals.
   */
  interface Parsed { ctx: RankCtx; currentCents: number; proposedCents: number; refused?: string }
  const parsed: Parsed[] = []
  const refusedIds = new Map<string, string>()
  let noChange = 0
  const SKIP_REASON: Record<string, string> = {
    suppressed_flag: 'deliberately suppressed — this rule will not switch delivery back on',
    suppressed_by_bid: 'bids at or under 3¢, this account’s suppression convention — left alone',
    campaign_suppressed: 'its campaign’s bids are suppressed right now — a write here would be undone',
  }
  /**
   * 🔴 The invariant this loop keeps: **every matched context leaves as exactly one row or one
   * `noChange`.** Nothing is dropped.
   *
   * Four shapes reach here and the first version handled two, so two vanished silently:
   *   · `output.wouldChange` — the change
   *   · `output.skipped`     — the suppression guard's refusal (KT-P6)
   *   · `ok: false`          — a COMPUTED op naming the signal it lacked (KT-P6b, found by SOV-P)
   *   · `res === null`       — the handler threw; `runDraftPreview` logs it and hands back null
   *
   * `BID_ACTIONS` is shared and `isBidLike` includes rank, so a rank rule can select `setCpc` /
   * `targetAcos` / `revPerClick` / `curBidTargetAcos`, each of which refuses with `ok: false` and a
   * sentence. Measured over 14 settled days: 237 of 259 clicked targets have spend and no
   * attributed sales, so on a ratio op a refusal is the MAJORITY outcome — the panel would have
   * listed a handful of rows out of hundreds and never said where the rest went.
   */
  for (const { ctx, res } of run.settled) {
    if (!res) {
      refusedIds.set(String(ctx.adTarget.id), 'the bid action could not be evaluated for this target')
      continue
    }
    if (res.ok === false) {
      // The real bid is folded in below, where the decoration query has it — never a defaulted 0,
      // because a €0.00 Current cell is the fabricated reading this panel exists to remove.
      refusedIds.set(String(ctx.adTarget.id), res.error ?? 'the bid action refused this target')
      continue
    }
    if (res.output?.noChange) { noChange += 1; continue }
    const skipped = String(res.output?.skipped ?? '')
    if (skipped) {
      // `campaign-not-selected` is not a refusal the operator needs to see — they chose the list.
      if (SKIP_REASON[skipped]) {
        parsed.push({ ctx, currentCents: Number(res.output?.bidCents ?? 0), proposedCents: Number(res.output?.bidCents ?? 0), refused: SKIP_REASON[skipped] })
      }
      continue
    }
    const m = /^(-?\d+)¢\s*→\s*(-?\d+)¢$/.exec(String(res.output?.wouldChange ?? ''))
    if (!m) continue
    parsed.push({ ctx, currentCents: Number(m[1]), proposedCents: Number(m[2]) })
  }

  // ── who among the matched is deliberately switched off ──
  //
  // Both tests, counted separately, exactly as `kt6-bid-action.ts` counts them: the flag is
  // evidence and ≤3¢ is the house convention, and merging them hides the 141 targets the flag does
  // not know about ([[reference_ads_suppression_by_low_bid]]).
  const ids = [...new Set([...parsed.map((p) => p.ctx.adTarget.id), ...refusedIds.keys()])]
  const [targets, suppressedCampaigns] = ids.length
    ? await Promise.all([
      prisma.adTarget.findMany({
        where: { id: { in: ids } },
        select: { id: true, expressionValue: true, suppressedFromBidCents: true, bidCents: true },
      }),
      prisma.campaign.findMany({
        where: { id: { in: [...new Set(parsed.map((p) => p.ctx.campaign.id))] }, bidsSuppressedAt: { not: null } },
        select: { id: true },
      }),
    ])
    : [[], []]
  const byId = new Map(targets.map((t) => [t.id, t]))
  // The refusals join the rows here, where each one's REAL current bid is known.
  for (const { ctx } of run.settled) {
    const reason = refusedIds.get(String(ctx.adTarget.id))
    if (!reason) continue
    const cents = byId.get(String(ctx.adTarget.id))?.bidCents ?? 0
    parsed.push({ ctx, currentCents: cents, proposedCents: cents, refused: reason })
  }
  const suppressedCampaignIds = new Set(suppressedCampaigns.map((x) => x.id))

  const rows: KeywordTrackerPreviewRow[] = parsed.map((p) => {
    const t = byId.get(p.ctx.adTarget.id)
    const suppressed: 'flag' | 'bid' | null = t?.suppressedFromBidCents != null
      ? 'flag'
      : p.currentCents <= KT_SUPPRESSION_CENTS ? 'bid' : null
    const num = (v: unknown) => (typeof v === 'number' ? v : null)
    return {
      targetId: p.ctx.adTarget.id,
      keyword: t?.expressionValue ?? '',
      campaignId: p.ctx.campaign.id,
      marketplace: p.ctx.marketplace,
      // absent in the context means never observed — rendered as "—", never as 0
      organicRank: num(p.ctx.adTarget.organicRank),
      sponsoredRank: num(p.ctx.adTarget.sponsoredRank),
      rankDelta: num(p.ctx.adTarget.rankDelta),
      currentEur: p.currentCents / 100,
      proposedEur: p.proposedCents / 100,
      suppressed,
      campaignSuppressed: suppressedCampaignIds.has(p.ctx.campaign.id),
      ...(p.refused ? { refused: p.refused } : {}),
    }
  })

  rows.sort((a, b) => Math.abs(b.proposedEur - b.currentEur) - Math.abs(a.proposedEur - a.currentEur)
    || a.keyword.localeCompare(b.keyword))

  return {
    ok: true,
    windowDays: c.windowDays,
    selected: c.selected,
    measurable: c.measurable,
    inScope: c.inScope,
    matched: c.matched,
    noChange,
    rows,
    refusedSuppressed: rows.filter((r) => r.refused != null).length,
    suppressedMatched: rows.filter((r) => r.suppressed !== null).length,
    suppressedUnflaggedMatched: rows.filter((r) => r.suppressed === 'bid').length,
    campaignSuppressedMatched: rows.filter((r) => r.campaignSuppressed).length,
    feed,
    readAt,
  }
}

/**
 * ── BID-P (2026-08-22) — the LAST client-side preview, and the one that mattered most ─────────
 *
 * The Bid builder's Preview was browser arithmetic: fetch `/advertising/targets?limit=1500`, keep
 * the rows whose `campaignId` is in the picker, apply `groups[0]`'s THEN op to each current bid,
 * clamp, render. Measured on prod before this change, and it was wrong in five ways at once — the
 * four Budget's own header lists, plus one that is Bid's alone and worse than the rest:
 *
 *  1. 🔴 **six of the eleven THEN actions rendered "no change" on EVERY row.** `apply()` handles
 *     `set` / `incPct` / `decPct` / `incAbs` / `decAbs` and falls through to `: cur` for the four
 *     COMPUTED actions BP.P4 shipped as headline features (`setCpc`, `targetAcos`, `revPerClick`,
 *     `curBidTargetAcos`) and for the two status verbs, which do not move a bid at all — so a
 *     "New Bid" column was the wrong display for them entirely. An operator building
 *     `Set Bid to CPC × (Target ACoS / Actual ACoS)` saw a tidy table of unchanged bids and
 *     concluded their thresholds were too tight;
 *  2. **the trigger's floor was invisible.** `KEYWORD_HIGH_ACOS` emits only keywords with orders,
 *     sales, ≥€2 spend and ≥20% ACoS (`HIGH_ACOS_FLOOR`) — **8 of the account's 3,155 positive ad
 *     targets** clear it. The panel listed up to 1,500;
 *  3. **kind ignored** — 1,025 of 3,155 are kinds no keyword-bid rule can select;
 *  4. **criteria and multi-block ignored** — every listed target appeared to match, on `groups[0]`;
 *  5. **an arbitrary population** — `limit=1500`, no `orderBy`, filtered client-side.
 *
 * 🔴 **Refusals are ROWS here, both kinds.** `bid_apply` refuses two different ways and a preview
 * that drops either lists fewer keywords than it matched and never says why:
 *   · `ok: false` with a named error — the computed ops, when the signal is missing. Measured over
 *     14 settled days, 237 of 259 clicked targets have spend and no attributed sales, so the ratio
 *     ops refuse on them by name. Dropping those would hide the majority of what the rule does.
 *   · `ok: true` with `output.skipped` — KT-P6's suppression guard, which returns before `dryRun`.
 * `campaign-not-selected` stays silent: the operator chose that list.
 */
export interface BidPreviewRow {
  targetId: string
  keyword: string
  matchType: string | null
  campaign: string
  marketplace: string | null
  /** The numbers that made the row match — a bid pair with the deciding metric off-screen is uncheckable. */
  acosPct: number | null
  spendEur: number
  currentEur: number
  proposedEur: number
  clamped: boolean
  /** The handler's own sentence when it refused — never paraphrased. */
  refused?: string
  suppressed: 'flag' | 'bid' | null
  campaignSuppressed: boolean
}

export interface BidPreviewResult {
  ok: boolean
  error?: string
  /** The rule's OWN lookback (`actions[0].windowDays`, clamped 7–90), not the trigger's default. */
  windowDays: number
  selected: number
  /** Every positive target in the picked campaigns, including kinds a bid rule can never select. */
  selectedTargets: number
  /** Of the picked campaigns, how many targets cleared the trigger's floor and became contexts. */
  measurable: number
  inScope: number
  matched: number
  noChange: number
  /** Matched targets the handler REFUSED for a missing signal (the computed ops), by name. */
  refusedNoSignal: number
  suppressedMatched: number
  suppressedUnflaggedMatched: number
  campaignSuppressedMatched: number
  /** The bar a keyword must clear before ANY bid rule can see it — read from the emitter's own constant. */
  floor: { minOrders: number; minSpendEur: number; minAcosPct: number; topPerTick: number }
  rows: BidPreviewRow[]
  untranslatable?: string[]
}

export async function previewBidRule(draft: BudgetPreviewDraft): Promise<BidPreviewResult> {
  const floor = {
    minOrders: HIGH_ACOS_FLOOR.minOrders,
    minSpendEur: HIGH_ACOS_FLOOR.minSpendCents / 100,
    minAcosPct: HIGH_ACOS_FLOOR.minAcos * 100,
    topPerTick: HIGH_ACOS_FLOOR.topPerTick,
  }
  const empty = (extra: Partial<BidPreviewResult> = {}): BidPreviewResult => ({
    ok: true, windowDays: 14, selected: 0, selectedTargets: 0, measurable: 0, inScope: 0,
    matched: 0, noChange: 0, refusedNoSignal: 0,
    suppressedMatched: 0, suppressedUnflaggedMatched: 0, campaignSuppressedMatched: 0,
    floor, rows: [], ...extra,
  })

  const a0 = Array.isArray(draft.actions) ? (draft.actions[0] as Record<string, unknown> | undefined) : undefined
  const picked = Array.isArray(a0?.campaigns)
    ? (a0!.campaigns as Array<{ id?: unknown }>).map((c) => String(c?.id ?? '')).filter(Boolean)
    : []
  if (!picked.length) return empty()

  // Straight from the DB: a context that was never built cannot count itself, and "never offered"
  // must not read as "considered and rejected".
  const selectedTargets = await prisma.adTarget.count({
    where: { isNegative: false, adGroup: { campaignId: { in: picked } } },
  })

  interface BidCtx {
    marketplace: string | null
    campaign: { id: string; name: string; [k: string]: unknown }
    adTarget: { id: string; acos?: number | null; spendCents?: number; [k: string]: unknown }
  }

  const { buildHighAcosKeywordContexts } = await import('../../jobs/advertising-rule-evaluator.job.js')
  const run = await runDraftPreview<BidCtx>(draft, {
    slug: 'bid',
    handler: 'bid_apply',
    // BP.P4 — a Bid rule chooses its own lookback; `runDraftPreview` reads it off the action and
    // clamps it exactly as the emitter and `targetPerformance` do, then hands it here.
    defaultWindowDays: 14,
    buildContexts: (windowDays) => buildHighAcosKeywordContexts(windowDays) as unknown as Promise<unknown[]>,
    entityId: (ctx) => ({ key: 'adTargetId', value: ctx.adTarget.id }),
  })

  const c = run.census
  if (!run.ok) {
    return { ...empty({ windowDays: c.windowDays, selected: picked.length, selectedTargets }), ok: false, error: run.error, ...(run.untranslatable ? { untranslatable: run.untranslatable } : {}) }
  }

  const SKIP_REASON: Record<string, string> = {
    suppressed_flag: 'left alone — deliberately suppressed, and the bid action will not switch delivery back on',
    suppressed_by_bid: 'left alone — bids at or under 3¢, this account’s suppression convention',
    campaign_suppressed: 'left alone — this campaign’s bids are suppressed, so a write here would be undone',
  }

  interface Parsed { ctx: BidCtx; currentCents: number; proposedCents: number; refused?: string; noSignal?: boolean }
  const parsed: Parsed[] = []
  let noChange = 0
  for (const { ctx, res } of run.settled) {
    const out = res?.output ?? {}
    // A named refusal from a computed op. `output.adTargetId` is present but no bid pair is, so the
    // current bid comes from the context rather than from a sentence the handler did not write.
    if (res && res.ok === false) {
      parsed.push({ ctx, currentCents: 0, proposedCents: 0, refused: res.error ?? 'refused', noSignal: true })
      continue
    }
    if (out.noChange) { noChange += 1; continue }
    const skipped = String(out.skipped ?? '')
    if (skipped) {
      if (SKIP_REASON[skipped]) parsed.push({ ctx, currentCents: Number(out.bidCents ?? 0), proposedCents: Number(out.bidCents ?? 0), refused: SKIP_REASON[skipped] })
      continue
    }
    const m = /^(-?\d+)¢\s*→\s*(-?\d+)¢$/.exec(String(out.wouldChange ?? ''))
    if (!m) continue
    parsed.push({ ctx, currentCents: Number(m[1]), proposedCents: Number(m[2]) })
  }

  const ids = [...new Set(parsed.map((p) => p.ctx.adTarget.id))]
  const [targets, suppressedCampaigns] = ids.length
    ? await Promise.all([
      prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, expressionValue: true, expressionType: true, bidCents: true, suppressedFromBidCents: true } }),
      prisma.campaign.findMany({ where: { id: { in: [...new Set(parsed.map((p) => p.ctx.campaign.id))] }, bidsSuppressedAt: { not: null } }, select: { id: true } }),
    ])
    : [[], []]
  const byId = new Map(targets.map((t) => [t.id, t]))
  const suppressedCampaignIds = new Set(suppressedCampaigns.map((x) => x.id))

  const rows: BidPreviewRow[] = parsed.map((p) => {
    const t = byId.get(p.ctx.adTarget.id)
    const cur = p.noSignal ? (t?.bidCents ?? 0) : p.currentCents
    return {
      targetId: p.ctx.adTarget.id,
      /**
       * KEYWORD_HIGH_ACOS selects on AD_TARGET performance and does NOT filter by kind, so an auto
       * or product target with spend is emitted too and `bid_apply` really can move its bid. Those
       * carry no keyword text, and rendering them blank would hide rows the rule genuinely acts on
       * — label them by what they are instead (the old client-side preview's one good idea).
       */
      keyword: (t?.expressionValue ?? '').trim() || (t?.expressionType ? String(t.expressionType) : t?.kind ? `${String(t.kind)} target` : 'Target'),
      matchType: t?.expressionType ?? null,
      campaign: p.ctx.campaign.name,
      marketplace: p.ctx.marketplace,
      acosPct: typeof p.ctx.adTarget.acos === 'number' ? p.ctx.adTarget.acos * 100 : null,
      spendEur: (p.ctx.adTarget.spendCents ?? 0) / 100,
      currentEur: cur / 100,
      proposedEur: p.refused ? cur / 100 : p.proposedCents / 100,
      clamped: !p.refused && p.currentCents === p.proposedCents,
      ...(p.refused ? { refused: p.refused } : {}),
      suppressed: t?.suppressedFromBidCents != null ? 'flag' : cur <= KT_SUPPRESSION_CENTS ? 'bid' : null,
      campaignSuppressed: suppressedCampaignIds.has(p.ctx.campaign.id),
    }
  })
  rows.sort((a, b) => Math.abs(b.proposedEur - b.currentEur) - Math.abs(a.proposedEur - a.currentEur)
    || a.keyword.localeCompare(b.keyword))

  return {
    ok: true,
    windowDays: c.windowDays,
    selected: picked.length,
    selectedTargets,
    measurable: c.measurable,
    inScope: c.inScope,
    matched: c.matched,
    noChange,
    refusedNoSignal: parsed.filter((p) => p.noSignal).length,
    suppressedMatched: rows.filter((r) => r.suppressed !== null).length,
    suppressedUnflaggedMatched: rows.filter((r) => r.suppressed === 'bid').length,
    campaignSuppressedMatched: rows.filter((r) => r.campaignSuppressed).length,
    floor,
    rows,
  }
}
