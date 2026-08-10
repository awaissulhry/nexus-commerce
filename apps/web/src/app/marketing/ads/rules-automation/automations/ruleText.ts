/**
 * RA.AUTO — a stored rule, in plain English.
 *
 * WHY THIS IS NOT AN IMPORT. `ads-console/automation/vocab.ts` already holds field labels and
 * the unit semantics below, and copying it would normally be exactly the duplication this
 * section exists to remove. Two reasons it is written here instead:
 *
 *   · That module is the COMPOSER's vocabulary — it round-trips a value for editing
 *     (`condToRaw`/`condFromRaw`) and carries entity/param metadata a reader never needs.
 *     This file only renders.
 *   · Importing it would make a new `/marketing/ads` page depend on `/marketing/ads-console`,
 *     the console this section is built to absorb. The page would break on the day someone
 *     retires it — building the replacement on top of the thing being replaced.
 *
 * The unit semantics are deliberately identical to `vocab.ts`'s so the two can never disagree
 * about what `0.15` means. When ads-console goes, this becomes the section's only copy.
 *
 * SHAPES ARE MEASURED, NOT ASSUMED (prod, 2026-08-10, `scripts/_ra4-shapes.mts`):
 *   conditions  27 rules × [{field,op,value}] · 24 rules × []      — never nested
 *   actions     30 distinct type+parameter combinations across 21 types
 * There is no `{kind:'and'|'or'|'not', children}` anywhere in this account's 51 rules, so this
 * file does not pretend to render one. The five rule-type tabs read a nested builder shape that
 * 0 of 51 rows carry, which is why every Criteria cell on them renders "—".
 */

type Unit = 'ratio' | 'eur' | 'roas' | 'num' | 'days'

/** field → { label, unit }. Every field measured in use, plus the near neighbours of each. */
const FIELDS: Record<string, { label: string; unit: Unit }> = {
  'campaign.acos': { label: 'Campaign ACOS', unit: 'ratio' },
  'campaign.roas': { label: 'Campaign ROAS', unit: 'roas' },
  'campaign.spendCents': { label: 'Campaign spend', unit: 'eur' },
  'campaign.budgetUtilization': { label: 'Budget used', unit: 'ratio' },
  'adTarget.spendCents': { label: 'Target spend', unit: 'eur' },
  'adTarget.salesCents': { label: 'Target sales', unit: 'eur' },
  'adTarget.ordersCount': { label: 'Target orders', unit: 'num' },
  'adTarget.clicks': { label: 'Target clicks', unit: 'num' },
  'adTarget.impressions': { label: 'Target impressions', unit: 'num' },
  'adTarget.ctr': { label: 'Target CTR', unit: 'ratio' },
  'profit.netCents': { label: 'Net profit', unit: 'eur' },
  'budget.monthlySpendCents': { label: 'Month-to-date ad spend', unit: 'eur' },
  'searchTerm.orders': { label: 'Search-term orders', unit: 'num' },
  'fbaAge.daysToLtsThreshold': { label: 'Days to long-term storage', unit: 'days' },
}

const OP: Record<string, string> = {
  gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠',
}

/** Same conversion as vocab.ts's `condFromRaw` — a ratio is stored as a fraction, money in cents. */
function value(unit: Unit, raw: unknown): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return String(raw ?? '')
  switch (unit) {
    // A ratio drops its trailing zeros — "15%" reads better than "15.00%". Money never does:
    // `+(10).toFixed(2)` is 10, which renders "€10" and stops looking like a currency amount.
    case 'ratio': return `${+(n * 100).toFixed(2)}%`
    case 'eur': return `€${(n / 100).toFixed(2)}`
    case 'roas': return `${n}×`
    case 'days': return `${n} days`
    default: return String(n)
  }
}

export interface Leaf { field?: string; op?: string; value?: unknown }

/**
 * The "If" line. An empty conditions array is NOT an error and not a dash — 24 of 51 rules
 * genuinely have none, and those fire on every tick of their trigger. Saying so is the
 * difference between a rule an operator understands and one they assume is broken.
 */
export function conditionText(conditions: unknown): { text: string; unconditional: boolean } {
  const list = (Array.isArray(conditions) ? conditions : []) as Leaf[]
  const parts = list
    .filter((c) => c && typeof c.field === 'string')
    .map((c) => {
      const fd = FIELDS[c.field!] ?? { label: c.field!, unit: 'num' as Unit }
      if (c.op === 'exists') return `${fd.label} is present`
      return `${fd.label} ${OP[c.op ?? ''] ?? c.op ?? ''} ${value(fd.unit, c.value)}`
    })
  if (!parts.length) return { text: 'no conditions — fires every time its trigger runs', unconditional: true }
  return { text: parts.join(' and '), unconditional: false }
}

