/**
 * R4 (MCP full control, part 06) — the ads rule board: every advertising rule with its level, ceiling, reach, caps and
 * what it did in the last 7 days; and each rule's activity (pending proposals, last write, writes in 7 days).
 *
 * Moved unchanged out of `routes/advertising.routes.ts` (GET /advertising/autonomy/rules and
 * GET /advertising/automation-rules/activity) so Claude's automation tools read the same facts the board shows. The
 * routes answer byte for byte as before (automation-routes-parity.vitest.test.ts).
 */
import { isLegacyRule } from '@nexus/shared/ads-rule-legacy'
import prisma from '../../db.js'

/** GET /advertising/autonomy/rules — the rule board. */
export async function listAdsRuleBoard() {
  const [rules, protectionCount] = await Promise.all([
    prisma.automationRule.findMany({
      where: { domain: 'advertising' },
      select: {
        id: true, name: true, trigger: true, enabled: true, dryRun: true, autonomyLevel: true,
        // EA7 — execution order. Lower runs first; ties fall back to createdAt.
        priority: true,
        actions: true, maxExecutionsPerDay: true, maxValueCentsEur: true, maxWritesPerDay: true,
        maxDailyAdSpendCentsEur: true, scopeMarketplace: true,
        scopePortfolioId: true, scopeCampaignId: true,
        evaluationCount: true, matchCount: true, executionCount: true,
        lastEvaluatedAt: true, lastMatchedAt: true, lastExecutedAt: true, createdAt: true,
        // RA.AUTO — the rule list has to render plain-English When / If / Then, and this was
        // the one board that could not: it returned neither. Consumers that do not read them
        // are unaffected; every field below is additive.
        description: true, conditions: true,
        // RA.GRAIN — the fourth grain.
        scopeProductId: true,
      },
      orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
    }),
    prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } }),
  ])

  const weekAgo = new Date(Date.now() - 7 * 86_400_000)
  // DAILY_CAP_EXCEEDED rows are the ENGINE declining to run a rule, not the rule failing.
  // They were also written by the self-ratcheting cap bug fixed on 2026-08-04, which left
  // 109,551 of them in the last week alone — enough to show a healthy rule as "5,093 failed"
  // and make every row on this board look broken. The cap counter already excludes them;
  // the trust signal must exclude them for the same reason, or the board argues against
  // rules on the strength of a defect they had no part in.
  const recent = await prisma.automationRuleExecution.groupBy({
    by: ['ruleId', 'status'],
    where: {
      startedAt: { gte: weekAgo },
      ruleId: { in: rules.map((r) => r.id) },
      // Must spell out the null branch. `NOT: { errorMessage: 'X' }` becomes
      // NOT (errorMessage = 'X'), which is NULL — not TRUE — for a null errorMessage, so
      // three-valued logic drops the row. Every SUCCESS and DRY_RUN has a null
      // errorMessage, so the terse form silently zeroed `acted` and `proposed` for every
      // rule on the board while correctly removing the cap rows.
      OR: [
        { errorMessage: null },
        { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } },
      ],
    },
    _count: { _all: true },
  })
  const weekBy = new Map<string, Record<string, number>>()
  for (const g of recent) {
    const m = weekBy.get(g.ruleId) ?? {}
    m[g.status] = g._count._all
    weekBy.set(g.ruleId, m)
  }

  /**
   * RA.AUTO — the cap rows, counted SEPARATELY rather than merged back in.
   *
   * Excluding them from `failed` (above) is right: the engine declining to run a rule is not
   * the rule failing. But dropping them entirely hid the thing that actually governs this
   * account. Measured on prod 2026-08-10: "Profit-native bid optimisation" wrote 3,793 times
   * in 30 days and was refused 19,423 times by its own daily cap — so the cap, not the rule,
   * is what decides how much of the account it reaches. A health strip that shows only the
   * writes describes the wrong bottleneck, and an operator raising a threshold to get more
   * coverage would be turning the one knob that cannot deliver it.
   */
  const cappedRows = await prisma.automationRuleExecution.groupBy({
    by: ['ruleId'],
    where: { startedAt: { gte: weekAgo }, ruleId: { in: rules.map((r) => r.id) }, errorMessage: 'DAILY_CAP_EXCEEDED' },
    _count: { _all: true },
  })
  const cappedBy = new Map(cappedRows.map((g) => [g.ruleId, g._count._all]))

  const { resolveAutonomy } = await import('./ads-autonomy.js')
  const { graduationCeiling } = await import('./ads-graduation.js')
  const { ruleCategory, RULE_CATEGORY_META } = await import('./rule-category.js')

  // ACR.7 — resolve scope ids to names once, so every consumer shows "portfolio: Xavia GALE IT"
  // rather than an opaque id.
  const scopedPortfolioIds = [...new Set(rules.map((r) => r.scopePortfolioId).filter((x): x is string => !!x))]
  const scopedCampaignIds = [...new Set(rules.map((r) => r.scopeCampaignId).filter((x): x is string => !!x))]
  const [scopedPortfolios, scopedCampaigns] = await Promise.all([
    scopedPortfolioIds.length
      ? prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: scopedPortfolioIds } }, select: { externalPortfolioId: true, name: true } })
      : Promise.resolve([]),
    scopedCampaignIds.length
      ? prisma.campaign.findMany({ where: { id: { in: scopedCampaignIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ])
  const portfolioName = new Map(scopedPortfolios.map((p) => [p.externalPortfolioId, p.name]))
  const campaignName = new Map(scopedCampaigns.map((c) => [c.id, c.name]))

  /**
   * RA.GRAIN — resolve product scope to a NAME, and say whether it is a line or one variation.
   *
   * "scopeProductId: cmsn…" tells an operator nothing; "GALE-JACKET — the whole line, 18
   * variations" tells them what the rule can touch. Resolved here rather than in the client so
   * every consumer of this board agrees, the same reason portfolio and campaign names are.
   */
  const scopedProductIds = [...new Set(rules.map((r) => r.scopeProductId).filter((x): x is string => !!x))]
  const scopedProducts = scopedProductIds.length
    ? await prisma.product.findMany({ where: { id: { in: scopedProductIds } }, select: { id: true, sku: true, name: true, parentId: true } })
    : []
  const childCounts = scopedProductIds.length
    ? await prisma.product.groupBy({ by: ['parentId'], where: { parentId: { in: scopedProductIds } }, _count: { _all: true } })
    : []
  const childCountByParent = new Map(childCounts.map((c) => [c.parentId as string, c._count._all]))
  const productById = new Map(scopedProducts.map((p) => [p.id, p]))

  /**
   * ADVERTISED children, not catalogue children — the count that explains the reach beside it.
   *
   * IT-MOSS-JACKET has 30 children in the PIM and 21 that any campaign advertises. Reporting 30
   * here while the scope form's reach line said "21 advertised variations" was two numbers for
   * one thing, which is the third time this shape of defect has appeared in this programme
   * (targetAcos units, then 40-vs-18 in the reach label). Only the advertised count is
   * actionable: the other 9 cannot be reached by any binding.
   */
  const advertisedChildren = scopedProductIds.length
    ? await prisma.adProductAd.findMany({
      where: { product: { parentId: { in: scopedProductIds } } },
      select: { productId: true, product: { select: { parentId: true } } },
    })
    : []
  const advertisedByParent = new Map<string, Set<string>>()
  for (const a of advertisedChildren) {
    const parent = a.product?.parentId
    if (!parent || !a.productId) continue
    const s = advertisedByParent.get(parent) ?? new Set<string>()
    s.add(a.productId); advertisedByParent.set(parent, s)
  }

  /**
   * RA.AUTO — actions that never reach Amazon. Same set as `rule-category.ts`'s
   * NON_WRITING_ACTIONS, and it is the difference between "9 rules are on AUTO" and "8 rules
   * can change your account". Measured on prod: "Alert: ACOS spike" is AUTO and its only
   * action is `alert_operator`, so a census band counting AUTO rules overstated the rules
   * able to write by one. `actionTypes` below already strips these for display, which is why
   * the flag has to be computed before that filter rather than from it.
   */
  const NON_WRITING = new Set(['notify', 'alert_operator', 'log_only'])

  /**
   * EA6 — reach: how many campaigns each rule's scope currently admits.
   *
   * Computed with the evaluator's own `ruleMatchesScope`, never a parallel query, so the number
   * on the row cannot disagree with what the engine does on the next tick. One campaign load for
   * the whole list. Measured 2026-08-19: 43 of 51 rules are unscoped and therefore read 220.
   */
  const { reachForRules } = await import('./ads-rule-reach.service.js')
  const reach = await reachForRules(rules)
  // BP.P1 — the ceiling is op-aware (see the PATCH route below): the toggle pre-disable this
  // list feeds must agree with what that route will actually refuse.
  const { producedActionTypes } = await import('./ads-rule-adapter.service.js')

  const items = rules.map((r) => {
    const actionTypes = (Array.isArray(r.actions) ? r.actions : [])
      .map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)
    const ceiling = graduationCeiling({ actionTypes: producedActionTypes(r), hasKeywordProtections: protectionCount > 0 })
    const week = weekBy.get(r.id) ?? {}
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      conditions: r.conditions,
      /**
       * RA.AUTO — the RAW actions, parameters and all.
       *
       * `actionTypes` below is filtered (it drops notify/alert_operator) and carries no
       * parameters, so it cannot answer "what would this rule do". Rendering a Then-line from
       * it alone made the Automations drawer print "no actions — this rule does nothing" over
       * a rule carrying `bid_to_target_acos` and a WRITES badge. A surface stating the opposite
       * of the truth about whether a rule touches the account is the exact defect this
       * programme exists to remove.
       */
      actions: r.actions,
      /** Whether ANY of this rule's actions reaches Amazon. AUTO on a notify-only rule writes nothing. */
      writes: actionTypes.some((t) => !NON_WRITING.has(t)),
      /**
       * EA6 — blast radius. `{ campaigns, enabledCampaigns, total }`. A `campaigns` of 0 is a
       * DEAD rule: armed, and its scope resolves to nothing. `campaigns === total` is the whole
       * account, which is what 43 of these rules are whether or not anyone realised.
       */
      reach: reach.get(r.id) ?? null,
      /** EA7 — where this rule sits in the run order. Lower goes first; 100 is the default. */
      priority: r.priority,
      trigger: r.trigger,
      marketplace: r.scopeMarketplace,
      level: resolveAutonomy(r),
      ceiling: ceiling.maxLevel,
      ceilingReason: ceiling.reason,
      blockedBy: ceiling.blockedBy,
      actionTypes: actionTypes.filter((t) => !['notify', 'alert_operator', 'log_only'].includes(t)),
      // ACR.7 — colour carries the grouping now that emojis are gone from names.
      category: ruleCategory(actionTypes),
      categoryColor: RULE_CATEGORY_META[ruleCategory(actionTypes)].color,
      categoryLabel: RULE_CATEGORY_META[ruleCategory(actionTypes)].label,
      // `kind`/`id`/`name` are unchanged — the AutomationDock and the Control Room's Levers view
      // both read them, so RA.GRAIN adds `product` beside them rather than restructuring.
      scope: {
        ...(r.scopeCampaignId
          ? { kind: 'campaign' as const, id: r.scopeCampaignId, name: campaignName.get(r.scopeCampaignId) ?? r.scopeCampaignId }
          : r.scopePortfolioId
            ? { kind: 'portfolio' as const, id: r.scopePortfolioId, name: portfolioName.get(r.scopePortfolioId) ?? r.scopePortfolioId }
            : { kind: 'account' as const, id: null, name: null }),
        product: r.scopeProductId
          ? {
            id: r.scopeProductId,
            sku: productById.get(r.scopeProductId)?.sku ?? null,
            name: productById.get(r.scopeProductId)?.name ?? null,
            /** A parent is the whole line; a child is one variation. */
            isLine: (childCountByParent.get(r.scopeProductId) ?? 0) > 0,
            /** Variations any campaign actually advertises — the number that explains the reach. */
            variations: advertisedByParent.get(r.scopeProductId)?.size ?? 0,
            /** Every variation in the catalogue, so "21 of 30" is stateable rather than implied. */
            variationsInCatalogue: childCountByParent.get(r.scopeProductId) ?? 0,
            /** True when the id no longer resolves — the reach line then reads 0, honestly. */
            missing: !productById.has(r.scopeProductId),
          }
          : null,
      },
      caps: {
        perDay: r.maxExecutionsPerDay,
        perExecutionCents: r.maxValueCentsEur,
        perDayCents: r.maxDailyAdSpendCentsEur,
        // AUTO.A2 (additive) — the demote-to-dry-run write cap (CAP step 6, armed 2026-08-14).
        writesPerDay: r.maxWritesPerDay,
      },
      // The accountability strip: what it has actually done, not what it might do.
      week: {
        acted: (week.SUCCESS ?? 0) + (week.PARTIAL ?? 0),
        proposed: week.DRY_RUN ?? 0,
        failed: week.FAILED ?? 0,
        /** The engine declining to run it. Never merged into `failed` — see cappedBy above. */
        capped: cappedBy.get(r.id) ?? 0,
      },
      lifetime: { evaluations: r.evaluationCount, matches: r.matchCount, executions: r.executionCount },
      lastEvaluatedAt: r.lastEvaluatedAt,
      lastMatchedAt: r.lastMatchedAt,
      lastExecutedAt: r.lastExecutedAt,
      ageDays: Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000),
      /** W1 — provenance. Predates the 2026-08-20 cutover ⇒ machine-created, not by the
       *  operator. A label only: nothing in evaluation, caps or autonomy reads it. */
      createdAt: r.createdAt,
      legacy: isLegacyRule(r),
    }
  })
  return { items, protectedTerms: protectionCount }
}

