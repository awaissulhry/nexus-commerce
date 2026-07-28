/**
 * AX-ZD.2 — Amazon Marketing Stream dataset taxonomy and routing.
 *
 * The stream was subscribed to the six PERFORMANCE datasets only, and
 * `ams-sqs-poll.job.ts` handed every record to `ingestMarketingStream` with a
 * blanket SKIP for anything lacking `traffic`/`conversion` in its id. So the
 * three families arrived down one pipe and two of them were discarded.
 *
 * They are genuinely different things and must be routed apart:
 *
 *   PERFORMANCE  sp/sb/sd-traffic, sp/sb/sd-conversion
 *                Hourly ROLLUPS delivered 1–3h late. Metrics ingest.
 *
 *   CHANGE       campaigns, adgroups, ads, targets
 *                Near-real-time state/budget/bid/name events. **This is the
 *                only push signal that someone edited in Seller Central** —
 *                without it the system cannot tell an external edit from a
 *                write of ours that has not landed. Drives observed-state and
 *                drift, never metrics.
 *
 *   BUDGET       budget-usage
 *                Event-driven at every 5% consumption increment. Drives pacing.
 *
 * HONESTY ABOUT LATENCY. Only CHANGE and BUDGET are event-driven. The
 * performance datasets are hourly batch delivered up to ~4h behind, and calling
 * that "real-time" in the UI is the kind of claim that costs trust the first
 * time an operator checks. `isRealTime` exists so a surface can label them
 * differently rather than lumping them together.
 *
 * Pure: no I/O. Unit-tested.
 */

export type AmsFamily = 'PERFORMANCE' | 'CHANGE' | 'BUDGET' | 'UNKNOWN'

/** Hourly rollups: impressions/clicks/cost, and attributed sales/orders. */
export const AMS_PERFORMANCE_DATASETS = [
  'sp-traffic', 'sp-conversion',
  'sd-traffic', 'sd-conversion',
  'sb-traffic', 'sb-conversion',
] as const

/**
 * Entity change streams. GA since 2025-12-01 and schema-aligned with Amazon's
 * unified Campaign Management API.
 */
export const AMS_CHANGE_DATASETS = ['campaigns', 'adgroups', 'ads', 'targets'] as const

/** Consumption events at each 5% increment. */
export const AMS_BUDGET_DATASETS = ['budget-usage'] as const

export const AMS_ALL_DATASETS = [
  ...AMS_PERFORMANCE_DATASETS,
  ...AMS_CHANGE_DATASETS,
  ...AMS_BUDGET_DATASETS,
] as const
export type AmsDatasetId = (typeof AMS_ALL_DATASETS)[number]

const PERF = new Set<string>(AMS_PERFORMANCE_DATASETS)
const CHANGE = new Set<string>(AMS_CHANGE_DATASETS)
const BUDGET = new Set<string>(AMS_BUDGET_DATASETS)

export function familyOf(datasetId: string | null | undefined): AmsFamily {
  if (!datasetId) return 'UNKNOWN'
  const d = datasetId.trim().toLowerCase()
  if (PERF.has(d)) return 'PERFORMANCE'
  if (CHANGE.has(d)) return 'CHANGE'
  if (BUDGET.has(d)) return 'BUDGET'
  // Tolerate a suffixed/prefixed variant rather than silently dropping it —
  // an unrecognised dataset should be visible, not invisible.
  if (d.includes('traffic') || d.includes('conversion')) return 'PERFORMANCE'
  return 'UNKNOWN'
}

/**
 * True only for datasets Amazon actually pushes on the event.
 * The performance datasets are hourly batch — do not label them real-time.
 */
export function isRealTime(datasetId: string | null | undefined): boolean {
  const f = familyOf(datasetId)
  return f === 'CHANGE' || f === 'BUDGET'
}

/** Worst-case staleness we should advertise for a family, in hours. */
export function maxLatencyHours(datasetId: string | null | undefined): number | null {
  switch (familyOf(datasetId)) {
    case 'CHANGE': return 0
    case 'BUDGET': return 0
    case 'PERFORMANCE': return 4 // hourly rollup + 1–3h delivery
    default: return null
  }
}

export function adProductOf(datasetId: string | null | undefined): 'SPONSORED_PRODUCTS' | 'SPONSORED_BRANDS' | 'SPONSORED_DISPLAY' | null {
  const d = (datasetId ?? '').toLowerCase()
  if (d.startsWith('sp-')) return 'SPONSORED_PRODUCTS'
  if (d.startsWith('sb-')) return 'SPONSORED_BRANDS'
  if (d.startsWith('sd-')) return 'SPONSORED_DISPLAY'
  return null
}