/** action type → what it does, in the operator's words rather than the engine's. */
const ACTIONS: Record<string, string> = {
  bid_to_target_acos: 'Move bids toward the target ACOS',
  bid_up: 'Raise bids',
  bid_down: 'Lower bids',
  set_bid: 'Set the bid',
  lower_bid_to_floor: 'Drop the bid to the floor',
  raise_bids_for_rank_defense: 'Raise bids to defend rank',
  adjust_ad_budget: 'Change the daily budget',
  budget_apply: 'Apply the budget plan',
  shift_budget: 'Move budget between campaigns',
  set_placement_multiplier: 'Change a placement multiplier',
  defend_top_of_search: 'Defend top-of-search share',
  refresh_dayparting: 'Rewrite the dayparting plan',
  promote_to_exact: 'Graduate a search term to exact',
  harvest_and_negate: 'Graduate converting terms and negate wasteful ones',
  add_negative_exact: 'Add a negative exact',
  add_negative_phrase: 'Add a negative phrase',
  sync_negatives_across_campaigns: 'Copy negatives across campaigns',
  archive_keyword: 'Archive the keyword',
  pause_campaign: 'Pause the campaign',
  pause_ad_group: 'Pause the ad group',
  pause_all_campaigns: 'Pause EVERY campaign',
  pause_target: 'Pause the target',
  pause_ads_for_product: 'Pause ads for the product',
  retail_guard: 'Pause ads on out-of-stock / lost-Buy-Box products',
  create_amazon_promotion: 'Create an Amazon promotion',
  notify: 'Notify you',
  alert_operator: 'Alert you',
  log_only: 'Record it only',
}

/** Actions that never reach Amazon — the same set the server uses to compute `writes`. */
export const NON_WRITING = new Set(['notify', 'alert_operator', 'log_only'])

/**
 * The parameters that change what an action DOES, rendered beside it.
 *
 * `targetAcos` is deliberately printed raw. Measured on prod: one rule stores `0.3` and another
 * stores `30` for the same key, so any surface that picked a unit would misreport one of them by
 * 100×. Printing the stored number keeps the discrepancy visible instead of laundering it.
 */
function params(a: Record<string, unknown>): string {
  const out: string[] = []
  if (typeof a.percent === 'number') out.push(`by ${a.percent}%`)
  if (typeof a.percentage === 'number') out.push(`by ${a.percentage}%`)
  if (typeof a.maxPct === 'number') out.push(`max ${a.maxPct}%`)
  if (typeof a.placement === 'string') out.push(String(a.placement).replace('PLACEMENT_', '').toLowerCase())
  if (typeof a.target === 'string' && a.type !== 'notify') out.push(`on the ${String(a.target).replace(/_/g, ' ')}`)
  if (a.targetAcos != null) out.push(`target ACOS ${a.targetAcos} (as stored)`)
  if (typeof a.targetIS === 'number') out.push(`target IS ${a.targetIS}`)
  if (typeof a.floorCents === 'number') out.push(`floor €${(a.floorCents / 100).toFixed(2)}`)
  if (typeof a.bidEur === 'number') out.push(`bid €${a.bidEur}`)
  if (typeof a.graduationBidEur === 'number') out.push(`graduate at €${a.graduationBidEur}`)
  if (typeof a.minOrders === 'number') out.push(`≥${a.minOrders} orders`)
  if (typeof a.minSpendCents === 'number') out.push(`≥€${(a.minSpendCents / 100).toFixed(2)} spend`)
  if (typeof a.windowDays === 'number') out.push(`over ${a.windowDays}d`)
  if (typeof a.discountPct === 'number') out.push(`${a.discountPct}% off`)
  if (typeof a.durationDays === 'number') out.push(`for ${a.durationDays}d`)
  if (typeof a.bidUpPct === 'number') out.push(`+${a.bidUpPct}% peak`)
  if (typeof a.bidDownPct === 'number') out.push(`−${a.bidDownPct}% trough`)
  if (a.pauseOvernight === true) out.push('pause overnight')
  if (a.profitMode === true) out.push('profit-native')
  if (a.bayesian === true) out.push('bayesian')
  if (typeof a.acosMode === 'string') out.push(String(a.acosMode))
  if (Array.isArray(a.campaignIds)) out.push(`${a.campaignIds.length} named campaigns`)
  return out.join(', ')
}

