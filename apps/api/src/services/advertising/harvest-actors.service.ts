/**
 * HV.6 — who else can create a keyword or a negative here, and what will they actually do.
 *
 * READ-ONLY. This service changes no level, no rule and no code path. That is the point: HV.4's
 * first live write is still pending, and this panel's whole value is that it can be trusted about
 * what happens without itself making anything happen.
 *
 * ── What the brief expected, and what the measurement found ─────────────────────────────────
 *
 * The commissioned §4.3 was a table of leaves discarded by `ads-rule-adapter.service.ts`'s
 * `translateConditions` — "6 of 11 builder metrics dropped", per rule, with named victims. That
 * measurement was run verbatim (`scripts/_hv6-actors.mts`) against the real stored bodies. It
 * produces no table, because **the adapter never runs**:
 *
 *   builder-shaped rules (a0.type ∈ BUILDER_SLUGS) ... 0 of 62
 *   rules carrying a builder condition leaf .......... 0 of 62
 *   condition leaves the adapter has ever discarded .. 0
 *
 * Every rule in this account is engine-native — its conditions are already dot-path
 * (`{op:'gte', field:'searchTerm.orders', value:2}`), so `maybeTranslateAdsRule` returns null and
 * the engine runs the stored body directly. The 6-of-11 drop is real in the code and confirmed
 * exactly (`METRICS_BASE` 11, `SEARCHTERM_METRIC` 5, dropping ACOS/ROAS/Impressions/CVR/CTR/CPC)
 * and it has **zero victims today**. It is a landmine, not a leak: it fires on the first rule
 * anyone saves from the builder. So it renders BELOW, under `latent`, with its 0 stated plainly —
 * a gap table whose every row reads "0 affected" argues that nothing is wrong.
 *
 * The gaps that DO bound this account's runs are a different set, and sharper: the constraints
 * live in the **context builder** and in **action parameters**, neither of which appears on any
 * surface. Two of the seven rules state no criteria at all.
 *
 * ── Four things this must not do ────────────────────────────────────────────────────────────
 *
 *  1. **Never render `dryRun` or `enabled` as a mode.** `dryRun` is a dead field; the level is
 *     `resolveAutonomy()` and is one of exactly four words (C1).
 *  2. **Never render a level without its ceiling** (C2). (The old second half of this rule —
 *     "never a cap as a live brake" — expired on 2026-08-14: the null-safe counter is armed and
 *     `maxWritesPerDay` demotes past its bound. The 693,704 `DAILY_CAP_EXCEEDED` rows remain
 *     historical residue from the pre-2026-08-04 self-ratchet, newest 2026-08-03.)
 *  3. **Never merge the four words** (C7). `acted · proposed · refused · failed`, and a refusal is
 *     not a failure.
 *  4. **Never read a success counter as a write count.** `neg=8/8 grad=14/14` counts candidates
 *     PROCESSED. The write count comes from `AdvertisingActionLog`, and "landed" from an Amazon id.
 */
import prisma from '../../db.js'
import { resolveAutonomy, type AutonomyLevel } from './ads-autonomy.js'
import { graduationCeiling } from './ads-graduation.js'
import { getAutomationState } from './ads-automation-state.service.js'
import { getEngineLevers } from './ads-control-room.service.js'
import { ARMED_FLAG } from './ads-auto-harvest.service.js'
import { envEnabled } from '../../utils/env-flag.js'

