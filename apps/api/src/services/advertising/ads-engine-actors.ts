/**
 * Group 1 (1b) — ONE map from an ads engine to the actor strings its writes carry in
 * `AdvertisingActionLog.userId`, and each engine's default write caps.
 *
 * It replaces two copies of the same pairs (`ads-actors.service.ts` and the evidence map in
 * `ads-control-room-detail.service.ts`), which had already drifted from the code: neither knew
 * `automation:rank-plan-<id>` (rank-defend's product plans) or `automation:budget-manager`
 * (enforcement started by hand). The anomaly breaker counts engine writes through this map too.
 *
 * Each entry is checked against the code that writes it:
 *   rank-defend       `automation:rank-defend-<scheduleId>`, `automation:rank-plan-<planId>`   jobs/ad-rank-defend.job.ts
 *   dayparting        `automation:dayparting-<scheduleId>`                                  jobs/ad-dayparting.job.ts
 *                     (NOT `-disable` / `-delete`: one-shots when a person turns a schedule off — ads-schedule.service.ts,
 *                     routes/advertising.routes.ts)
 *   budget schedules  `automation:budget-schedule-<scheduleId>`                             jobs/ad-budget-schedule.job.ts
 *   enforcement       `automation:budget-manager-cron` (cron), `automation:budget-manager` (no actor given)
 *                                                                                          ads-budget-enforce.service.ts
 *   pools             `automation:budget-pool-rebalance`                                    budget-pool-rebalancer.service.ts
 *   auto-bid          `automation:auto-bid`                                                 ads-auto-bid.service.ts
 *   ToS               `automation:tos-optimizer`                                            ads-top-of-search.service.ts
 *   coverage          `automation:coverage-engine`                                          ads-coverage-engine.service.ts
 *   autopilot         `automation:autopilot-<planId>`, `automation:autopilot` (its ToS step) autopilot/apply.ts
 *   write reconcile   `automation:reconcile` (bids), `automation:ads-write-reconcile` (placements)
 *                                                                                          ads-write-reconcile.service.ts
 *   bid brain         `automation:bid-brain`                                                bid-brain/live-writer.ts
 *
 * Rules are not here: a rule writes as `automation:<ruleId>` and keeps its own brakes (its caps and the
 * breaker's rule-action signal).
 */
import { logger } from '../../utils/logger.js'

export type EngineKey =
  | 'rank-defend' | 'dayparting' | 'budget-schedules' | 'budget-enforce' | 'budget-pools'
  | 'auto-bid' | 'tos-defense' | 'coverage-engine' | 'autopilot' | 'write-reconcile'
  // BID BRAIN BB-6 — the one writer of the campaigns enrolled LIVE (bid-brain/live.ts).
  | 'bid-brain'

/** The breaker's buckets: every engine, plus writes no engine or rule claims. */
export type BreakerBucket = EngineKey | 'unknown'

interface EngineActorDef {
  key: EngineKey
  /** Plain name, as the Control Room shows it. */
  label: string
  /** Exact actor strings. */
  actors?: readonly string[]
  /** Actor prefixes (a schedule or plan id follows). */
  prefixes?: readonly string[]
  /** Exact strings that share a prefix but are not this engine's work. */
  exclude?: readonly string[]
}

/** Keys match the Control Room's Levers rows where the engine has one. */
export const ENGINE_ACTORS: readonly EngineActorDef[] = [
  // 7d — the engine's screen name since 2e/7a ("Hourly bid plans", as the Control Room lever); key and actors unchanged.
  { key: 'rank-defend', label: 'Hourly bid plans', prefixes: ['automation:rank-defend-', 'automation:rank-plan-'] },
  {
    key: 'dayparting', label: 'Classic dayparting', prefixes: ['automation:dayparting-'],
    exclude: ['automation:dayparting-disable', 'automation:dayparting-delete'],
  },
  { key: 'budget-schedules', label: 'Budget schedules', prefixes: ['automation:budget-schedule-'] },
  { key: 'budget-enforce', label: 'Budget enforcement', actors: ['automation:budget-manager-cron', 'automation:budget-manager'] },
  { key: 'budget-pools', label: 'Budget pools', actors: ['automation:budget-pool-rebalance'] },
  { key: 'auto-bid', label: 'Bid optimiser', actors: ['automation:auto-bid'] },
  { key: 'tos-defense', label: 'Top-of-Search defense', actors: ['automation:tos-optimizer'] },
  { key: 'coverage-engine', label: 'Coverage engine', actors: ['automation:coverage-engine'] },
  { key: 'autopilot', label: 'Autopilot', actors: ['automation:autopilot'], prefixes: ['automation:autopilot-'] },
  { key: 'write-reconcile', label: 'Retry of failed changes', actors: ['automation:reconcile', 'automation:ads-write-reconcile'] },
  { key: 'bid-brain', label: 'Bid brain', actors: ['automation:bid-brain'] },
]

/**
 * One-shot actions a person starts by hand. They carry an automation actor for the history, but no engine runs
 * them, so the breaker never counts them: a person's own bulk resync must not halt the account.
 */
