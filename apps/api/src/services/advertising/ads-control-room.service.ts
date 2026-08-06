/**
 * ACR.1.2 — the Levers view: every automation that can change this account, in one list.
 *
 * The autonomy board it replaces listed `AutomationRule` rows only. That is a minority of
 * what actually moves money here: rank-defend applied 5,311 mutations in 90 days and never
 * appeared on it, and neither did dayparting, budget enforcement, pool rebalancing or the
 * anomaly breaker. An operator reading that board saw a handful of dials and reasonably
 * concluded the machine was small; the machine was not small, it was mostly off-screen.
 *
 * So this service describes the ENGINES — the crons and services with their own gates and
 * their own governed sets — and the route joins them to the rules that already had a board.
 * One list, one vocabulary, no second place to look.
 *
 * Read-only. It reports posture; it never changes it.
 */
import prisma from '../../db.js'
import { envEnabled } from '../../utils/env-flag.js'
import { getAutomationState } from './ads-automation-state.service.js'

/**
 * Engines are gated by env flags and apply-switches, not by `AutomationRule.autonomyLevel`.
 * They are mapped onto the SAME four words the rules use, because an operator should not
 * have to hold two vocabularies to answer "what is allowed to act tonight".
 *
 *   OFF      — gated off; does not run at all
 *   OBSERVE  — runs and computes, but is structurally incapable of writing (dry-run flag off)
 *   PROPOSE  — runs and writes suggestions for approval
 *   AUTO     — runs and writes to Amazon
 */
export type LeverMode = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'

export interface EngineLever {
  key: string
  name: string
  /** One line an operator can act on, not a description of the code. */
  what: string
  mode: LeverMode
  /** Why it is in this mode — always populated, because "why can't I turn this on" needs an answer on-screen. */
  modeReason: string
  /** What it governs right now, e.g. "33 schedules". null when the concept does not apply. */
  scope: string | null
  cron: string | null
  schedule: string | null
  lastRunAt: Date | null
  lastRunStatus: string | null
  lastRunSummary: string | null
  /** Failure rate over the recent window — the signal that would have exposed the 693k-failure silence. */
  runs7d: number
  failures7d: number
  /** Set when something is wrong enough to belong on the exception board. */
  warning: string | null
  /**
   * Whether this engine actually consults the account halt / autonomy dial.
   *
   * Measured, not assumed: `ads-auto-bid` and `ads-auto-harvest` check
   * `state.effectivelyStopped`; `ad-rank-defend`, `ad-dayparting`, `ad-budget-enforce`,
   * `budget-pool-rebalance` and the delivery drain contain no such check at all.
   *
   * This distinction is the difference between a control surface and a decorative one. On
   * 2026-08-05 the breaker was tripped ("264 actions in the last hour") and rank-defend's
   * very next tick still reported `evaluated=33 applied=21`, budget enforcement still ran
   * `(LIVE)`, and the drain kept delivering. A page that painted those as OFF because the
   * account said "halted" would be lying in the most expensive possible direction.
   */
  haltBehaviour: HaltBehaviour
}

/**
 * How an engine relates to the account halt / autonomy dial.
 *
 *   honours  — reads `effectivelyStopped` itself and stands down before doing any work.
 *              Only `ads-auto-bid` and `ads-auto-harvest` do this.
 *   gated    — still evaluates while halted, but every write it produces is refused by
 *              `ads-write-gate` (ACR.0.7). Nothing reaches Amazon; the engine merely
 *              wastes a tick. This is the state rank-defend, dayparting, budget
 *              enforcement, pools and the delivery drain are in.
 *   exempt   — runs regardless, correctly: the anomaly breaker must keep evaluating
 *              (it is what would clear the halt) and the reconcile is read-only.
 *
 * Before ACR.0.7 the `gated` engines were UNGUARDED — measured on prod with the breaker
 * tripped, rank-defend's next tick still applied 21 bid changes and budget enforcement
 * ran LIVE. The distinction is kept rather than collapsed because "stands down" and
 * "runs but cannot land a write" are different operational facts, and an operator
 * debugging a quiet account needs to know which one they are looking at.
 */
