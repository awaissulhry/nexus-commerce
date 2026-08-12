/**
 * HV.2 — the harvest policy: the criteria in force for a scope, and where they came from.
 *
 * ── 🔴 Two distinct things, two labels, never one control ─────────────────────────────────────
 *
 *   **the filter**  the values this VIEW is using right now. Lives in the URL. Changes the grid,
 *                   immediately. A link carries it. Binds nothing.
 *   **the policy**  the values SAVED for a scope. Lives in this table. Changes the default for
 *                   everyone in that scope. The link carries the scope; the policy is looked up.
 *
 * A user moves the filter to explore. A user saves a policy when they have decided. This module
 * owns the second one and knows nothing about the first — the route composes them, so a URL
 * override can never be mistaken for a stored decision.
 *
 * ── Resolution ────────────────────────────────────────────────────────────────────────────────
 *
 * Most specific first: adGroup → campaign → portfolio → line → market → account, and **the first
 * row found wins WHOLE.** There is deliberately no field-level merge across levels: merging would
 * make "which number is actually in force" unanswerable, which is the exact failure this control
 * exists to remove. If an ad-group policy sets only `minOrders`, it still supplies every other
 * criterion too — because it is a policy, not a patch.
 *
 * Resolution walks the grains the OPERATOR SELECTED, not the grain that bound the read. Those
 * differ: picking a campaign inside a portfolio binds at `campaign`, but if that campaign has no
 * policy the portfolio's should still apply.
 */

import prisma from '../../db.js'

export type HvPolicyGrain = 'account' | 'market' | 'line' | 'portfolio' | 'campaign' | 'adGroup'
export const HV_POLICY_GRAINS: HvPolicyGrain[] = ['adGroup', 'campaign', 'portfolio', 'line', 'market', 'account']
/** The account row's scopeId. Not null — see the migration's header for why. */
export const HV_ACCOUNT_SCOPE = '*'

export interface HarvestCriteria {
  minOrders: number
  minClicks: number
  /** null = no ceiling */
  maxAcosPct: number | null
  windowDays: number
  excludeExactMatched: boolean
}

/**
 * The shipped defaults, used when no policy exists at any grain.
 *
 * Every one is measured, not chosen (`scripts/_hv-2-criteria.mts`, prod 2026-08-12):
 *
 *   minOrders 2            the published practitioner bar, and D2 — unchanged. 1 → 92 candidates,
 *                          2 → 17, 3 → 8.
 *   minClicks 3            a FLUKE GUARD, not a volume gate. At 2+ orders it removes exactly one
 *                          row: 2 orders on 1 click, which at this account's 1.3–2.5% CVR is an
 *                          attribution artefact (one shopper, one click, two units) rather than
 *                          demand. `clicks ≥ 10` would cut 5 of 14 and start removing plausible
 *                          terms.
 *   maxAcosPct 45          DERIVED: `Campaign.targetAcosPct` is unset on all 220 campaigns, so
 *                          there is no configured target to inherit. 45% is the account's own
 *                          blended ACoS on all search-term traffic over 60 days (€5,346.33 spend /
 *                          €11,893.19 sales). The ceiling therefore reads "do not harvest a term
 *                          that performs worse than the average of everything you already run."
 *   windowDays 60          the account produces 17 double-order terms in SIXTY days; a 7-day
 *                          harvest window here is a random-number generator.
 *   excludeExactMatched    true — see the match-type rule below.
 */
export const HV_DEFAULT_CRITERIA: HarvestCriteria = {
  minOrders: 2,
  minClicks: 3,
  maxAcosPct: 45,
  windowDays: 60,
  excludeExactMatched: true,
}

export interface ResolvedPolicy {
  criteria: HarvestCriteria
  /** which grain supplied them; 'default' when no row exists anywhere */
  source: HvPolicyGrain | 'default'
  sourceScopeId: string | null
  /** a policy row exists at THIS exact scope (so the UI offers "update" rather than "create") */
  hasOwn: boolean
  updatedAt: string | null
  updatedBy: string | null
}