export const PERSON_STARTED_ACTORS: readonly string[] = [
  'automation:dayparting-disable', // a person disabled a dayparting schedule (ads-schedule.service.ts)
  'automation:dayparting-delete', // a person deleted one (routes/advertising.routes.ts)
  'automation:resync-bids', // the one-time "resync bids" route (routes/advertising.routes.ts)
  'automation:ax35-replication-raise', // raise a blueprint run to its planned bids (ads-blueprint-apply.service.ts)
  'automation:ax25-blueprint-rollback', // roll a blueprint run back (ads-blueprint-apply.service.ts)
]

/**
 * Log rows that record something other than a change: a would-do, a verification receipt, a note. The breaker
 * counts changes, so these are left out (the coverage engine in observe mode logs one row per term it would move).
 */
export const NON_CHANGE_ACTION_TYPES: readonly string[] = [
  'coverage_engine_observe', 'launch_verification', 'reconcile_verification', 'custom_event',
]

const BY_KEY = new Map(ENGINE_ACTORS.map((d) => [d.key, d]))

export function engineLabel(key: BreakerBucket): string {
  return key === 'unknown' ? 'Changes with no known author' : BY_KEY.get(key)!.label
}

/** The engine whose write this actor string is, or null. */
export function engineForActor(userId: string | null | undefined): EngineKey | null {
  if (!userId) return null
  for (const d of ENGINE_ACTORS) {
    if (d.exclude?.includes(userId)) continue
    if (d.actors?.includes(userId)) return d.key
    if (d.prefixes?.some((p) => userId.startsWith(p))) return d.key
  }
  return null
}

/** A Prisma `where` fragment that selects one engine's action-log rows. */
export function engineActorWhere(key: EngineKey): {
  OR: Array<{ userId: { startsWith: string } } | { userId: { in: string[] } }>
  NOT?: { userId: { in: string[] } }
} {
  const d = BY_KEY.get(key)!
  const OR: Array<{ userId: { startsWith: string } } | { userId: { in: string[] } }> = [
    ...(d.prefixes ?? []).map((p) => ({ userId: { startsWith: p } })),
    ...(d.actors?.length ? [{ userId: { in: [...d.actors] } }] : []),
  ]
  return d.exclude?.length ? { OR, NOT: { userId: { in: [...d.exclude] } } } : { OR }
}

export type ActorClass =
  | { kind: 'engine'; engine: EngineKey }
  /** A person, or a one-shot a person started by hand. */
  | { kind: 'person' }
  /** `automation:<id>` / `automation:rule-<id>` that no engine claims: a rule if that id is one, else unknown. */
  | { kind: 'rule-candidate'; ruleId: string }
  | { kind: 'unknown' }

/**
 * Who wrote this row, for the breaker.
 *
 * Every automation write is typed `automation:<…>` (`AdsActor`). No actor at all (null, or `system`, the placement
 * writer's fallback when its caller gave none) is unknown. Any other string came from a person's path (`user:<id>`,
 * or an older caller that passed a bare user id).
 */
export function classifyActor(userId: string | null | undefined): ActorClass {
  if (!userId || userId === 'system') return { kind: 'unknown' }
  const engine = engineForActor(userId)
  if (engine) return { kind: 'engine', engine }
  if (PERSON_STARTED_ACTORS.includes(userId)) return { kind: 'person' }
  if (userId.startsWith('automation:')) {
    const rest = userId.slice('automation:'.length)
    const ruleId = rest.startsWith('rule-') ? rest.slice('rule-'.length) : rest
    return ruleId ? { kind: 'rule-candidate', ruleId } : { kind: 'unknown' }
  }
  return { kind: 'person' }
}

/**
 * Bucket action-log counts per engine. Rule writes and people are left out; an `automation:<id>` whose id is not
 * in `ruleIds` (no engine, no rule) counts as unknown.
 */
export function countWritesByEngine(
  groups: ReadonlyArray<{ userId: string | null; count: number }>,
  ruleIds: ReadonlySet<string>,
): Record<BreakerBucket, number> {
  const out = Object.fromEntries([...ENGINE_ACTORS.map((d) => [d.key, 0]), ['unknown', 0]]) as Record<BreakerBucket, number>
  for (const g of groups) {
    const c = classifyActor(g.userId)
    if (c.kind === 'engine') out[c.engine] += g.count
    else if (c.kind === 'unknown') out.unknown += g.count
    else if (c.kind === 'rule-candidate' && !ruleIds.has(c.ruleId)) out.unknown += g.count
  }
  return out
}

// ── Caps ─────────────────────────────────────────────────────────────────────────────

export interface EngineCaps {
  /** Most changes one run may make; null = no per-run cap from this table. */
  perTick: number | null
  /** Most changes in one UTC day; null = no daily cap from this table. */
  perDay: number | null
  /** The anomaly breaker stops the account when the engine passes this many changes in the last 60 minutes. */
  breakerPerHour: number
}