/** One rule's activity on the board (B4). */
export interface AdsRuleActivity { pending: number; lastWroteAt: string | null; writes7d: number }

/**
 * B4 (2026-08-20) — WHAT EACH RULE HAS ACTUALLY DONE.
 *
 * The Automation toggle is a fork in the road: Off (PROPOSE) queues an `AdsRuleSuggestion` for a
 * human; On (AUTO) writes to Amazon and drops a receipt in the change log. Both halves worked
 * and neither was visible — a rule with 125 proposals nobody has read renders identically to one
 * with none, and a rule that has never moved a bid renders identically to one that moves them
 * hourly.
 *
 * Three facts per rule, each from the table that actually records that half:
 *   · `pending`     — AdsRuleSuggestion rows awaiting a decision. The PROPOSE half's output.
 *   · `lastWroteAt` — the newest AdvertisingActionLog row written by this rule's own actor.
 *   · `writes7d`    — how many it wrote in the last 7 days, so "wrote once in June" and "writes
 *                     every hour" are different rows rather than the same green tick.
 *
 * 🔴 `lastWroteAt` is deliberately NOT `AutomationRule.lastExecutedAt`. Those are different
 * facts and conflating them is this section's most expensive recurring mistake: `lastExecutedAt`
 * moves every time the rule is EVALUATED, whatever came of it. Measured on prod today, 4 of the
 * 18 Bid rules are enabled at AUTO with `lastExecutedAt` inside the last hour and have **never
 * written a single row** — they run, they succeed, they do nothing
 * ([[reference_four_inert_ads_rules]]). An action log row is the only proof a bid moved.
 *
 * The actor convention is `automation:<ruleId>` (`RULE_ACTOR`, automation-action-handlers.ts),
 * and every rule write reaches it: `bulkUpdateAdTargetBids` delegates per entry to
 * `updateAdTargetWithSync`, which calls `writeAdvertisingActionLog` with the actor. A write that
 * returns `no_changes` logs nothing, which is correct — it was not a write.
 *
 * ⚠ Most `automation:` actors in that table are NOT rules: 54 of 56 are `automation:rank-defend-*`,
 * the rank-defend cron, which has its own actor space. Match on the exact `automation:<ruleId>`
 * string, never on the prefix, or the page inherits another job's activity.
 *
 * Three indexed groupBys; measured on prod at 122ms / 103ms / 201ms against 59,810 log rows.
 */