export type HaltBehaviour = 'honours' | 'gated' | 'exempt'

const DAY = 86_400_000

/** Last run + 7-day health for a set of cron names, in one query each. */
async function cronFacts(names: string[]) {
  const since = new Date(Date.now() - 7 * DAY)
  const [last, grouped] = await Promise.all([
    prisma.cronRun.findMany({
      where: { jobName: { in: names } },
      orderBy: { startedAt: 'desc' },
      distinct: ['jobName'],
      select: { jobName: true, startedAt: true, status: true, outputSummary: true, errorMessage: true },
    }),
    prisma.cronRun.groupBy({
      by: ['jobName', 'status'],
      where: { jobName: { in: names }, startedAt: { gte: since } },
      _count: { _all: true },
    }),
  ])
  const lastBy = new Map(last.map((r) => [r.jobName, r]))
  const health = new Map<string, { runs: number; failures: number }>()
  for (const g of grouped) {
    const h = health.get(g.jobName) ?? { runs: 0, failures: 0 }
    h.runs += g._count._all
    if (g.status === 'FAILED') h.failures += g._count._all
    health.set(g.jobName, h)
  }
  return { lastBy, health }
}

/**
 * ACR.1.3 — the account-level bounds, in one read.
 *
 * These are the numbers that bind EVERY engine and rule, and until now each lived somewhere
 * different: two in a DB row, one in an env var, one implied by a column's default-deny, one
 * only countable by query. Setting the breaker threshold required running a script — which is
 * a strange thing to say about the control that stops the account.
 *
 * `effective` vs `set` is the important distinction. A null threshold is not "no limit", it is
 * "the code's default", and showing a blank field would read as unbounded. So both are
 * returned and the UI can say "250 (default)" rather than nothing.
 */
export interface AccountGuardrails {
  actionsPerHour: { effective: number; set: number | null; default: number }
  spendPerHourCents: { effective: number; set: number | null; default: number }
  /** Per-payload write ceiling, from env. Read-only here — it needs a deploy to change. */
  maxWriteValueCents: number
  /** Quartile's counted boundary of authority: what automation may touch at all. */
  campaigns: { total: number; managed: number; unmanaged: number }
  /** Entity bid bounds (ADX A1) — a column, so it cannot be bypassed by a future engine. */
  bounds: { withMinBid: number; withMaxBid: number }
  protectedTerms: number
  adsMode: string
  envKill: boolean
}

const DEFAULT_MAX_ACTIONS_PER_HOUR = 250
const DEFAULT_MAX_HOURLY_SPEND_CENTS = 50_000

export async function getAccountGuardrails(): Promise<AccountGuardrails> {
  const [state, total, managed, withMin, withMax, protectedTerms] = await Promise.all([
    getAutomationState(),
    prisma.campaign.count(),
    prisma.campaign.count({ where: { liveBidWritesEnabled: true } }),
    prisma.campaign.count({ where: { minBidCents: { not: null } } }),
    prisma.campaign.count({ where: { maxBidCents: { not: null } } }),
    prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } }).catch(() => 0),
  ])
  const { adsMode } = await import('./ads-api-client.js')
  return {
    actionsPerHour: {
      effective: state.maxActionsPerHour ?? DEFAULT_MAX_ACTIONS_PER_HOUR,
      set: state.maxActionsPerHour, default: DEFAULT_MAX_ACTIONS_PER_HOUR,
    },
    spendPerHourCents: {
      effective: state.maxHourlySpendCentsEur ?? DEFAULT_MAX_HOURLY_SPEND_CENTS,
      set: state.maxHourlySpendCentsEur, default: DEFAULT_MAX_HOURLY_SPEND_CENTS,
    },
    maxWriteValueCents: Number(process.env.NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS ?? 50_000),
    campaigns: { total, managed, unmanaged: total - managed },
    bounds: { withMinBid: withMin, withMaxBid: withMax },
    protectedTerms,
    adsMode: adsMode(),
    envKill: process.env.NEXUS_ADS_AUTOMATION_KILL === '1',
  }
}