/** Level order, for comparing what a surface CLAIMS against what an actor holds. */
const RANK: string[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']

/** The engine's key in the registry. C8: one display name per engine, and it comes from there. */
const ENGINE_KEY = 'auto-harvest'
/** The actor string `applyHarvest` stamps on every keyword the nightly engine writes. */
const ENGINE_ACTOR = 'automation:auto-harvest'

/**
 * An action that can bring a keyword or a negative into existence.
 *
 * Wider than "harvest": the question this panel answers is *who can create a keyword or a negative
 * in this scope*, and `sync_negatives_across_campaigns` creates negatives across every campaign in
 * a marketplace from a single firing. Excluding it because its name does not say "harvest" would
 * hide the widest blast radius in the section.
 */
const CREATING_ACTIONS = new Set([
  'promote_to_exact',
  'harvest_and_negate',
  'add_negative_exact',
  'add_negative_phrase',
  'sync_negatives_across_campaigns',
])

/** Actions that only tell someone something — they never make an actor a participant. */
const NON_WRITING = new Set(['notify', 'alert_operator', 'log_only'])

export type HvActorType = 'engine' | 'rule' | 'operator'

export interface HvActorOutcomes {
  /** SUCCESS + PARTIAL. What it did. */
  acted: number
  /** DRY_RUN. A proposal is not an action. */
  proposed: number
  /** The engine declining to run it. NEVER merged into failed. */
  refused: number
  /** FAILED, with the refusals taken out. */
  failed: number
  /** True when nothing has been refused recently — so the count renders as history, not a brake. */
  refusedIsHistorical: boolean
  refusedNewest: string | null
}

export interface HvActorGap {
  id: string
  title: string
  /** What is actually true, in a sentence an operator can act on. */
  detail: string
  /** How many rows/rules/writes this affects TODAY. `null` = not countable, never a silent 0. */
  affected: number | null
  affectedLabel: string | null
  /** Which unit closes it. HV.6 renders the gap; it fixes nothing. */
  defersTo: string
}

export interface HvActorRow {
  id: string
  type: HvActorType
  name: string
  what: string
  /** The resolved level — four words, never `dryRun`, never `enabled`. */
  level: AutonomyLevel
  /** The highest level this actor may be set to, and why. Never shown apart from the level. */
  ceiling: AutonomyLevel
  ceilingReason: string
  blockedBy: string[]
  /**
   * The named condition holding this actor below its ceiling, when one exists.
   *
   * The engine only. Rendered as a flag with a state — NEVER as a fifth mode word, which would
   * break C1's four-word contract the moment someone read it as one.
   */
  heldBy: { flag: string; set: boolean; effect: string } | null
  /**
   * 🔴 What the engine registry reports for this actor, when it disagrees with `level`.
   *
   * `ads-control-room.service.ts:293` hardcodes `masterOff ? 'OFF' : 'AUTO'` for this engine and
   * reads no flag — unlike its neighbours `rank-defend` (`NEXUS_ENABLE_RANK_DEFEND`) and
   * `budget-enforce` (`NEXUS_BUDGET_ENFORCE_APPLY`), which both read theirs and say so. So the
   * Control Room lists this engine as Auto while HV.0 has it previewing and applying nothing.
   * Rendered, not fixed: that file belongs to the Control Room programme (locks §3 #7).
   */
  registryDisagrees: { says: string; why: string } | null
  trigger: string | null
  schedule: string | null
  actionTypes: string[]
  /** Whether ANY action reaches Amazon. An actor whose only action is `notify` writes nothing. */
  writes: boolean
  scope: { kind: 'account' | 'market' | 'portfolio' | 'campaign' | 'product'; name: string | null }
  /** What it found — candidates, never writes. `null` when it has never run. */
  found: { n: number; label: string; caveat: string } | null
  /** Real writes, counted from the audit log. */
  wrote: number
  /** Of those, how many carry an Amazon id. `null` when it wrote nothing. */
  landed: number | null
  outcomes: HvActorOutcomes
  /** What the rule says, in its own stored words. `null` when it states nothing. */
  stated: string | null
  /** What actually bounds the run and appears on no surface. */
  executed: Array<{ text: string; source: string }>
  gaps: HvActorGap[]
  lastRunAt: string | null
  lastRunSummary: string | null
  /** Where to go to change any of this. HV.6 renders no dial of its own. */
  href: string | null
}

export interface HvActorsPayload {
  /** The ceiling over every actor. `min(actorLevel, accountDial)` is the effective level. */
  accountDial: { level: AutonomyLevel; halted: boolean; note: string }
  actors: HvActorRow[]
  /** One denominator for the whole section (C5). */
  reach: { campaigns: number; writable: number; unreachable: number; note: string }
  /**
   * Why nothing renders here.
   *
   * `GET /advertising/autonomy/conflicts` — the route the brief names — does not exist; `grep -a`
   * finds seven `/advertising/autonomy/*` routes and none of them is `conflicts`. The only
   * conflicts endpoint is `GET /advertising/campaigns/:id/keyword-conflicts`, which is campaign
   * grain and answers a different question entirely (RC3.2 cross-product rank collision: which of
   * my products should own a contested keyword). The only actor-vs-actor detector is
   * `ruleText.ts:261 detectConflicts`, which is web-local, rule-vs-rule, matches on trigger +
   * marketplace, and cannot see the engine (not an AutomationRule) or the operator.
   *
   * A second detector would be worse than none, so this states the absence instead.
   */
  conflicts: { available: false; why: string }
  /** Real in the code, no victim in this account today. Counted, so the 0 is stated not implied. */
  latent: HvActorGap[]
  window: { since: string | null; note: string }
}

/** The window over which the four words are counted. All time, and it says so on the page. */
async function countOutcomes(ruleIds: string[]): Promise<Map<string, HvActorOutcomes>> {
  const out = new Map<string, HvActorOutcomes>()
  if (ruleIds.length === 0) return out

  // 🔴 The null branch must be spelled out. `NOT: { errorMessage: 'X' }` becomes
  // NOT (errorMessage = 'X'), which is NULL — not TRUE — for the null every SUCCESS and DRY_RUN row
  // carries, so three-valued logic drops them. Measured on prod 2026-08-13: the terse form returns
  // **0 rows of 906,333**, not "some fewer". It would zero `acted`, `proposed` and `failed` for
  // every actor on this panel while correctly removing the cap rows.
  const graded = await prisma.automationRuleExecution.groupBy({
    by: ['ruleId', 'status'],
    where: {
      ruleId: { in: ruleIds },
      OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }],
    },
    _count: { _all: true },
  })
  // Counted separately and never merged into `failed`: the engine declining to run a rule is not
  // the rule failing. `_max.startedAt` decides whether it renders as history or as a live brake.
  const capped = await prisma.automationRuleExecution.groupBy({
    by: ['ruleId'],
    where: { ruleId: { in: ruleIds }, errorMessage: 'DAILY_CAP_EXCEEDED' },
    _count: { _all: true },
    _max: { startedAt: true },
  })
  const cappedBy = new Map(capped.map((c) => [c.ruleId, c]))

  const staleAfter = Date.now() - 7 * 86_400_000
  for (const id of ruleIds) {
    const mine = graded.filter((g) => g.ruleId === id)
    const n = (s: string) => mine.find((g) => g.status === s)?._count._all ?? 0
    const cap = cappedBy.get(id)
    const newest = cap?._max.startedAt ?? null
    out.set(id, {
      acted: n('SUCCESS') + n('PARTIAL'),
      proposed: n('DRY_RUN'),
      refused: cap?._count._all ?? 0,
      failed: n('FAILED'),
      refusedIsHistorical: newest == null || newest.getTime() < staleAfter,
      refusedNewest: newest?.toISOString() ?? null,
    })
  }
  return out
}

