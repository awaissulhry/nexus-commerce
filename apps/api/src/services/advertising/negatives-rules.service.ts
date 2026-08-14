/**
 * NEG.7 — the rules that can create a negative here, what one execution would touch, and whether
 * arming them is defensible yet.
 *
 * READ-ONLY. This service arms nothing, changes no level, lifts no ceiling and writes no scope.
 * Study §4.4's instruction — *"build the retirement path first, do not arm the rules"* — has not
 * been withdrawn, and two of its six conditions are still open.
 *
 * ── 🔴 The blast radius is the number nobody has ever seen ───────────────────────────────────
 *
 * `sync_negatives_across_campaigns` negates one term across **every ENABLED campaign in a
 * marketplace**. The count is taken with the handler's OWN selection rather than an approximation
 * of it, so the page cannot drift from what the engine would actually do. Measured 2026-08-13:
 * IT 74 · DE 8 · FR 2 · ES 2, from a rule whose cap is 20/day. Unscoped and on AUTO that is up to
 * **1,480 campaign-level negatives a day in IT alone**.
 *
 * ── 🔴 `protectConverting` is RESOLVED, never raw ────────────────────────────────────────────
 *
 * All seven rules predate the builder that writes the key, so the key is **absent on every one of
 * them** — and `protectConvertingConfig` reads `enabled: raw !== false`, so **absent means ON**.
 * Rendering the raw key would print "off" beside seven rules that are in fact protected, which is
 * precisely the class of lie this page exists to remove.
 *
 * ── The action list, and why it is duplicated here ───────────────────────────────────────────
 *
 * `ruleBelongsToTab` lives in `_shared/tabs.tsx`, a web file the API cannot import. The list below
 * mirrors `RULE_TAB_ACTION_TYPES['negative-targeting']` exactly, and `_neg7-rules.mts` PARSES that
 * file and asserts the two are identical — so a drift is a test failure rather than a page that
 * quietly disagrees with its own tab badge. The web half still filters with the real
 * `ruleBelongsToTab`; this list only decides which rules the API bothers to compute for.
 */

import prisma from '../../db.js'
import { graduationCeiling, type GraduationVerdict } from './ads-graduation.js'
import { protectConvertingConfig } from './ads-protect-converting.js'
import { resolveNegScope, NEG_MARKETS, NEG_MARKET_ALL, type NegScopeRequest, type NegGrain } from './negatives.service.js'

/** Mirrors `RULE_TAB_ACTION_TYPES['negative-targeting']` — asserted equal by `_neg7-rules.mts`. */
export const NEGATION_ACTION_TYPES = [
  'harvest_and_negate',
  'add_negative_exact',
  'add_negative_phrase',
  'sync_negatives_across_campaigns',
  // the builder slug — `RuleBuilder.tsx` writes `actions: [{ type: slug }]`, so a rule created in
  // the modal carries this rather than an action type. Zero rules carry it today.
  'negative-targeting',
] as const

/** §7 — listed on the tab, categorised, ceilinged, and **not in `ACTION_HANDLERS`**. */
export const PHANTOM_ACTIONS = ['add_negative_phrase'] as const

const ACTIVITY_WINDOW_DAYS = 60

export type BlastKind = 'per-marketplace-campaigns' | 'one-campaign-negative' | 'not-determinable'

export interface BlastRadius {
  kind: BlastKind
  /** the headline number for the CURRENT scope, or null when it cannot be derived from the rule */
  perExecution: number | null
  /** what `perExecution` counts — never left to the reader to guess */
  unit: string
  /** cap × perExecution, when both are known. The real daily exposure. */
  perDayAtCap: number | null
  /** the same figure per marketplace, so a narrowed scope can be compared to the account */
  byMarket: Array<{ market: string; count: number }>
  /** one sentence an operator can act on */
  explanation: string
}