export interface ActionLine { label: string; detail: string; writes: boolean; type: string }

/** The "Then" lines. One per action, in stored order, writing actions first is NOT applied —
 *  order is what the engine executes, and reordering it for looks would misdescribe the rule. */
export function actionLines(actions: unknown): ActionLine[] {
  const list = (Array.isArray(actions) ? actions : []) as Array<Record<string, unknown>>
  return list.map((a) => {
    const type = String(a?.type ?? '')
    return {
      type,
      label: ACTIONS[type] ?? (type.replace(/_/g, ' ') || 'unknown action'),
      detail: params(a ?? {}),
      writes: !!type && !NON_WRITING.has(type),
    }
  })
}

/**
 * The acronyms this account's trigger names are built from. Without them, sentence-casing
 * `CAC_SPIKE` produces "Cac spike", which shipped to prod and reads as a typo rather than a
 * metric. Nine of the 21 triggers in use contain one.
 */
const ACRONYMS = new Set(['CAC', 'ACOS', 'ROAS', 'CTR', 'CVR', 'SOV', 'FBA', 'TOS', 'ASIN', 'SP', 'SB', 'SD'])

/** Trigger → the "When" line. SCHEDULE is renamed because "on a schedule" is what it means. */
export function triggerText(trigger: string): string {
  if (trigger === 'SCHEDULE') return 'On a schedule (every evaluator tick)'
  const words = trigger.split('_').filter(Boolean)
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w)) return w
      const lower = w.toLowerCase()
      return i === 0 ? lower.replace(/^./, (c) => c.toUpperCase()) : lower
    })
    .join(' ')
    // A leading acronym leaves the sentence starting mid-word otherwise; nothing to capitalise.
    .trim()
}

// ── Conflicts ────────────────────────────────────────────────────────────────────────────
/**
 * Ported from `ads-console/automation/AutomationHub.tsx:131-146`, which is the one piece of
 * logic on that page that works and that nothing else in the app has. Unchanged in behaviour:
 * ENABLED rules only, same trigger, compatible market, then exact-duplicate or opposing-action.
 *
 * `sameScope` treats a null marketplace as "everywhere", so an account-wide rule can conflict
 * with a market-scoped one. That is correct and is why it is not an equality test.
 */
const OPPOSED: Array<[string, string]> = [
  ['bid_up', 'bid_down'],
  ['pause_campaign', 'resume_campaign'],
  ['pause_campaign', 'enable_campaign'],
  ['pause_all_campaigns', 'resume_campaign'],
  ['pause_all_campaigns', 'enable_campaign'],
  ['pause_ad_group', 'resume_campaign'],
  ['lower_bid_to_floor', 'bid_up'],
  ['lower_bid_to_floor', 'raise_bids_for_rank_defense'],
]

export interface ConflictInput {
  id: string
  name: string
  trigger: string
  level: string
  marketplace: string | null
  actions?: unknown
  actionTypes?: string[]
  conditions?: unknown
}

export function detectConflicts(rules: ConflictInput[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const add = (id: string, reason: string) => {
    const a = map.get(id) ?? []
    if (!a.includes(reason)) a.push(reason)
    map.set(id, a)
  }
  const typesOf = (r: ConflictInput) =>
    new Set(r.actionTypes ?? (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean))
  const sameScope = (a: ConflictInput, b: ConflictInput) => !a.marketplace || !b.marketplace || a.marketplace === b.marketplace
  // Only rules that can actually run can fight. An OFF rule is a plan, not a participant.
  const live = rules.filter((r) => r.level !== 'OFF')
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]; const b = live[j]
      if (a.trigger !== b.trigger || !sameScope(a, b)) continue
      if (JSON.stringify(a.actions) === JSON.stringify(b.actions) && JSON.stringify(a.conditions) === JSON.stringify(b.conditions)) {
        add(a.id, `Duplicate of “${b.name}”`)
        add(b.id, `Duplicate of “${a.name}”`)
        continue
      }
      const sa = typesOf(a); const sb = typesOf(b)
      for (const [x, y] of OPPOSED) {
        if ((sa.has(x) && sb.has(y)) || (sa.has(y) && sb.has(x))) {
          add(a.id, `May fight “${b.name}” on ${triggerText(a.trigger)}`)
          add(b.id, `May fight “${a.name}” on ${triggerText(a.trigger)}`)
        }
      }
    }
  }
  return map
}