/**
 * Real writes per actor, and how many of them reached Amazon.
 *
 * From `AdvertisingActionLog`, never from a handler's success counter — `createNegative` and
 * `createKeywordLocal` both return ok for a local row that never left the building, which is
 * exactly how 209 of this engine's 218 keywords came to exist.
 */
async function countWrites(): Promise<Map<string, { wrote: number; landed: number }>> {
  const rows = await prisma.$queryRaw<Array<{ actor: string; wrote: bigint; landed: bigint }>>`
    SELECT l."userId" AS actor,
           COUNT(*)::bigint AS wrote,
           COUNT(*) FILTER (WHERE t."externalTargetId" IS NOT NULL)::bigint AS landed
    FROM "AdvertisingActionLog" l
    LEFT JOIN "AdTarget" t ON t.id = l."entityId"
    WHERE l."actionType" IN ('create_keyword', 'create_negative') AND l."userId" IS NOT NULL
    GROUP BY 1`
  return new Map(rows.map((r) => [r.actor, { wrote: Number(r.wrote), landed: Number(r.landed) }]))
}

/** The hidden constraints — what actually bounds a run and appears on no surface. */
function executedFor(actionTypes: string[], actions: unknown[]): Array<{ text: string; source: string }> {
  const out: Array<{ text: string; source: string }> = []
  const a = (t: string) => (actions.find((x) => (x as { type?: string })?.type === t) ?? {}) as Record<string, unknown>

  if (actionTypes.includes('promote_to_exact')) {
    out.push(
      { text: 'a 30-day window, ending 2 days back', source: 'advertising-rule-evaluator.job.ts:675 · ruleWindowBounds(30)' },
      { text: 'orders ≥ 2 as a HAVING clause — a rule condition can tighten it, never loosen it', source: 'CONVERTING_MIN_ORDERS, same file' },
      { text: 'the first 300 grouped terms only', source: '.slice(0, 300), same file' },
      { text: 'BROAD and PHRASE source terms only', source: 'matchType filter, :685' },
    )
    const bid = a('promote_to_exact').bidEur
    out.push({ text: `a fixed bid of €${Number(bid ?? 0.5).toFixed(2)} on every keyword it creates`, source: bid == null ? 'automation-action-handlers.ts:1066 (default)' : 'stored on this rule' })
  }
  if (actionTypes.includes('harvest_and_negate')) {
    const h = a('harvest_and_negate')
    const has = h.minOrders != null || h.windowDays != null || h.minSpendCents != null
    out.push({
      text: has
        ? `orders ≥ ${h.minOrders ?? 2} · a ${h.windowDays ?? 60}-day window · spend ≥ €${((Number(h.minSpendCents ?? 1000)) / 100).toFixed(2)}`
        : 'orders ≥ 2 · a 60-day window · spend ≥ €10.00 — every one a handler default',
      source: has ? 'stored in the ACTION, not in the criteria' : 'automation-action-handlers.ts:843 (defaults)',
    })
    out.push({ text: `a fixed bid of €${Number(h.graduationBidEur ?? 0.5).toFixed(2)} on every keyword it creates`, source: h.graduationBidEur == null ? 'automation-action-handlers.ts:907 (default)' : 'stored on this rule' })
    out.push({ text: 'negatives written at CAMPAIGN scope', source: 'ads-harvest.service.ts · negateCampaign' })
  }
  if (actionTypes.includes('sync_negatives_across_campaigns')) {
    out.push({ text: 'one term negated in EVERY enabled campaign in the marketplace, from a single firing', source: 'automation-action-handlers.ts:1081' })
  }
  return out
}

