/**
 * BUD.1 — the shape `GET /advertising/budget-grid` returns.
 *
 * Mirrors `apps/api/src/services/advertising/budget-grid.service.ts`. Its own file rather than
 * inlined in the client, so the slot contract can import it without importing the client, and so a
 * later section can widen a row type in one place.
 *
 * 🔴 **Every money field on this page is named `…Cents` and is an integer, and that is load-bearing
 * rather than tidy.** `AdvertisingActionLog.payloadBefore/payloadAfter` store the daily budget in
 * EUROS as a plain number — `{"dailyBudget": 4.42}` — while `monthlyBudgetCents`, `costMicros`,
 * `sales7dCents` and `targetDailyCents` on neighbouring models are all minor units. The server
 * converts once, at one boundary; nothing below ever holds a bare euro. Assuming cents on that one
 * field produced a "12,000% of budget" reading in the study that looked entirely plausible.
 */

export type BudView = 'campaigns' | 'rules'
export type BudLevel = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'
export type BudState = 'at-floor' | 'cuttable' | 'gate-denied' | 'moved-24h' | 'only-cuts' | 'unreachable'

export const BUD_STATES: readonly BudState[] = ['at-floor', 'cuttable', 'gate-denied', 'moved-24h', 'only-cuts', 'unreachable'] as const

/** Amazon's hard minimum daily budget, and the handler's floor. Where every trim becomes a no-op. */
export const BUDGET_FLOOR_CENTS = 100

/** What each chip claims, in the operator's words. Used for the filter control and its tooltip. */
export const STATE_LABEL: Record<BudState, { label: string; hint: string }> = {
  'at-floor': {
    label: 'At the €1 floor',
    hint: 'Sitting at or below Amazon’s €1 minimum daily budget. A −15% or −20% trim computes a new value of €1 and changes nothing, which is why the same write repeats without ever converging.',
  },
  cuttable: {
    label: 'A trim can still cut it',
    hint: 'Above €1, so a trim rule would compute a genuinely lower number and write it to the local budget.',
  },
  'gate-denied': {
    label: 'Cut locally, blocked at Amazon',
    hint: 'Above €1 with the live-write allowlist closed. The cut still happens to the local budget and still writes an audit row — the gate only stops it being dispatched, so the two values diverge rather than the campaign being protected.',
  },
  'moved-24h': {
    label: 'Moved in the last 24h',
    hint: 'At least one AD_BUDGET_UPDATE row in the last 24 hours, by any writer.',
  },
  'only-cuts': {
    label: 'Net lower over 7 days',
    hint: 'Today’s budget is below the oldest audited value in the window. Measured end-to-end rather than by summing deltas: 39% of consecutive audit rows do not chain.',
  },
  unreachable: {
    label: 'No rule can reach it',
    hint: 'No budget rule’s scope covers this campaign. All six rules are account-wide today, so this is currently empty — it stops being empty the moment a rule is scoped.',
  },
}

export const LEVEL_LABEL: Record<BudLevel, { label: string; hint: string }> = {
  OFF: { label: 'Off', hint: 'Does not evaluate. `enabled` is false, whatever the autonomy dial stores.' },
  OBSERVE: { label: 'Observe', hint: 'Evaluates and records what it would do. No proposal, no write.' },
  PROPOSE: { label: 'Propose', hint: 'Queues a suggestion for approval. Nothing reaches a budget until you accept.' },
  AUTO: { label: 'Auto', hint: 'Changes budgets on its own, every time it matches.' },
}

export interface BudCampaignRow {
  id: string
  name: string
  market: string
  status: string
  dailyBudgetCents: number
  currency: string
  /** BUD.2 — the anchor relative budget rules compute from; null = not captured. */
  budgetBaselineCents: number | null
  /** BUD.2 — gate-enforced bounds; null = unbounded. */
  minBudgetCents: number | null
  maxBudgetCents: number | null
  atFloor: boolean
  /** `Campaign.liveBidWritesEnabled` — gates DISPATCH to Amazon, NOT the local cut. */
  gateOpen: boolean
  measured: boolean
  spend7dCents: number
  sales7dCents: number
  spendPerDayCents: number
  /** 🔴 a 7-day AVERAGE daily spend ÷ today's budget. Never call this "budget-capped". */
  utilization7d: number | null
  lastMovedAt: string | null
  lastMovedFromCents: number | null
  lastMovedToCents: number | null
  lastMovedBy: string | null
  lastMovedByKind: 'rule' | 'pacer' | 'user' | null
  /** whether the newest write reached Amazon; null when there is no queue row to ask */
  lastMovedDelivered: boolean | null
  delta24hCents: number
  delta24hPct: number | null
  delta7dCents: number
  delta7dPct: number | null
  writes24h: number
  writes7d: number
  reachedByRuleIds: string[]
}

export interface BudRuleRow {
  id: string
  name: string
  enabled: boolean
  /** 🔴 `resolveAutonomy(rule)`, not `dryRun` — which is a dead field. */
  level: BudLevel
  acts: boolean
  trigger: string
  percent: number | null
  actionTypes: string[]
  conditionsText: string
  scopeText: string
  maxExecutionsPerDay: number | null
  maxValueCentsEur: number | null
  /** executions in the window. An execution row exists BECAUSE the rule matched. */
  executions7d: number
  succeeded7d: number
  dryRun7d: number
  wrote7d: number
  /** DAILY_CAP_EXCEEDED — a refusal, never a failure */
  refused7d: number
  failed7d: number
  evaluationsLifetime: number
  matchesLifetime: number
  lastActedAt: string | null
  canStillMove: number
  alreadyAtFloor: number
}

export interface BudFacet { value: string; count: number }

/**
 * 🔴 View-shaped, and `Campaign.updatedAt` is deliberately absent — see the service header. The two
 * views carry different keys, which is safe only because the payload's cursor and the poll's cursor
 * are built by the same server function from the same `view`.
 */
export interface BudCursor {
  view: BudView
  budgetCents?: number
  n?: number
  loggedAt?: string | null
  execAt?: string | null
  execN?: number
}

export interface BudCensus {
  campaigns: number
  totalBudgetCents: number
  atFloor: number
  /** above the floor — what a trim can still CUT, which is where the cut actually lands */
  cuttable: number
  /** of `cuttable`, how many would also reach Amazon */
  reachesAmazon: number
  gateDenied: number
  moved24h: number
  moved24hByPacer: number
  moved24hByRule: number
  moved24hByUser: number
  rules: number
  rulesActing: number
  rulesCutOnly: number
}

export interface BudGridPayload {
  scope: {
    market: string
    campaigns: number | null
    total: number
    applied: string[]
    notes: string[]
    contradiction: string | null
  }
  view: BudView
  window: { days: number; since: string }
  census: BudCensus
  facets: { market: BudFacet[]; state: BudFacet[] }
  rows: BudCampaignRow[] | BudRuleRow[]
  total: number
  truncated: boolean
  cursor: BudCursor
  freshness: {
    newestBudgetLogAt: string | null
    newestExecutionAt: string | null
    newestPerfDate: string | null
  }
}