export interface HvPolicyScope {
  market: string
  line?: string | null
  portfolio?: string | null
  campaign?: string | null
  adGroup?: string | null
}

/** The (grain, id) pairs to try, most specific first. Grains the operator did not pick are skipped. */
export function policyLookupChain(scope: HvPolicyScope): Array<{ grain: HvPolicyGrain; scopeId: string }> {
  const chain: Array<{ grain: HvPolicyGrain; scopeId: string }> = []
  if (scope.adGroup) chain.push({ grain: 'adGroup', scopeId: scope.adGroup })
  if (scope.campaign) chain.push({ grain: 'campaign', scopeId: scope.campaign })
  if (scope.portfolio) chain.push({ grain: 'portfolio', scopeId: scope.portfolio })
  if (scope.line) chain.push({ grain: 'line', scopeId: scope.line })
  // 'all' is not a market. A policy saved for IT must not leak into the account-wide view.
  if (scope.market && scope.market !== 'all') chain.push({ grain: 'market', scopeId: scope.market })
  chain.push({ grain: 'account', scopeId: HV_ACCOUNT_SCOPE })
  return chain
}

export async function resolveHarvestPolicy(scope: HvPolicyScope, kind = 'graduate'): Promise<ResolvedPolicy> {
  const chain = policyLookupChain(scope)
  const rows = await prisma.adsHarvestPolicy.findMany({
    where: { kind, OR: chain.map((c) => ({ scopeGrain: c.grain, scopeId: c.scopeId })) },
  })
  const byKey = new Map(rows.map((r) => [`${r.scopeGrain}|${r.scopeId}`, r]))

  // The most specific grain the operator actually picked — what "save here" would write to, and
  // what `hasOwn` is about. Not the same as the grain that SUPPLIED the criteria.
  const own = chain[0] ? byKey.get(`${chain[0].grain}|${chain[0].scopeId}`) : undefined

  for (const c of chain) {
    const row = byKey.get(`${c.grain}|${c.scopeId}`)
    if (!row) continue
    return {
      criteria: {
        minOrders: row.minOrders,
        minClicks: row.minClicks,
        maxAcosPct: row.maxAcosPct,
        windowDays: row.windowDays,
        excludeExactMatched: row.excludeExactMatched,
      },
      source: row.scopeGrain as HvPolicyGrain,
      sourceScopeId: row.scopeId === HV_ACCOUNT_SCOPE ? null : row.scopeId,
      hasOwn: !!own,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    }
  }

  return { criteria: { ...HV_DEFAULT_CRITERIA }, source: 'default', sourceScopeId: null, hasOwn: false, updatedAt: null, updatedBy: null }
}

/** Every policy row, for the "where else is one set" list the save dialog shows. */
export async function listHarvestPolicies(kind = 'graduate') {
  const rows = await prisma.adsHarvestPolicy.findMany({ where: { kind }, orderBy: [{ scopeGrain: 'asc' }, { scopeId: 'asc' }] })
  return rows.map((r) => ({
    id: r.id,
    scopeGrain: r.scopeGrain as HvPolicyGrain,
    scopeId: r.scopeId === HV_ACCOUNT_SCOPE ? null : r.scopeId,
    criteria: { minOrders: r.minOrders, minClicks: r.minClicks, maxAcosPct: r.maxAcosPct, windowDays: r.windowDays, excludeExactMatched: r.excludeExactMatched },
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedBy,
  }))
}

export class HarvestPolicyError extends Error {
  constructor(message: string, readonly code: string) { super(message) }
}