/** The gaps with a live victim, per actor. Each names what would close it and defers. */
function gapsFor(actionTypes: string[], stated: string | null, autoTargetingRows: number, type: HvActorType): HvActorGap[] {
  const out: HvActorGap[] = []
  if (actionTypes.includes('promote_to_exact')) {
    out.push({
      id: 'auto-targeting-blind-spot',
      title: 'Auto-targeting demand is invisible to this rule',
      detail: 'The context builder accepts BROAD, PHRASE, or a NULL match type. No row in this account has ever been NULL — auto-targeting arrives as TARGETING_EXPRESSION and TARGETING_EXPRESSION_PREDEFINED, so it is never offered to this rule at all. HV.1 repaired the page’s own read; the rule path is unrepaired.',
      affected: autoTargetingRows,
      affectedLabel: 'search-term rows',
      defersTo: 'HV.8',
    })
  }
  if (actionTypes.includes('harvest_and_negate')) {
    out.push({
      id: 'negate-campaign-scope',
      title: 'Its negatives are written at a scope that has never reached Amazon',
      detail: 'Every campaign-scoped negative in this account — 20 of them, newest 2026-06-24 — exists only in our database. Ad-group scope lands: 2,017 of 2,037. A negative that never reaches Amazon silences nothing, and the term keeps spending.',
      affected: 20,
      affectedLabel: 'negatives written, 0 at Amazon',
      defersTo: 'HV.8',
    })
  }
  if (stated == null) {
    out.push({
      id: 'states-nothing',
      title: 'It states no criteria at all',
      detail: type === 'engine'
        ? 'This engine has no criteria to state. Its thresholds are arguments passed to previewHarvest in code, so there is nothing an operator could read, and nothing they could change without a deploy.'
        : 'This rule’s stored conditions are empty. Everything that decides what it touches lives in its action parameters, which no surface in this product renders. Reading the rule tells you nothing about what it would do.',
      affected: null,
      affectedLabel: null,
      defersTo: 'HV.8',
    })
  }
  return out
}