/**
 * Code defaults (Owner decision S3); `NEXUS_ADS_ENGINE_CAPS` overrides any field as JSON, e.g.
 * `{"rank-defend":{"breakerPerHour":1500}}`.
 *
 * Measured peaks behind the numbers: rank-defend's largest tick is 514 changes (the morning restore), about
 * 1,320–1,460 a day. The write reconcile has no per-run cap here because it caps itself (50 per entity type per
 * sweep); it rides the 15-minute rank tick, so it can reach 3 × 50 × 4 = 600 an hour, and its breaker sits there.
 * Changes with no known author get 300 an hour: no engine writes that way today, and a runaway that nobody
 * attributed must still be caught.
 */
const DEFAULT_ENGINE_CAPS: Readonly<Record<BreakerBucket, Readonly<EngineCaps>>> = {
  'rank-defend': { perTick: 600, perDay: 3_000, breakerPerHour: 1_200 },
  dayparting: { perTick: 300, perDay: 1_500, breakerPerHour: 600 },
  'budget-schedules': { perTick: 100, perDay: 400, breakerPerHour: 200 },
  'budget-enforce': { perTick: 100, perDay: 400, breakerPerHour: 200 },
  'budget-pools': { perTick: 50, perDay: 300, breakerPerHour: 100 },
  'tos-defense': { perTick: 50, perDay: 300, breakerPerHour: 100 },
  'coverage-engine': { perTick: 100, perDay: 300, breakerPerHour: 200 },
  autopilot: { perTick: 150, perDay: 600, breakerPerHour: 300 },
  'auto-bid': { perTick: 300, perDay: 1_200, breakerPerHour: 600 },
  'write-reconcile': { perTick: null, perDay: null, breakerPerHour: 600 },
  // BB-6 — the bid brain moves a keyword at most once per new data day, plus the hour's placements and Min-bid floors of
  // its campaigns (BB-7): auto-bid's caps for its bids, and room for the hourly placement writes.
  'bid-brain': { perTick: 300, perDay: 1_500, breakerPerHour: 600 },
  unknown: { perTick: null, perDay: null, breakerPerHour: 300 },
}

export const ENGINE_CAPS_ENV = 'NEXUS_ADS_ENGINE_CAPS'

const CAP_FIELDS = ['perTick', 'perDay', 'breakerPerHour'] as const

/**
 * Parse the env override. Never throws and never removes a cap: a value that is not a whole number of at least 1
 * keeps the default for that field, and each problem is reported.
 */
export function parseEngineCaps(raw: string | undefined): { caps: Record<BreakerBucket, EngineCaps>; problems: string[] } {
  const caps = Object.fromEntries(
    Object.entries(DEFAULT_ENGINE_CAPS).map(([k, v]) => [k, { ...v }]),
  ) as Record<BreakerBucket, EngineCaps>
  const problems: string[] = []
  if (raw == null || raw.trim() === '') return { caps, problems }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { caps, problems: ['not valid JSON'] } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { caps, problems: ['not a JSON object'] }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in caps)) { problems.push(`unknown engine "${key}"`); continue }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${key}: not an object`); continue }
    for (const [field, n] of Object.entries(value as Record<string, unknown>)) {
      if (!(CAP_FIELDS as readonly string[]).includes(field)) { problems.push(`${key}.${field}: unknown field`); continue }
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) { problems.push(`${key}.${field}: must be a whole number of at least 1`); continue }
      caps[key as BreakerBucket][field as (typeof CAP_FIELDS)[number]] = n
    }
  }
  return { caps, problems }
}

let resolved: { raw: string | undefined; caps: Record<BreakerBucket, EngineCaps> } | null = null

/** Defaults + the env override, re-read only when the env value changes (so a bad value logs once). */
function currentCaps(): Record<BreakerBucket, EngineCaps> {
  const raw = process.env[ENGINE_CAPS_ENV]
  if (resolved && resolved.raw === raw) return resolved.caps
  const { caps, problems } = parseEngineCaps(raw)
  if (problems.length) logger.warn(`[ads-engine-actors] ${ENGINE_CAPS_ENV}: defaults kept where it is wrong`, { problems })
  resolved = { raw, caps }
  return caps
}

/** One engine's caps (a copy). */
export function engineCaps(key: BreakerBucket): EngineCaps {
  return { ...currentCaps()[key] }
}

/** Every bucket's hourly breaker limit. */
export function breakerLimits(): Record<BreakerBucket, number> {
  const caps = currentCaps()
  return Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.breakerPerHour])) as Record<BreakerBucket, number>
}

/** The hourly limits in words, for the screens: "Hourly bid plans 1,200 · … · changes with no known author 300". */
export function breakerLimitsText(): string {
  const limits = breakerLimits()
  return (Object.keys(limits) as BreakerBucket[])
    .map((k) => `${k === 'unknown' ? 'changes with no known author' : engineLabel(k)} ${limits[k].toLocaleString('en-GB')}`)
    .join(' · ')
}