export async function getEngineLevers(): Promise<{ levers: EngineLever[]; global: { autonomy: string; halted: boolean; degraded: boolean; envKill: boolean } }> {
  const CRONS = [
    'ad-rank-defend', 'ad-dayparting', 'ad-budget-enforce', 'budget-pool-rebalance',
    'ads-auto-bid', 'ads-auto-harvest', 'ads-anomaly-guard', 'top-of-search-defense',
    'tos-is-ingest', 'sqp-ingest', 'ads-structural-reconcile', 'drain-ads-sync',
    'ads-coverage-engine', 'fleet-sweep', 'fleet-council',
  ]

  const [state, facts, enabledSchedules, enabledPlans, budgetPlans, pools, allowlisted, totalCampaigns, coverageSets, enabledAnalysts] = await Promise.all([
    getAutomationState(),
    cronFacts(CRONS),
    prisma.adSchedule.count({ where: { enabled: true } }),
    prisma.productRankPlan.count({ where: { enabled: true } }),
    // AdBudgetPlan has no `enabled` — it is keyed by month, and the switches are
    // autoPacing/stopOverSpend. What governs spend TONIGHT is a plan for THIS month
    // with at least one switch on; counting every plan ever written would claim the
    // engine governs months that are already closed.
    prisma.adBudgetPlan.count({
      where: { month: new Date().toISOString().slice(0, 7), OR: [{ autoPacing: true }, { stopOverSpend: true }] },
    }).catch(() => 0),
    prisma.budgetPool.count().catch(() => 0),
    prisma.campaign.count({ where: { liveBidWritesEnabled: true } }),
    prisma.campaign.count(),
    prisma.keywordCoverageSet.count({ where: { enabled: true } }).catch(() => 0),
  ,
    prisma.agentCharter.count({ where: { enabled: true, tier: 'analyst', key: { not: 'fleet-selftest' } } })])

  const adsCron = envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON')
  const envKill = process.env.NEXUS_ADS_AUTOMATION_KILL === '1'

  /**
   * The account-wide dial is a CEILING over every lever, not a peer of them. SUGGEST forces
   * every rule to dry-run; OFF and the halt stop everything. Presenting a lever as AUTO while
   * the account dial says SUGGEST would be the single most misleading thing this page could do.
   */
  const accountStopped = envKill || state.halted || state.autonomy === 'OFF'
  const capped = (m: LeverMode, hb: HaltBehaviour): LeverMode => {
    // 'gated' engines cannot land a write while stopped (ACR.0.7), so their effective
    // mode is OFF exactly like an engine that stood down on its own.
    if (hb === 'exempt') return m
    if (accountStopped) return 'OFF'
    if (state.autonomy === 'SUGGEST' && m === 'AUTO') return 'PROPOSE'
    return m
  }
  const capReason = (): string | null => {
    if (envKill) return 'NEXUS_ADS_AUTOMATION_KILL is set — nothing runs until it is cleared'
    if (state.halted) return `Halted${state.haltReason ? `: ${state.haltReason}` : ''}`
    if (state.autonomy === 'OFF') return 'Account autonomy is OFF'
    if (state.autonomy === 'SUGGEST') return 'Account autonomy is SUGGEST — writes are demoted to proposals'
    return null
  }

  const mk = (
    key: string, name: string, what: string, cron: string | null,
    schedule: string | null, rawMode: LeverMode, rawReason: string,
    scope: string | null, haltBehaviour: HaltBehaviour,
  ): EngineLever => {
    const f = cron ? facts.lastBy.get(cron) : undefined
    const h = (cron ? facts.health.get(cron) : undefined) ?? { runs: 0, failures: 0 }
    const cap = capReason()
    const mode = capped(rawMode, haltBehaviour)
    // A gate that is already OFF is not "overridden" by the account dial — say the local reason.
    const modeReason = rawMode === 'OFF' ? rawReason : (haltBehaviour === 'exempt' ? rawReason : (cap ?? rawReason))

    let warning: string | null = null
    // The loudest thing this page can say: the account is stopped and this engine is not.
    if (accountStopped && haltBehaviour === 'gated' && rawMode !== 'OFF') {
      // Not a defect since ACR.0.7 — but worth saying, because the cron will keep
      // logging activity and an operator should not read that as writes landing.
      warning = 'Still evaluating while stopped — its writes are refused at the gate'
    } else if (cron && adsCron && h.runs === 0 && rawMode !== 'OFF') {
      warning = 'Enabled but has not run in 7 days'
    } else if (h.runs > 0 && h.failures / h.runs > 0.2) {
      warning = `${h.failures} of ${h.runs} runs failed in 7 days`
    }

    return {
      key, name, what, mode, modeReason, scope, cron, schedule,
      lastRunAt: f?.startedAt ?? null,
      lastRunStatus: f?.status ?? null,
      lastRunSummary: f?.outputSummary ?? f?.errorMessage ?? null,
      runs7d: h.runs, failures7d: h.failures, warning, haltBehaviour,
    }
  }

  const off = (why: string) => ({ mode: 'OFF' as LeverMode, why })
  const masterOff = !adsCron ? off('NEXUS_ENABLE_AMAZON_ADS_CRON is off — the whole ads fleet is dormant') : null

  const levers: EngineLever[] = [
    mk('rank-defend', 'Rank & Dayparting', 'Holds a target rank on a schedule by moving placement bids',
      'ad-rank-defend', 'every 15 min',
      masterOff ? 'OFF' : envEnabled('NEXUS_ENABLE_RANK_DEFEND') ? 'AUTO' : 'OFF',
      masterOff?.why ?? (envEnabled('NEXUS_ENABLE_RANK_DEFEND') ? 'Armed and writing to Amazon' : 'NEXUS_ENABLE_RANK_DEFEND is off'),
      `${enabledSchedules} schedules · ${enabledPlans} product plans`, 'gated'),

    mk('dayparting', 'Classic dayparting', 'Enables/pauses and multiplies bids on fixed hour windows',
      'ad-dayparting', 'every 15 min',
      masterOff ? 'OFF' : 'AUTO',
      masterOff?.why ?? 'Runs, but every live schedule is rank-goal mode — this evaluates almost nothing',
      null, 'gated'),

    mk('budget-enforce', 'Budget enforcement', 'Paces a monthly budget and suppresses over-spending campaigns',
      'ad-budget-enforce', 'every 30 min',
      masterOff ? 'OFF' : envEnabled('NEXUS_BUDGET_ENFORCE_APPLY') ? 'AUTO' : 'OBSERVE',
      masterOff?.why ?? (envEnabled('NEXUS_BUDGET_ENFORCE_APPLY')
        ? 'NEXUS_BUDGET_ENFORCE_APPLY is set — this one acts'
        : 'NEXUS_BUDGET_ENFORCE_APPLY is off — computes, never applies'),
      `${budgetPlans} plans active this month`, 'gated'),

    mk('budget-pools', 'Budget pools', 'Moves daily budget between campaigns inside a pool',
      'budget-pool-rebalance', 'every 15 min',
      masterOff ? 'OFF' : pools > 0 ? 'AUTO' : 'OFF',
      masterOff?.why ?? (pools > 0 ? 'Rebalancing live pools' : 'No pools configured — nothing to rebalance'),
      `${pools} pools`, 'gated'),

    mk('auto-bid', 'Bid optimiser', 'Moves target bids toward a target ACOS',
      'ads-auto-bid', 'every 6 h',
      masterOff ? 'OFF' : 'AUTO', masterOff?.why ?? 'Runs on the account autonomy dial', null, 'honours'),

    mk('auto-harvest', 'Harvest & negate', 'Promotes converting search terms and negates wasteful ones',
      'ads-auto-harvest', 'daily 06:30',
      masterOff ? 'OFF' : 'AUTO', masterOff?.why ?? 'Runs on the account autonomy dial', null, 'honours'),

    mk('anomaly-guard', 'Anomaly breaker', 'Halts all automation on an action or spend excursion',
      'ads-anomaly-guard', 'every 10 min',
      masterOff ? 'OFF' : 'AUTO',
      masterOff?.why ?? `Trips at ${state.maxActionsPerHour ?? 250} actions/h or €${((state.maxHourlySpendCentsEur ?? 50_000) / 100).toFixed(0)}/h`,
      null, 'exempt'),

    mk('tos-defense', 'Top-of-Search defense', 'Nudges the top-of-search multiplier toward a target impression share',
      'top-of-search-defense', 'every 30 min',
      envEnabled('NEXUS_ENABLE_TOS_DEFENSE_CRON') && adsCron ? 'AUTO' : 'OFF',
      envEnabled('NEXUS_ENABLE_TOS_DEFENSE_CRON')
        ? (masterOff?.why ?? 'Armed')
        : 'NEXUS_ENABLE_TOS_DEFENSE_CRON is off — the most direct SERP lever has never run',
      null, 'gated'),

    mk('write-delivery', 'Write delivery', 'Drains queued changes to Amazon and retries failures',
      'drain-ads-sync', 'every minute',
      masterOff ? 'OFF' : 'AUTO',
      masterOff?.why ?? 'The only path a change reaches Amazon by',
      `${allowlisted} of ${totalCampaigns} campaigns allowlisted`, 'gated'),

    mk('coverage-engine', 'Coverage engine', 'Holds each term of an enabled coverage set at its target share, inside its caps',
      'ads-coverage-engine', 'daily 07:10',
      masterOff ? 'OFF'
        : (process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'observe').toLowerCase() === 'auto' ? 'AUTO'
          : (process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'observe').toLowerCase() === 'off' ? 'OFF' : 'OBSERVE',
      masterOff?.why ?? ((process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'observe').toLowerCase() === 'auto'
        ? 'Writing — enabled coverage sets only, through the gate'
        : 'Observe-first: logs would-do bids; writes need NEXUS_COVERAGE_ENGINE_MODE=auto AND an enabled set'),
      `${coverageSets} enabled coverage sets`, 'gated'),

    mk('structural-reconcile', 'Account reconcile', 'Compares the whole account against Amazon and records disagreement',
      'ads-structural-reconcile', 'every 6 h',
      masterOff ? 'OFF' : 'OBSERVE',
      masterOff?.why ?? 'Read-only — records drift, never repairs bids',
      null, 'exempt'),

    // NAF.B — the analyst fleet's nightly sweep. Read-only (findings only,
    // no write path); honours ITS OWN halt (AgentFleetState + the AI kill
    // switch), not the ads write halt — hence 'exempt' here, per the
    // structural-reconcile precedent.
    mk('fleet-analysts', 'Analyst fleet (LLM)', 'Nightly LLM analysts read engine evidence and write findings — no writes to Amazon',
      'fleet-sweep', 'nightly 04:45 UTC',
      process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1' ? 'OFF'
        : enabledAnalysts > 0 ? 'OBSERVE' : 'OFF',
      process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1'
        ? 'NEXUS_ENABLE_FLEET_SWEEP_CRON is not set'
        : enabledAnalysts > 0
          ? `${enabledAnalysts} analyst charter(s) enabled — findings only, honours the fleet halt`
          : 'Sweep scheduled but every analyst charter is OFF (dark)',
      null, 'exempt'),
  ]

  return {
    levers,
    global: { autonomy: state.autonomy, halted: state.halted, degraded: state.degraded, envKill },
  }
}