// ── budget-usage ──────────────────────────────────────────────────────────

export interface BudgetUsageEvent {
  budgetUsagePercent: number
  campaignId?: string
  /** OUT_OF_BUDGET once consumption has crossed 100%. */
  exhausted: boolean
  /** Approaching exhaustion — the last actionable bucket. */
  warning: boolean
}

/**
 * Interpret a budget-usage record.
 *
 * It is a PERCENTAGE stream at 5% increments, not an out-of-budget boolean, so
 * the exact instant of exhaustion is unobservable — only the crossing of the
 * last bucket is. Treating ≥100 as exhausted and ≥95 as a warning is therefore
 * the most precise reading available, and the imprecision is inherent to the
 * feed rather than to this code.
 */
export function readBudgetUsage(rec: Record<string, unknown>): BudgetUsageEvent | null {
  const raw = rec.budgetUsagePercent ?? rec.budget_usage_percent ?? rec.usagePercent
  const pct = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(pct)) return null
  const campaignId = typeof rec.campaignId === 'string' ? rec.campaignId
    : typeof rec.campaign_id === 'string' ? rec.campaign_id
      : undefined
  return {
    budgetUsagePercent: pct,
    campaignId,
    exhausted: pct >= 100,
    warning: pct >= 95 && pct < 100,
  }
}

// ── change events ─────────────────────────────────────────────────────────

export interface EntityChangeEvent {
  datasetId: string
  entityType: 'CAMPAIGN' | 'AD_GROUP' | 'AD' | 'TARGET'
  externalId: string
  /** Fields Amazon reports as changed, normalised to our vocabulary. */
  changes: Record<string, unknown>
  occurredAt: Date | null
}

const ENTITY_BY_DATASET: Record<string, EntityChangeEvent['entityType']> = {
  campaigns: 'CAMPAIGN', adgroups: 'AD_GROUP', ads: 'AD', targets: 'TARGET',
}

const ID_KEYS: Record<EntityChangeEvent['entityType'], string[]> = {
  CAMPAIGN: ['campaignId', 'campaign_id'],
  AD_GROUP: ['adGroupId', 'ad_group_id'],
  AD: ['adId', 'ad_id'],
  TARGET: ['targetId', 'target_id', 'keywordId', 'keyword_id'],
}

/** Fields worth reconciling. Anything else is noise for drift purposes. */
const TRACKED_FIELDS = ['state', 'budget', 'dailyBudget', 'bid', 'name', 'status', 'defaultBid']

export function readEntityChange(datasetId: string, rec: Record<string, unknown>): EntityChangeEvent | null {
  const entityType = ENTITY_BY_DATASET[datasetId.trim().toLowerCase()]
  if (!entityType) return null

  let externalId = ''
  for (const k of ID_KEYS[entityType]) {
    const v = rec[k]
    if (typeof v === 'string' && v) { externalId = v; break }
    if (typeof v === 'number') { externalId = String(v); break }
  }
  if (!externalId) return null

  const changes: Record<string, unknown> = {}
  for (const f of TRACKED_FIELDS) {
    if (rec[f] !== undefined) changes[f] = rec[f]
  }

  const tsRaw = rec.time_window_start ?? rec.timestamp ?? rec.publishedAt
  const occurredAt = typeof tsRaw === 'string' || typeof tsRaw === 'number'
    ? (Number.isNaN(new Date(tsRaw).getTime()) ? null : new Date(tsRaw))
    : null

  return { datasetId, entityType, externalId, changes, occurredAt }
}

/** Split a mixed batch by family, so each can go to its own consumer. */
export function routeRecords(records: Array<Record<string, unknown>>): {
  performance: Array<Record<string, unknown>>
  change: Array<Record<string, unknown>>
  budget: Array<Record<string, unknown>>
  unknown: Array<Record<string, unknown>>
} {
  const out = {
    performance: [] as Array<Record<string, unknown>>,
    change: [] as Array<Record<string, unknown>>,
    budget: [] as Array<Record<string, unknown>>,
    unknown: [] as Array<Record<string, unknown>>,
  }
  for (const r of records) {
    const ds = (r.dataset_id ?? r.datasetId) as string | undefined
    switch (familyOf(ds)) {
      case 'PERFORMANCE': out.performance.push(r); break
      case 'CHANGE': out.change.push(r); break
      case 'BUDGET': out.budget.push(r); break
      default: out.unknown.push(r)
    }
  }
  return out
}