/** Bounds, so a stored policy can never be a number the page cannot render or the read cannot use. */
export function validateCriteria(c: Partial<HarvestCriteria>): HarvestCriteria {
  const minOrders = Math.floor(Number(c.minOrders))
  const minClicks = Math.floor(Number(c.minClicks))
  const windowDays = Math.floor(Number(c.windowDays))
  if (!Number.isFinite(minOrders) || minOrders < 1 || minOrders > 100) throw new HarvestPolicyError('minOrders must be between 1 and 100', 'bad_min_orders')
  if (!Number.isFinite(minClicks) || minClicks < 0 || minClicks > 10_000) throw new HarvestPolicyError('minClicks must be between 0 and 10000', 'bad_min_clicks')
  if (![30, 60, 90].includes(windowDays)) throw new HarvestPolicyError('windowDays must be 30, 60 or 90', 'bad_window')
  let maxAcosPct: number | null = null
  if (c.maxAcosPct != null && String(c.maxAcosPct) !== '') {
    maxAcosPct = Math.floor(Number(c.maxAcosPct))
    if (!Number.isFinite(maxAcosPct) || maxAcosPct < 1 || maxAcosPct > 1000) throw new HarvestPolicyError('maxAcosPct must be between 1 and 1000, or null for no ceiling', 'bad_max_acos')
  }
  return { minOrders, minClicks, maxAcosPct, windowDays, excludeExactMatched: c.excludeExactMatched !== false }
}

/**
 * Save a policy at one grain.
 *
 * 🔴 `kind` is forced to 'graduate'. The negation threshold belongs to Negative Targeting (D4) and
 * this page renders no negation control; accepting a 'negate' row here would let the Keyword
 * Harvest page quietly own a number that another page's operator is responsible for.
 */
export async function saveHarvestPolicy(args: {
  scopeGrain: HvPolicyGrain
  scopeId: string | null
  criteria: Partial<HarvestCriteria>
  updatedBy: string
}) {
  if (!HV_POLICY_GRAINS.includes(args.scopeGrain)) throw new HarvestPolicyError(`unknown scope grain "${args.scopeGrain}"`, 'bad_grain')
  const scopeId = args.scopeGrain === 'account' ? HV_ACCOUNT_SCOPE : (args.scopeId ?? '').trim()
  if (args.scopeGrain !== 'account' && !scopeId) throw new HarvestPolicyError(`a ${args.scopeGrain} policy needs a scope id`, 'scope_id_required')
  if (args.scopeGrain === 'market' && scopeId === 'all') throw new HarvestPolicyError('"all" is not a market — save at the account grain instead', 'all_is_not_a_market')
  const criteria = validateCriteria(args.criteria)
  const updatedBy = (args.updatedBy || '').trim()
  if (!updatedBy) throw new HarvestPolicyError('updatedBy is required — a threshold is a money decision', 'actor_required')

  const row = await prisma.adsHarvestPolicy.upsert({
    where: { scopeGrain_scopeId_kind: { scopeGrain: args.scopeGrain, scopeId, kind: 'graduate' } },
    create: { scopeGrain: args.scopeGrain, scopeId, kind: 'graduate', ...criteria, updatedBy },
    update: { ...criteria, updatedBy },
  })
  return { id: row.id, scopeGrain: row.scopeGrain, scopeId: row.scopeId === HV_ACCOUNT_SCOPE ? null : row.scopeId, criteria, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy }
}

/** Remove an override so the scope falls back to whatever is above it. Never a silent no-op. */
export async function deleteHarvestPolicy(scopeGrain: HvPolicyGrain, scopeId: string | null) {
  const id = scopeGrain === 'account' ? HV_ACCOUNT_SCOPE : (scopeId ?? '').trim()
  if (scopeGrain !== 'account' && !id) throw new HarvestPolicyError(`a ${scopeGrain} policy needs a scope id`, 'scope_id_required')
  const existing = await prisma.adsHarvestPolicy.findUnique({ where: { scopeGrain_scopeId_kind: { scopeGrain, scopeId: id, kind: 'graduate' } } })
  if (!existing) throw new HarvestPolicyError('there is no policy at that scope to remove', 'not_found')
  await prisma.adsHarvestPolicy.delete({ where: { id: existing.id } })
  return { removed: { scopeGrain, scopeId: scopeGrain === 'account' ? null : id } }
}