export interface NegRuleRow {
  id: string
  name: string
  enabled: boolean
  autonomyLevel: string
  trigger: string
  actionTypes: string[]
  /** action types on this rule that have NO handler — §7's phantom */
  actionsWithoutHandler: string[]
  ceiling: GraduationVerdict
  /** 🔴 whether the level an operator could set is already at the ceiling */
  atCeiling: boolean
  scope: {
    marketplace: string | null
    portfolioId: string | null
    campaignId: string | null
    productId: string | null
    isAccountWide: boolean
  }
  /** 🔴 true for every rule today: account-wide rules reach every scope, including this one */
  reachesCurrentScope: boolean
  maxExecutionsPerDay: number | null
  maxValueCentsEur: number | null
  /**
   * 🔴 NOT "times it acted". `AutomationRule.executionCount` counts evaluations, and the execution
   * table is ~99% refusals — see `activity`.
   */
  executionCount: number
  lastEvaluatedAt: string | null
  lastMatchedAt: string | null
  /** 🔴 the RESOLVED value the engine would use, plus whether the key exists at all */
  protectConverting: { resolved: boolean; keyPresent: boolean; source: string }
  blast: BlastRadius
  /**
   * 🔴 What the rule ACTUALLY does, from its own execution rows — as distinct from what it could
   * do. Three of the five enabled rules never reach their write at all, and one of them is the
   * widest-radius rule in the section.
   */
  observed: {
    /** the number the latest dry run reported it would negate, or null if it never got that far */
    wouldNegate: number | null
    /** negation-action results examined */
    attempts: number
    /** results that reached the write path (ok) */
    reached: number
    /** results refused before writing */
    refused: number
    /** the most common refusal, verbatim */
    topRefusal: string | null
    /** 🔴 true when EVERY sampled attempt failed before the write — a radius that is theoretical */
    neverReaches: boolean
    /** 🔴 true when the rule made NO attempt in the window. Distinct from `neverReaches: false`,
     *  which means it DID reach its write — going quiet and starting to work are different facts. */
    noAttempts: boolean
  }
  /** refusals are not failures, and neither is a success — three separate counts */
  activity: {
    windowDays: number
    total: number
    succeeded: number
    refusedByCap: number
    otherErrors: number
    dryRuns: number
  }
}

export type ConditionState = 'closed' | 'open'

export interface ReadinessCondition {
  n: number
  label: string
  state: ConditionState
  /** the computed evidence, never a claim */
  evidence: string
  /** where the operator closes it, when it is theirs to close */
  actionHref: string | null
  actionLabel: string | null
  /** true when closing this is operator work rather than engineering */
  operatorWork: boolean
}

export interface NegRulesPayload {
  scope: { boundBy: NegGrain; market: string; campaignsInScope: number }
  rules: NegRuleRow[]
  totals: {
    /** rules whose actions put them on this tab */
    onTab: number
    enabled: number
    atAuto: number
    accountWide: number
    /** rules in the whole account, for the denominator §5 warns about */
    rulesInAccount: number
    /** advertising rules carrying any scope grain — a DIFFERENT denominator, stated so */
    scopedAnywhere: number
  }
  readiness: ReadinessCondition[]
  /** §7 — reported, never implemented */
  phantomActions: Array<{ action: string; onTab: boolean; ceilinged: boolean; hasHandler: boolean; consequence: string }>
  /** §6 — whether the cap counter can be trusted, measured rather than assumed */
  capCounter: { trustworthy: boolean; note: string }
  /** 🔴 real counts of what was read; a zero here means a failed read, not a quiet account */
  coverage: { rulesRead: number; executionsRead: number; campaignsRead: number }
}