export async function adsRuleActivity(): Promise<{ items: Record<string, AdsRuleActivity> }> {
  const since = new Date(Date.now() - 7 * 86_400_000)
  const [pending, wrote, recent] = await Promise.all([
    prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { status: 'pending' }, _count: true }),
    prisma.advertisingActionLog.groupBy({
      by: ['userId'], where: { userId: { startsWith: 'automation:' } }, _max: { createdAt: true },
    }),
    prisma.advertisingActionLog.groupBy({
      by: ['userId'], where: { userId: { startsWith: 'automation:' }, createdAt: { gte: since } }, _count: true,
    }),
  ])
  const ruleIds = new Set(
    (await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true } })).map((r) => r.id),
  )
  const items: Record<string, AdsRuleActivity> = {}
  const ensure = (id: string) => (items[id] ??= { pending: 0, lastWroteAt: null, writes7d: 0 })
  for (const p of pending) if (p.ruleId) ensure(p.ruleId).pending = p._count
  // Exact id match — see the rank-defend warning above.
  for (const w of wrote) {
    const id = String(w.userId ?? '').slice('automation:'.length)
    if (ruleIds.has(id) && w._max.createdAt) ensure(id).lastWroteAt = w._max.createdAt.toISOString()
  }
  for (const w of recent) {
    const id = String(w.userId ?? '').slice('automation:'.length)
    if (ruleIds.has(id)) ensure(id).writes7d = w._count
  }
  return { items }
}