export async function getHarvestActors(opts: { market: string }): Promise<HvActorsPayload> {
  const [state, rules, protections, levers, writes, autoTargeting, campaignTotals] = await Promise.all([
    getAutomationState(),
    prisma.automationRule.findMany({
      where: { domain: 'advertising' },
      select: {
        id: true, name: true, description: true, trigger: true, enabled: true, dryRun: true,
        autonomyLevel: true, actions: true, conditions: true, maxExecutionsPerDay: true,
        scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
        lastExecutedAt: true,
      },
      orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
    }),
    prisma.adKeywordProtection.count(),
    getEngineLevers().catch(() => ({ levers: [] as Array<Record<string, unknown>> })),
    countWrites(),
    // The blind spot's victim count: rows whose match type the converting-context filter cannot see.
    prisma.amazonAdsSearchTerm.count({ where: { matchType: { in: ['TARGETING_EXPRESSION', 'TARGETING_EXPRESSION_PREDEFINED'] } } }),
    // Reach at the CURRENT scope, on one denominator (C5). `all` counts the account; a single
    // market counts that market, so the sentence under the panel changes when the scope bar does.
    (() => {
      const where = opts.market === 'all' ? {} : { marketplace: opts.market }
      return Promise.all([
        prisma.campaign.count({ where }),
        prisma.campaign.count({ where: { ...where, status: 'ENABLED', externalCampaignId: { not: null } } }),
      ])
    })(),
  ])

  const actorRules = rules.filter((r) => {
    const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<{ type?: string }>
    return acts.some((a) => a?.type != null && CREATING_ACTIONS.has(a.type))
  })
  const outcomes = await countOutcomes(actorRules.map((r) => r.id))

  const actors: HvActorRow[] = []

  // ── the engine ────────────────────────────────────────────────────────────
  // Its name comes from the registry and nowhere else (C8): `Harvest & negate`, never
  // `ads-auto-harvest`, never `automation:auto-harvest`. Its LEVEL does not — see below.
  const lever = ((levers as { levers?: Array<Record<string, unknown>> }).levers ?? []).find((l) => l.key === ENGINE_KEY)
  const armed = envEnabled(ARMED_FLAG)
  const engineLevel: AutonomyLevel = armed ? 'AUTO' : 'PROPOSE'
  const engineWrites = writes.get(ENGINE_ACTOR) ?? { wrote: 0, landed: 0 }
  const registrySays = lever?.mode == null ? null : String(lever.mode)
  const engineCeiling = graduationCeiling({ actionTypes: ['harvest_and_negate'], hasKeywordProtections: protections > 0 })
  const lastSummary = lever?.lastRunSummary == null ? null : String(lever.lastRunSummary)
  const foundMatch = lastSummary?.match(/neg=(\d+)\/(\d+)\s+grad=(\d+)\/(\d+)/)

  actors.push({
    id: `engine:${ENGINE_KEY}`,
    type: 'engine',
    name: lever?.name == null ? 'Harvest & negate' : String(lever.name),
    what: lever?.what == null ? 'Promotes converting search terms and negates wasteful ones' : String(lever.what),
    level: engineLevel,
    // The ceiling is the same one every rule below is held at — and that is the point of the
    // panel: the identical action, judged by the identical rule, had no ceiling applied to it
    // at all until HV.0. It was gated only by a global switch on another page.
    ceiling: engineCeiling.maxLevel,
    ceilingReason: engineCeiling.reason,
    blockedBy: engineCeiling.blockedBy,
    heldBy: {
      flag: ARMED_FLAG,
      set: armed,
      effect: armed
        ? 'set — this engine applies its harvest every night'
        : 'unset — it previews every night and applies nothing',
    },
    registryDisagrees: registrySays != null && registrySays !== engineLevel
      ? {
        says: registrySays,
        // The direction matters and must not be asserted. The registry reads no flag, so it can
        // land either side of the truth: OFF when the ads cron master switch is down, AUTO when it
        // is up. Naming the wrong direction would be the same class of error this panel exists to
        // catch, so the sentence is derived from the comparison rather than written once.
        why: RANK.indexOf(registrySays) > RANK.indexOf(engineLevel)
          ? 'The engine registry hardcodes this entry and reads no flag, unlike rank-defend and budget-enforce which read theirs and say so. The Control Room therefore lists this engine ABOVE what it can actually do.'
          : 'The engine registry hardcodes this entry and reads no flag. It is reporting a lower level than this engine actually holds, from a different switch — so the two surfaces disagree in the safe direction, which is still a disagreement.',
      }
      : null,
    trigger: 'SCHEDULE',
    schedule: lever?.schedule == null ? 'daily 06:30' : String(lever.schedule),
    actionTypes: ['harvest_and_negate'],
    writes: true,
    scope: { kind: 'account', name: null },
    found: foundMatch
      ? {
        n: Number(foundMatch[2]) + Number(foundMatch[4]),
        label: `${foundMatch[4]} to graduate · ${foundMatch[2]} to negate`,
        caveat: 'Candidates processed on its last run — not writes made. The engine’s own summary counts both the same way.',
      }
      : null,
    wrote: engineWrites.wrote,
    landed: engineWrites.wrote > 0 ? engineWrites.landed : null,
    outcomes: {
      // The engine is a cron, not an AutomationRule: it has no execution rows to grade. Its record
      // is what it wrote, which is the column beside this one. Four zeroes here would be a lie in
      // the other direction, so the panel renders a dash and says where its record is.
      acted: 0, proposed: 0, refused: 0, failed: 0, refusedIsHistorical: true, refusedNewest: null,
    },
    stated: null,
    executed: executedFor(['harvest_and_negate'], [{ type: 'harvest_and_negate' }]),
    gaps: gapsFor(['harvest_and_negate'], null, autoTargeting, 'engine'),
    lastRunAt: lever?.lastRunAt == null ? null : String(lever.lastRunAt),
    lastRunSummary: lastSummary,
    href: '/marketing/ads/rules-automation/control-room',
  })

  // ── the rules ─────────────────────────────────────────────────────────────
  for (const r of actorRules) {
    const rawActions = (Array.isArray(r.actions) ? r.actions : []) as unknown[]
    const actionTypes = rawActions.map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)
    const acting = actionTypes.filter((t) => !NON_WRITING.has(t))
    const ceiling = graduationCeiling({ actionTypes, hasKeywordProtections: protections > 0 })
    const groups = (Array.isArray(r.conditions) ? r.conditions : []) as Array<Record<string, unknown>>
    // Engine-native leaves, which is what every rule in this account stores. The builder shape
    // (`{metric, op, value}` inside groups) has zero instances — see the header.
    const leaves = groups.filter((g) => g?.field != null && g?.op != null)
    const stated = leaves.length
      ? leaves.map((g) => `${String(g.field)} ${String(g.op)} ${String(g.value)}`).join(' AND ')
      : null

    actors.push({
      id: r.id,
      type: 'rule',
      name: r.name,
      what: r.description ?? '',
      level: resolveAutonomy(r),
      ceiling: ceiling.maxLevel,
      ceilingReason: ceiling.reason,
      blockedBy: ceiling.blockedBy,
      heldBy: null,
      registryDisagrees: null,
      trigger: r.trigger,
      schedule: null,
      actionTypes: acting,
      writes: acting.length > 0,
      scope: r.scopeCampaignId
        ? { kind: 'campaign', name: r.scopeCampaignId }
        : r.scopePortfolioId
          ? { kind: 'portfolio', name: r.scopePortfolioId }
          : r.scopeProductId
            ? { kind: 'product', name: r.scopeProductId }
            : r.scopeMarketplace
              ? { kind: 'market', name: r.scopeMarketplace }
              : { kind: 'account', name: null },
      found: null,
      wrote: writes.get(`automation:${r.id}`)?.wrote ?? 0,
      landed: (writes.get(`automation:${r.id}`)?.wrote ?? 0) > 0 ? (writes.get(`automation:${r.id}`)?.landed ?? 0) : null,
      outcomes: outcomes.get(r.id) ?? { acted: 0, proposed: 0, refused: 0, failed: 0, refusedIsHistorical: true, refusedNewest: null },
      stated,
      executed: executedFor(actionTypes, rawActions),
      gaps: gapsFor(actionTypes, stated, autoTargeting, 'rule'),
      lastRunAt: r.lastExecutedAt?.toISOString() ?? null,
      lastRunSummary: null,
      href: `/marketing/ads/rules-automation/automations?rule=${encodeURIComponent(r.id)}`,
    })
  }

  // ── you ───────────────────────────────────────────────────────────────────
  // HV.4's path. It is on the list at zero because "no operator has ever harvested here" is a
  // fact about this account, and an absent row would read as "operators cannot", which is false.
  const operatorWrote = [...writes.entries()]
    .filter(([k]) => !k.startsWith('automation:') && k !== 'user:anonymous' && k !== 'htest')
    .reduce((s, [, v]) => s + v.wrote, 0)
  actors.push({
    id: 'operator',
    type: 'operator',
    name: 'You',
    what: 'Promote a candidate and negate it at source, as one transaction',
    level: 'AUTO',
    ceiling: 'AUTO',
    ceilingReason: 'A person is not gated by the graduation ceiling — it exists to decide what may run unattended.',
    blockedBy: [],
    heldBy: null,
    registryDisagrees: null,
    trigger: null,
    schedule: null,
    actionTypes: ['promote_to_exact', 'add_negative_exact'],
    writes: true,
    scope: { kind: 'account', name: null },
    found: null,
    wrote: operatorWrote,
    landed: null,
    outcomes: { acted: 0, proposed: 0, refused: 0, failed: 0, refusedIsHistorical: true, refusedNewest: null },
    stated: 'whatever the Candidates view is filtered to, at the moment you decide',
    executed: [
      { text: 'the write gate, the keyword whitelist, and an ad-group-scoped negative', source: 'HV.4 · harvest-promote.service.ts' },
      { text: 'a bid derived from the term’s own observed CPC, clamped to the campaign ceiling', source: 'HV.4 · deriveBid' },
    ],
    gaps: [],
    lastRunAt: null,
    lastRunSummary: null,
    href: null,
  })

  const oldest = await prisma.automationRuleExecution.findFirst({
    where: { ruleId: { in: actorRules.map((r) => r.id) } },
    orderBy: { startedAt: 'asc' },
    select: { startedAt: true },
  })

  const [totalCampaigns, writable] = campaignTotals
  return {
    accountDial: {
      level: (state.autonomy as AutonomyLevel) ?? 'OFF',
      halted: Boolean(state.halted),
      note: 'The account dial is a ceiling over every actor: the effective level is the lower of the two. It is not what is holding the harvest engine down.',
    },
    actors,
    reach: {
      campaigns: totalCampaigns,
      writable,
      unreachable: totalCampaigns - writable,
      note: `${writable} of ${totalCampaigns} campaigns${opts.market === 'all' ? '' : ` in ${opts.market}`} are enabled and carry an Amazon id. The other ${totalCampaigns - writable} cannot be touched by any actor on this list — a rule that looks broken is often pointed at one of them.`,
    },
    conflicts: {
      available: false,
      why: 'Nothing is shown here because nothing can answer it. GET /advertising/autonomy/conflicts does not exist; the only conflicts route is campaign-grained and answers a different question — which of your products should own a contested keyword. The rule-vs-rule detector on the Automations page matches on trigger and marketplace, and cannot see the engine or you. A second detector built here would be worse than none.',
    },
    // P2.7 — all three latent entries this list used to carry are CLOSED, and a truth panel that
    // outlives its truth is the defect it exists to prevent:
    //   · adapter-metric-drop — the maps cover every offered metric and an unmapped one now
    //     REFUSES the rule at save and at evaluation instead of loosening it (P2.1);
    //   · adapter-windows-dropped — the Lookback/Exclude selects are gone; the builder states the
    //     trigger's fixed window and stores that truth (P2.1);
    //   · daily-cap-not-enforced — the null-safe counter was armed 2026-08-14 (6ce492420), caps
    //     re-sized in the counted unit first (c573f3ac1), and `maxWritesPerDay` demotes past its
    //     bound (5cda0d120). The 693,704 rows stay in history; nothing newer than 2026-08-03.
    latent: [],
    window: {
      since: oldest?.startedAt.toISOString() ?? null,
      note: 'Counted over every execution on record. The Automations board counts the last 7 days, so its numbers are smaller by design.',
    },
  }
}