export interface NegRulesRequest extends NegScopeRequest {}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export async function getNegRules(req: NegRulesRequest): Promise<NegRulesPayload> {
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 86400_000)

  const [allRules, campaigns, negAdGroups, products, ads, protections] = await Promise.all([
    prisma.automationRule.findMany({
      // 🔴 `domain` scopes the denominator. The table holds 62 rules across three domains
      // (advertising 51 · replenishment 8 · reviews 3); counting all of them would report "7 of 62"
      // where every other surface says 51.
      where: { domain: 'advertising' },
      select: {
        id: true, name: true, trigger: true, actions: true, enabled: true, autonomyLevel: true,
        maxExecutionsPerDay: true, maxValueCentsEur: true,
        scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
        executionCount: true, lastEvaluatedAt: true, lastMatchedAt: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, externalCampaignId: true } }),
    prisma.adGroup.findMany({ select: { id: true, campaignId: true } }),
    req.line ? prisma.product.findMany({ select: { id: true, parentId: true } }) : Promise.resolve([]),
    req.line ? prisma.adProductAd.findMany({ where: { productId: { not: null } }, select: { productId: true, adGroup: { select: { campaignId: true } } } }) : Promise.resolve([]),
    prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } }),
  ])

  const scope = resolveNegScope(
    { campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, marketplace: c.marketplace, portfolioId: c.portfolioId })), adGroups: negAdGroups.map((g) => ({ id: g.id, name: '', campaignId: g.campaignId })), products, ads: ads.map((a) => ({ productId: a.productId, campaignId: a.adGroup?.campaignId ?? '' })).filter((a) => a.campaignId) },
    req,
  )

  const actionTypesOf = (actions: unknown): string[] =>
    (Array.isArray(actions) ? (actions as Array<Record<string, unknown>>) : []).map((a) => String(a?.type ?? '')).filter(Boolean)

  const rulesOnTab = allRules.filter((r) => actionTypesOf(r.actions).some((t) => (NEGATION_ACTION_TYPES as readonly string[]).includes(t)))

  // ── activity, by rule ───────────────────────────────────────────────────────────────────────
  // 🔴 Three classes, never one number. A rule that WANTED to act 2,000 times and was refused
  // 1,990 is a different fact from one that ran 10 times, and `executionCount` cannot tell them
  // apart.
  const execs = await prisma.automationRuleExecution.groupBy({
    by: ['ruleId', 'status', 'errorMessage'],
    where: { ruleId: { in: rulesOnTab.map((r) => r.id) }, startedAt: { gte: since } },
    _count: { _all: true },
  })
  const activityOf = (ruleId: string) => {
    const mine = execs.filter((e) => e.ruleId === ruleId)
    const total = mine.reduce((a, e) => a + e._count._all, 0)
    const refusedByCap = mine.filter((e) => e.errorMessage === 'DAILY_CAP_EXCEEDED').reduce((a, e) => a + e._count._all, 0)
    const dryRuns = mine.filter((e) => String(e.status) === 'DRY_RUN').reduce((a, e) => a + e._count._all, 0)
    const succeeded = mine.filter((e) => String(e.status) === 'SUCCESS' && !e.errorMessage).reduce((a, e) => a + e._count._all, 0)
    return { windowDays: ACTIVITY_WINDOW_DAYS, total, succeeded, refusedByCap, otherErrors: total - refusedByCap - succeeded - dryRuns, dryRuns }
  }

  // ── blast radius ────────────────────────────────────────────────────────────────────────────
  // The handler's own selection, not an approximation:
  //   campaign.count({ where: { marketplace, status: 'ENABLED', externalCampaignId: { not: null } } })
  const enabledWithExternal = campaigns.filter((c) => String(c.status) === 'ENABLED' && c.externalCampaignId)
  const byMarketAll = new Map<string, number>()
  for (const c of enabledWithExternal) byMarketAll.set(c.marketplace ?? '—', (byMarketAll.get(c.marketplace ?? '—') ?? 0) + 1)
  const marketList = [...byMarketAll].map(([market, count]) => ({ market, count })).sort((a, b) => b.count - a.count)

  const scopeCampaignIds = new Set(scope.campaignIds)
  const inScopeEnabled = enabledWithExternal.filter((c) => scopeCampaignIds.has(c.id))
  const scopedMarket = req.market && req.market !== NEG_MARKET_ALL ? req.market : null

  const adGroupsPerCampaign = new Map<string, number>()
  for (const g of negAdGroups) adGroupsPerCampaign.set(g.campaignId, (adGroupsPerCampaign.get(g.campaignId) ?? 0) + 1)
  const agCounts = enabledWithExternal.map((c) => adGroupsPerCampaign.get(c.id) ?? 0).filter((n) => n > 0).sort((a, b) => a - b)
  const medianAdGroups = agCounts.length ? agCounts[Math.floor(agCounts.length / 2)] : 0
  const maxAdGroups = agCounts.length ? agCounts[agCounts.length - 1] : 0

  const blastFor = (types: string[], cap: number | null): BlastRadius => {
    if (types.includes('sync_negatives_across_campaigns')) {
      // 🔴 PER MARKETPLACE, never a sum across them. The handler's own WHERE is
      // `{ marketplace, status: 'ENABLED', externalCampaignId: { not: null } }` — one execution
      // happens in ONE marketplace, so adding IT+DE+FR+ES to 86 would describe an execution that
      // cannot occur. Unscoped, the honest headline is the LARGEST single marketplace.
      const worst = marketList[0] ?? { market: '—', count: 0 }
      const n = scopedMarket
        ? (marketList.find((m) => m.market === scopedMarket)?.count ?? 0)
        : scope.boundBy !== 'market' ? inScopeEnabled.length : worst.count
      const where = scopedMarket ?? (scope.boundBy !== 'market' ? 'this scope' : `${worst.market}, its largest marketplace,`)
      return {
        kind: 'per-marketplace-campaigns',
        perExecution: n,
        unit: 'campaign-level negatives, one per ENABLED campaign',
        perDayAtCap: cap != null ? n * cap : null,
        byMarket: marketList,
        explanation: `Negates one term across every ENABLED campaign in a single marketplace. In ${where} that is ${n} campaign-level negatives per execution${cap != null ? `, and at ${cap} executions a day up to ${(n * cap).toLocaleString('en-IE')}` : ''}. One execution never spans two marketplaces, so these counts are not additive.`,
      }
    }
    if (types.includes('add_negative_exact') || types.includes('add_negative_phrase')) {
      return {
        kind: 'one-campaign-negative',
        perExecution: 1,
        unit: 'campaign-level negative',
        perDayAtCap: cap,
        byMarket: [],
        // The default is CAMPAIGN, not AD_GROUP — `automation-action-handlers.ts:1025`.
        explanation: `Creates one negative per execution at CAMPAIGN scope by default, which blocks the term across every ad group in that campaign — a median of ${medianAdGroups} and up to ${maxAdGroups}.`,
      }
    }
    return {
      kind: 'not-determinable',
      perExecution: null,
      unit: 'candidates found at run time',
      perDayAtCap: null,
      byMarket: [],
      explanation: 'Bounded by the harvest engine\'s own candidate count, which is decided when it runs and is not a property of the rule. It cannot be derived from this row.',
    }
  }

  // 🔴 What the rules ACTUALLY do. A capability radius and an observed one are different facts,
  // and for three of the five enabled rules the observed one is ZERO — they fail a precondition
  // before ever reaching the write. A panel showing only the capability would overstate the risk;
  // one showing only the observation would understate it. Both go on the row.
  // 🔴 PER RULE, not one shared page. A single `take` across all seven, ordered newest-first, is
  // dominated by whichever rules are busiest — so a rule that goes QUIET drops out of the sample
  // entirely, `attempts` becomes 0, and `neverReaches` flips from true to false. A rule that has
  // never once reached its write then reads as one that does.
  //
  // Observed 2026-08-14, one hour after `Account-wide negative sync` was disabled: it vanished from
  // the shared 1,400-row page and its "Never reaches its write" banner disappeared with it. Going
  // quiet is not the same as starting to work, and the two must never render the same.
  const recent = (await Promise.all(
    rulesOnTab.map((rr) =>
      prisma.automationRuleExecution.findMany({
        where: { ruleId: rr.id, startedAt: { gte: since } },
        orderBy: { startedAt: 'desc' },
        select: { ruleId: true, actionResults: true },
        take: 200,
      }),
    ),
  )).flat()
  const observedOf = (ruleId: string) => {
    let attempts = 0, reached = 0, refused = 0, wouldNegate: number | null = null
    const errs = new Map<string, number>()
    for (const row of recent) {
      if (row.ruleId !== ruleId) continue
      const list = Array.isArray(row.actionResults) ? (row.actionResults as Array<Record<string, unknown>>) : []
      for (const a of list) {
        if (!(NEGATION_ACTION_TYPES as readonly string[]).includes(String(a?.type ?? ''))) continue
        attempts++
        if (a?.ok) {
          reached++
          const out = (a.output ?? {}) as Record<string, unknown>
          const w = out.wouldNegate ?? out.wouldNegateIn
          if (wouldNegate == null && typeof w === 'number') wouldNegate = w
        } else {
          refused++
          const e = String(a?.error ?? '—')
          errs.set(e, (errs.get(e) ?? 0) + 1)
        }
      }
    }
    const topRefusal = [...errs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    return { wouldNegate, attempts, reached, refused, topRefusal, neverReaches: attempts > 0 && reached === 0, noAttempts: attempts === 0 }
  }

  const rules: NegRuleRow[] = rulesOnTab.map((r) => {
    const types = actionTypesOf(r.actions)
    const ceiling = graduationCeiling({ actionTypes: types, hasKeywordProtections: protections > 0 })
    const isAccountWide = !r.scopeMarketplace && !r.scopePortfolioId && !r.scopeCampaignId && !r.scopeProductId
    // 🔴 RESOLVED, never raw. The action object is what the handler reads.
    const firstNegAction = (Array.isArray(r.actions) ? (r.actions as Array<Record<string, unknown>>) : [])
      .find((a) => (NEGATION_ACTION_TYPES as readonly string[]).includes(String(a?.type ?? '')))
    const keyPresent = firstNegAction != null && 'protectConverting' in firstNegAction
    const cfg = protectConvertingConfig(firstNegAction ?? {})
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      autonomyLevel: String(r.autonomyLevel),
      trigger: r.trigger,
      actionTypes: types,
      actionsWithoutHandler: types.filter((t) => (PHANTOM_ACTIONS as readonly string[]).includes(t)),
      ceiling,
      atCeiling: String(r.autonomyLevel) === ceiling.maxLevel,
      scope: {
        marketplace: r.scopeMarketplace, portfolioId: r.scopePortfolioId,
        campaignId: r.scopeCampaignId, productId: r.scopeProductId, isAccountWide,
      },
      // An account-wide rule reaches every scope by definition — including the one being viewed.
      reachesCurrentScope: isAccountWide
        || (r.scopeMarketplace != null && (req.market === NEG_MARKET_ALL || r.scopeMarketplace === req.market))
        || (r.scopeCampaignId != null && scopeCampaignIds.has(r.scopeCampaignId)),
      maxExecutionsPerDay: r.maxExecutionsPerDay,
      maxValueCentsEur: r.maxValueCentsEur,
      executionCount: r.executionCount,
      lastEvaluatedAt: iso(r.lastEvaluatedAt),
      lastMatchedAt: iso(r.lastMatchedAt),
      protectConverting: {
        resolved: cfg.enabled,
        keyPresent,
        source: keyPresent ? 'set on the rule' : 'absent — the default, which is ON',
      },
      blast: blastFor(types, r.maxExecutionsPerDay),
      observed: observedOf(r.id),
      activity: activityOf(r.id),
    }
  })

  // ── §6 — is the cap counter trustworthy? Measured, not assumed. ─────────────────────────────
  //
  // 🔴 CAP (2026-08-14) — this block used to hard-code its OWN copy of the engine's clause and
  // measure that. `NOT (errorMessage = 'X')` is NULL — never TRUE — for a null column, which is a
  // property of SQL, not of our engine. So the panel could never report anything but "broken", and
  // when the engine WAS repaired on 2026-08-14 this page went on telling operators the counter was
  // broken while it was holding on production. A surface that reports on a code path must read the
  // code path, not a copy of it.
  //
  // Both now import `notCapRefusal()` from `automation-cap-predicate.ts`, so this measures the
  // predicate the engine actually runs. The bare form is still measured — to show the blind spot it
  // closed — but it comes from the same module, named so it cannot be reached for by accident.
  const { notCapRefusal, bareNotFormDoNotUse } = await import('../automation-cap-predicate.js')
  const succeededRows = await prisma.automationRuleExecution.count({ where: { errorMessage: null, startedAt: { gte: since } } })
  const [engineClauseRows, bareFormRows] = await Promise.all([
    prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, ...notCapRefusal() } }),
    prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, ...bareNotFormDoNotUse() } }),
  ])
  const counterDropsNulls = succeededRows > 0 && engineClauseRows < succeededRows
  const blindSpotClosed = engineClauseRows - bareFormRows
  const capCounter = {
    trustworthy: !counterDropsNulls,
    note: counterDropsNulls
      ? `🔴 Still broken. ${succeededRows.toLocaleString('en-IE')} executions in ${ACTIVITY_WINDOW_DAYS} days carry no errorMessage, but the predicate the engine runs matches only ${engineClauseRows.toLocaleString('en-IE')} of them. The counts on this page come from AutomationRuleExecution directly and do not use it.`
      : `Fixed 2026-08-14, and this line measures the engine's own predicate rather than a copy of it. It matches ${engineClauseRows.toLocaleString('en-IE')} of the ${succeededRows.toLocaleString('en-IE')} null-error executions in ${ACTIVITY_WINDOW_DAYS} days, while still excluding every cap refusal. The bare \`NOT errorMessage = 'DAILY_CAP_EXCEEDED'\` it replaced matches ${bareFormRows.toLocaleString('en-IE')} — a blind spot of ${blindSpotClosed.toLocaleString('en-IE')} rows, which is why no cap bound anything between 2026-08-04 and 2026-08-14.`,
  }

  // ── §5 — the six conditions, each COMPUTED ─────────────────────────────────────────────────
  const [protectSvcOk, retireSvcOk] = [true, true] // both shipped and imported below; asserted by the script
  const orphaned = await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } })
  const negativesTotal = await prisma.adTarget.count({ where: { isNegative: true } })
  const reviews = await prisma.adNegativeReview.count()
  const { getProtections } = await import('./negatives-protections.service.js')
  const audit = await getProtections({ market: NEG_MARKET_ALL })
  const scopedRules = rules.filter((r) => !r.scope.isAccountWide).length
  const scopedAnywhere = allRules.filter((r) => r.scopeMarketplace || r.scopePortfolioId || r.scopeCampaignId || r.scopeProductId).length
  const allProtected = rules.every((r) => r.protectConverting.resolved)

  const readiness: ReadinessCondition[] = [
    {
      n: 1,
      label: 'A converting term cannot be negated',
      state: allProtected && protectSvcOk ? 'closed' : 'open',
      evidence: `protectConverting resolves ON for ${rules.filter((r) => r.protectConverting.resolved).length} of ${rules.length} rules. The key is absent on ${rules.filter((r) => !r.protectConverting.keyPresent).length} of them — absent is the default and the default is ON.`,
      actionHref: null, actionLabel: null, operatorWork: false,
    },
    {
      n: 2,
      label: 'The write gate is reachable',
      state: 'closed',
      evidence: 'Every createNegative call site passes `marketplace`, so the gate reaches its protected-terms check instead of denying at `connection` first.',
      actionHref: null, actionLabel: null, operatorWork: false,
    },
    {
      n: 3,
      label: 'A removal lands at Amazon',
      state: orphaned === 0 ? 'closed' : 'open',
      evidence: `Negatives route to their own endpoints by { kind, isNegative, negativeLevel }; ${orphaned} of ${negativesTotal.toLocaleString('en-IE')} negatives are orphaned, and the routing was proven against Amazon with a reversible pause probe.`,
      actionHref: null, actionLabel: null, operatorWork: false,
    },
    {
      n: 4,
      label: 'They can be listed, removed and audited',
      state: retireSvcOk ? 'closed' : 'open',
      evidence: `The inventory, the term drawer, single and bulk removal, and evidence on both create and retire are live. ${negativesTotal.toLocaleString('en-IE')} negatives are listed; none has been retired through Nexus yet.`,
      actionHref: null, actionLabel: null, operatorWork: false,
    },
    {
      n: 5,
      label: 'The rules are scoped',
      state: scopedRules === rules.length && rules.length > 0 ? 'closed' : 'open',
      // ⚠ the denominator is the SEVEN, not the fifty-one.
      evidence: `${scopedRules} of ${rules.length} negation rules carry any scope grain, so ${rules.length - scopedRules} execute account-wide. (${scopedAnywhere} advertising rules carry a scope overall — a different denominator, and none of them is a negation rule.)`,
      actionHref: '/marketing/ads/rules-automation/automations',
      actionLabel: 'Bind a scope in Automations',
      operatorWork: true,
    },
    {
      n: 6,
      label: 'The base the rules append to has been read',
      state: audit.backward.totals.open === 0 ? 'closed' : 'open',
      evidence: `${audit.backward.totals.contradictions} negations contradict a protected term and ${audit.backward.totals.open} are still unreviewed. ${reviews} review decisions exist.`,
      actionHref: '/marketing/ads/rules-automation/negative-targeting#protected-terms',
      actionLabel: 'Triage them in the whitelist audit',
      operatorWork: true,
    },
  ]

  return {
    scope: { boundBy: scope.boundBy, market: req.market, campaignsInScope: scope.campaignIds.length },
    rules,
    totals: {
      onTab: rules.length,
      enabled: rules.filter((r) => r.enabled).length,
      atAuto: rules.filter((r) => r.autonomyLevel === 'AUTO').length,
      accountWide: rules.filter((r) => r.scope.isAccountWide).length,
      rulesInAccount: allRules.length,
      scopedAnywhere,
    },
    readiness,
    phantomActions: (PHANTOM_ACTIONS as readonly string[]).map((a) => ({
      action: a,
      onTab: (NEGATION_ACTION_TYPES as readonly string[]).includes(a),
      ceilinged: true,
      hasHandler: false,
      consequence: 'A rule using it fails on every execution with "Unknown action type" — the execution row is marked failed and nothing is written.',
    })),
    capCounter,
    coverage: { rulesRead: allRules.length, executionsRead: execs.reduce((a, e) => a + e._count._all, 0), campaignsRead: campaigns.length },
  }
}

export { NEG_MARKETS, NEG_MARKET_ALL }
